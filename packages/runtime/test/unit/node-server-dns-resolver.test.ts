import { describe, expect, it } from 'vitest';
import { createNodeServerDnsResolver } from '../../src/adapters/shared/node-server-dns-resolver.ts';
import type { NodeResolverLike } from '../../src/adapters/shared/node-server-dns-resolver.ts';
import type { NodeDnsModule } from '../../src/adapters/shared/node-dns-resolver.ts';
import { deferred, DnsTimers, flushDns } from '../fixtures/dns-fakes.ts';

function setup(timeoutMs = 101, overrides: Partial<NodeDnsModule> = {}) {
  const timers = new DnsTimers();
  const instances: { resolver: NodeResolverLike; servers: string[]; cancelled: number }[] = [];
  const settings: { timeout: number; tries: number }[] = [];
  const pending: { reject(error: unknown): void }[] = [];
  function query<T>(): Promise<T> {
    const gate = deferred<T>();
    pending.push(gate);
    return gate.promise;
  }
  const dns = createNodeServerDnsResolver(
    { servers: ['127.0.0.1', '127.0.0.2:5353', '[::1]:54'], timeoutMs },
    {
      ...timers,
      createResolver(opts) {
        settings.push(opts);
        const instance = {
          servers: [] as string[],
          cancelled: 0,
          resolver: null as unknown as NodeResolverLike,
        };
        const ownPendingStart = pending.length;
        instance.resolver = {
          setServers(servers) {
            instance.servers = servers;
          },
          cancel() {
            instance.cancelled++;
            for (const gate of pending.slice(ownPendingStart))
              gate.reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
          },
          resolveSrv: () => query(),
          resolve4: () => query(),
          resolve6: () => query(),
          ...overrides,
        };
        instances.push(instance);
        return instance.resolver;
      },
    },
  );
  return { dns, timers, instances, settings };
}

describe('chosen-server Node DNS', () => {
  it('rebuilds servers, splits with ceil, maps SRV, and clears its timer on success', async () => {
    const { dns, timers, instances, settings } = setup(101, {
      resolveSrv: () => Promise.resolve([{ name: 'ok.test', port: 8080, priority: 10, weight: 5 }]),
    });
    expect(await dns.resolveSrv('_svc')).toEqual([
      { host: 'ok.test', port: 8080, priority: 10, weight: 5 },
    ]);
    expect(settings).toEqual([{ tries: 1, timeout: 34 }]);
    expect(instances[0]!.servers).toEqual(['127.0.0.1', '127.0.0.2:5353', '[::1]:54']);
    expect(timers.pending.size).toBe(0);
    timers.history[0]!.callback();
    expect(instances[0]!.cancelled).toBe(0);
  });
  it('propagates SRV errors and clears timers', async () => {
    const { dns, timers } = setup(10, {
      resolveSrv: () => Promise.reject(new Error('missing')),
    });
    await expect(dns.resolveSrv('missing')).rejects.toThrow('missing');
    expect(timers.pending.size).toBe(0);
  });
  it('cancels with ETIMEOUT, swallowing cancellation rejections', async () => {
    const { dns, timers, instances } = setup();
    const pending = dns.resolveSrv('hang');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ETIMEOUT',
      message: 'DNS lookup for hang did not finish within 101 ms',
    });
    await flushDns();
    timers.fire(101);
    await assertion;
    await flushDns();
    expect(instances[0]!.cancelled).toBe(1);
    expect(timers.pending.size).toBe(0);
  });
  it('counts both pending families as timeout failures in order', async () => {
    const { dns, timers } = setup();
    const pending = dns.resolveHost('hang');
    const assertion = expect(pending).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    await flushDns();
    timers.fire(101);
    await assertion;
    expect(timers.pending.size).toBe(0);
  });
  it.each(['A', 'AAAA'])(
    'retains the %s answer when the other family is still pending',
    async (family) => {
      const { dns, timers } = setup(
        101,
        family === 'A'
          ? { resolve4: () => Promise.resolve(['10.0.0.1']) }
          : { resolve6: () => Promise.resolve(['::1']) },
      );
      const pending = dns.resolveHost('partial');
      await flushDns();
      timers.fire(101);
      expect(await pending).toEqual([family === 'A' ? '10.0.0.1' : '::1']);
      expect(timers.pending.size).toBe(0);
    },
  );
  it('settles a completion racing with the timer once and ignores late answers', async () => {
    const gate = deferred<string[]>();
    const { dns, timers } = setup(101, { resolve4: () => gate.promise });
    const pending = dns.resolveHost('race');
    const assertion = expect(pending).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    await flushDns();
    gate.resolve(['10.0.0.1']); // Its promise callback has not run when the bound fires.
    timers.fire(101);
    await assertion;
    await flushDns();
    expect(timers.pending.size).toBe(0);
  });
  it('creates one instance per call, so timing out one never cancels another', async () => {
    const answer = deferred<string[]>();
    const { dns, timers, instances } = setup(101, {
      resolve4: () => answer.promise,
      resolve6: () => Promise.resolve([]),
    });
    const first = dns.resolveSrv('hang');
    const rejected = expect(first).rejects.toMatchObject({ code: 'ETIMEOUT' });
    const second = dns.resolveHost('ok');
    await flushDns();
    timers.fire(101);
    await rejected;
    answer.resolve(['10.0.0.1']);
    expect(await second).toEqual(['10.0.0.1']);
    expect(instances.map((entry) => entry.cancelled)).toEqual([1, 0]);
    expect(timers.pending.size).toBe(0);
  });
  it('uses -1 and no own timer for zero; enforces a minimum share of 1', async () => {
    const zero = setup(0, {
      resolve4: () => Promise.resolve(['10.0.0.1']),
      resolve6: () => Promise.resolve([]),
    });
    expect(await zero.dns.resolveHost('ok')).toEqual(['10.0.0.1']);
    expect(zero.settings).toEqual([{ tries: 1, timeout: -1 }]);
    expect(zero.timers.history).toEqual([]);
    const tiny = setup(1, { resolveSrv: () => Promise.resolve([]) });
    await tiny.dns.resolveSrv('ok');
    expect(tiny.settings).toEqual([{ tries: 1, timeout: 1 }]);
  });
});
