import { describe, expect, it } from 'vitest';
import { createNodeServerDnsResolver } from '../../src/adapters/shared/node-server-dns-resolver.ts';
import type { NodeResolverLike } from '../../src/adapters/shared/node-server-dns-resolver.ts';
import { deferred, DnsTimers, flushDns } from '../fixtures/dns-fakes.ts';

type Answer = (server: string, family: 'SRV' | 'A' | 'AAAA') => Promise<unknown>;

const SERVERS = ['127.0.0.1', '127.0.0.2:5353', '[::1]:54'];

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Each fake resolver keeps its own pending queries, so cancelling one rejects
 * only that resolver's queries with `ECANCELLED`, as Node's `cancel()` does.
 * A query left unanswered by `answer` stays pending until cancelled.
 */
function setup(answer: Answer, timeoutMs = 99) {
  const timers = new DnsTimers();
  const instances: { servers: string[]; cancelled: number; pending: number }[] = [];
  const settings: { timeout: number; tries: number }[] = [];
  const dns = createNodeServerDnsResolver(
    { servers: SERVERS, timeoutMs },
    {
      ...timers,
      createResolver(opts) {
        settings.push(opts);
        const own: { reject(error: unknown): void }[] = [];
        const instance = { servers: [] as string[], cancelled: 0, pending: 0 };
        const ask = (family: 'SRV' | 'A' | 'AAAA'): Promise<unknown> => {
          const gate = deferred<never>();
          own.push(gate);
          instance.pending++;
          return Promise.race([answer(instance.servers[0]!, family), gate.promise]);
        };
        const resolver: NodeResolverLike = {
          setServers(servers) {
            instance.servers = servers;
          },
          cancel() {
            instance.cancelled++;
            for (const gate of own) gate.reject(failure('ECANCELLED'));
          },
          resolveSrv: () => ask('SRV') as ReturnType<NodeResolverLike['resolveSrv']>,
          resolve4: () => ask('A') as Promise<string[]>,
          resolve6: () => ask('AAAA') as Promise<string[]>,
        };
        instances.push(instance);
        return resolver;
      },
    },
  );
  return { dns, timers, instances, settings };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe('chosen-server Node DNS', () => {
  it('asks one server per attempt, maps SRV, and clears every timer on success', async () => {
    const { dns, timers, instances, settings } = setup(() =>
      Promise.resolve([{ name: 'ok.test', port: 8080, priority: 10, weight: 5, type: 'SRV' }]),
    );
    expect(await dns.resolveSrv('_svc')).toEqual([
      { host: 'ok.test', port: 8080, priority: 10, weight: 5 },
    ]);
    expect(settings).toEqual([{ tries: 1, timeout: 33 }]);
    expect(instances.map((entry) => entry.servers)).toEqual([['127.0.0.1']]);
    expect(timers.history.map((entry) => entry.ms)).toEqual([99, 33]);
    expect(timers.pending.size).toBe(0);
  });

  it.each([
    ['its share timer', null],
    ['ESERVFAIL', 'ESERVFAIL'],
    ['ECONNREFUSED', 'ECONNREFUSED'],
  ])('moves to the next server after %s, in order', async (_label, code) => {
    const { dns, timers, instances } = setup((server) =>
      server === '127.0.0.1'
        ? code === null
          ? never()
          : Promise.reject(failure(code))
        : Promise.resolve([{ name: server, port: 1, priority: 0, weight: 0 }]),
    );
    const result = dns.resolveSrv('_svc');
    await flushDns();
    if (code === null) timers.fire(33);
    expect(await result).toEqual([{ host: '127.0.0.2:5353', port: 1, priority: 0, weight: 0 }]);
    expect(instances.map((entry) => entry.servers)).toEqual([['127.0.0.1'], ['127.0.0.2:5353']]);
    expect(instances[0]!.cancelled).toBe(code === null ? 1 : 0);
    expect(timers.pending.size).toBe(0);
  });

  it.each(['ENOTFOUND', 'ENODATA'])('stops at the first server on %s', async (code) => {
    const { dns, instances, timers } = setup(() => Promise.reject(failure(code)));
    await expect(dns.resolveHost('absent')).rejects.toMatchObject({
      cause: { errors: [{ code }, { code }] },
    });
    // One attempt per family, both at the first server.
    expect(instances.map((entry) => entry.servers)).toEqual([['127.0.0.1'], ['127.0.0.1']]);
    expect(timers.pending.size).toBe(0);
  });

  it('reports the last server error after every server failed', async () => {
    const { dns, instances, timers } = setup((server) =>
      Promise.reject(failure(server === '[::1]:54' ? 'EREFUSED' : 'ESERVFAIL')),
    );
    await expect(dns.resolveSrv('down')).rejects.toMatchObject({ code: 'EREFUSED' });
    expect(instances.map((entry) => entry.servers[0])).toEqual(SERVERS);
    expect(timers.pending.size).toBe(0);
  });

  it('turns every attempt share into ETIMEOUT, never ECANCELLED', async () => {
    const { dns, timers, instances } = setup(never, 300);
    const result = dns.resolveSrv('slow');
    const assertion = expect(result).rejects.toMatchObject({
      code: 'ETIMEOUT',
      message: 'DNS attempt for slow at server 2 did not finish within its 100 ms share',
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await flushDns();
      timers.fire(100);
    }
    await assertion;
    expect(instances.map((entry) => entry.cancelled)).toEqual([1, 1, 1]);
    expect(timers.pending.size).toBe(0);
  });

  it('stops every in-flight attempt of both families when the whole bound fires', async () => {
    const { dns, timers, instances } = setup(never);
    const result = dns.resolveHost('hang');
    const assertion = expect(result).rejects.toMatchObject({
      message: 'DNS lookup failed for hang',
      cause: {
        errors: [
          { code: 'ETIMEOUT', message: 'DNS lookup for hang did not finish within 99 ms' },
          { code: 'ETIMEOUT', message: 'DNS lookup for hang did not finish within 99 ms' },
        ],
      },
    });
    await flushDns();
    timers.fire(99);
    await assertion;
    await flushDns();
    expect(instances.map((entry) => entry.cancelled)).toEqual([1, 1]);
    expect(timers.pending.size).toBe(0);
  });

  it.each(['A', 'AAAA'] as const)(
    'keeps the %s answer while the other family is still pending at the bound',
    async (family) => {
      const { dns, timers } = setup((_server, asked) =>
        asked === family ? Promise.resolve([family === 'A' ? '10.0.0.1' : '::1']) : never(),
      );
      const result = dns.resolveHost('partial');
      await flushDns();
      timers.fire(99);
      expect(await result).toEqual([family === 'A' ? '10.0.0.1' : '::1']);
      expect(timers.pending.size).toBe(0);
    },
  );

  it('settles once when an answer races the whole bound', async () => {
    const gate = deferred<string[]>();
    const { dns, timers } = setup(() => gate.promise);
    const result = dns.resolveHost('race');
    const assertion = expect(result).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    await flushDns();
    gate.resolve(['10.0.0.1']); // Its callbacks have not run when the bound fires.
    timers.fire(99);
    await assertion;
    await flushDns();
    expect(timers.pending.size).toBe(0);
  });

  it('never cancels another lookup when two are unresolved at once', async () => {
    const { dns, timers, instances } = setup(never);
    const first = dns.resolveSrv('one');
    const second = dns.resolveSrv('two');
    const firstFailed = expect(first).rejects.toMatchObject({ code: 'ETIMEOUT' });
    const secondFailed = expect(second).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await flushDns();
    // Both lookups wait at their first server; end only the first lookup's attempt.
    const [firstAttempt] = [...timers.pending].filter(([, task]) => task.ms === 33);
    timers.pending.delete(firstAttempt![0]);
    firstAttempt![1].callback();
    await flushDns();
    expect(instances.slice(0, 2).map((entry) => entry.servers)).toEqual([
      ['127.0.0.1'],
      ['127.0.0.1'],
    ]);
    expect(instances[0]!.cancelled).toBe(1);
    expect(instances[1]!.cancelled).toBe(0);
    let secondSettled = false;
    void second.then(
      () => (secondSettled = true),
      () => (secondSettled = true),
    );
    await flushDns();
    expect(secondSettled).toBe(false);
    // Let both whole bounds fire so neither lookup is left pending.
    timers.fire(99);
    timers.fire(99);
    await firstFailed;
    await secondFailed;
  });

  it('installs no timers and passes -1 when timeoutMs is zero', async () => {
    const { dns, settings, timers, instances } = setup(
      (server) =>
        server === '127.0.0.1'
          ? Promise.reject(failure('ESERVFAIL'))
          : Promise.resolve(['10.0.0.1']),
      0,
    );
    expect(await dns.resolveHost('ok')).toEqual(['10.0.0.1', '10.0.0.1']);
    expect(settings.every((entry) => entry.timeout === -1 && entry.tries === 1)).toBe(true);
    expect(instances).toHaveLength(4);
    expect(timers.history).toEqual([]);
  });

  it('enforces a minimum share of 1 ms', async () => {
    const { dns, settings } = setup(() => Promise.resolve([]), 1);
    await dns.resolveSrv('ok');
    expect(settings).toEqual([{ tries: 1, timeout: 1 }]);
  });
});
