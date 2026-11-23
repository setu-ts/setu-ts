import { describe, expect, it } from 'vitest';
import { createDenoServerDnsResolver } from '../../src/adapters/deno/deno-server-dns-resolver.ts';
import type { DenoDnsHost, DenoSrvRecord } from '../../src/adapters/deno/deno-dns-resolver.ts';
import { deferred, DnsTimers, flushDns } from '../fixtures/dns-fakes.ts';

type Settings = Parameters<DenoDnsHost['resolveDns']>[2];
function setup(
  answer: (type: string, settings: Settings) => Promise<string[] | DenoSrvRecord[]>,
  timeoutMs = 101,
) {
  const timers = new DnsTimers();
  const calls: { name: string; type: string; settings: Settings }[] = [];
  const host: DenoDnsHost = {
    resolveDns: ((name: string, type: string, settings: Settings) => {
      calls.push({ name, type, settings });
      return answer(type, settings);
    }) as DenoDnsHost['resolveDns'],
  };
  const dns = createDenoServerDnsResolver(
    { servers: ['127.0.0.1:5353', '::1'], timeoutMs },
    host,
    timers,
  );
  return { dns, timers, calls };
}

function abortable(settings: Settings): Promise<never> {
  return new Promise((_, reject) => {
    settings!.signal!.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true },
    );
  });
}

describe('chosen-server Deno DNS', () => {
  it('passes nameServer and signal, maps SRV, and clears both timers', async () => {
    const { dns, calls, timers } = setup(() =>
      Promise.resolve([{ target: 'ok.test', port: 8080, priority: 10, weight: 5 }]),
    );
    expect(await dns.resolveSrv('_svc')).toEqual([
      { host: 'ok.test', port: 8080, priority: 10, weight: 5 },
    ]);
    expect(calls[0]).toMatchObject({
      name: '_svc',
      type: 'SRV',
      settings: { nameServer: { ipAddr: '127.0.0.1', port: 5353 } },
    });
    expect(calls[0]!.settings!.signal).toBeInstanceOf(AbortSignal);
    expect(timers.history.map((entry) => entry.ms)).toEqual([101, 51]);
    expect(timers.pending.size).toBe(0);
    timers.history[0]!.callback();
    expect(calls[0]!.settings!.signal!.aborted).toBe(false);
  });
  it.each(['TimedOut', 'Error'])('rotates on %s, preserving server order', async (name) => {
    const { dns, calls, timers } = setup((_, settings) =>
      settings!.nameServer!.ipAddr === '127.0.0.1'
        ? Promise.reject(Object.assign(new Error('failed'), { name }))
        : Promise.resolve(['::1']),
    );
    expect(await dns.resolveHost('ok')).toEqual(['::1', '::1']);
    expect(calls.map((entry) => entry.settings!.nameServer)).toEqual([
      { ipAddr: '127.0.0.1', port: 5353 },
      { ipAddr: '127.0.0.1', port: 5353 },
      { ipAddr: '::1', port: 53 },
      { ipAddr: '::1', port: 53 },
    ]);
    expect(timers.pending.size).toBe(0);
  });
  it('does not rotate on NotFound, and keeps both family errors', async () => {
    const error = Object.assign(new Error('absent'), { name: 'NotFound' });
    const { dns, calls, timers } = setup(() => Promise.reject(error));
    await expect(dns.resolveHost('absent')).rejects.toMatchObject({
      cause: { errors: [error, error] },
    });
    expect(calls).toHaveLength(2);
    expect(timers.pending.size).toBe(0);
  });
  it('drives rotation with the injected share timer and clears every attempt', async () => {
    const { dns, calls, timers } = setup((_, settings) =>
      settings!.nameServer!.ipAddr === '127.0.0.1' ? abortable(settings) : Promise.resolve([]),
    );
    const result = dns.resolveSrv('slow');
    timers.fire(51);
    await flushDns();
    expect(await result).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.settings!.signal!.aborted).toBe(true);
    expect(calls[1]!.settings!.signal!.aborted).toBe(false);
    expect(timers.pending.size).toBe(0);
  });
  it('reports the last non-NotFound failure after exhausting servers', async () => {
    const { dns, calls, timers } = setup(() => Promise.reject(new Error('offline')));
    await expect(dns.resolveSrv('offline')).rejects.toThrow('offline');
    expect(calls).toHaveLength(2);
    expect(timers.pending.size).toBe(0);
  });
  it('whole timeout wins over the abort rejection, aborting only this lookup', async () => {
    const { dns, calls, timers } = setup((_, settings) => abortable(settings));
    const result = dns.resolveSrv('hang');
    const assertion = expect(result).rejects.toMatchObject({
      code: 'ETIMEOUT',
      message: 'DNS lookup for hang did not finish within 101 ms',
    });
    timers.fire(101);
    await assertion;
    await flushDns();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.settings!.signal!.aborted).toBe(true);
    expect(timers.pending.size).toBe(0);
  });
  it('counts both pending families as ETIMEOUT and clears all timers', async () => {
    const { dns, timers } = setup((_, settings) => abortable(settings));
    const result = dns.resolveHost('hang');
    const assertion = expect(result).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    timers.fire(101);
    await assertion;
    await flushDns();
    expect(timers.pending.size).toBe(0);
  });
  it.each(['A', 'AAAA'])(
    'keeps the %s answer while timing out the other family',
    async (family) => {
      const { dns, timers } = setup((type, settings) =>
        type === family ? Promise.resolve(['answered']) : abortable(settings),
      );
      const result = dns.resolveHost('partial');
      await flushDns();
      timers.fire(101);
      expect(await result).toEqual(['answered']);
      await flushDns();
      expect(timers.pending.size).toBe(0);
    },
  );
  it('ignores a late answer racing with the whole timer', async () => {
    const gate = deferred<string[]>();
    const { dns, timers } = setup(() => gate.promise);
    const result = dns.resolveHost('race');
    const assertion = expect(result).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    gate.resolve(['late']);
    timers.fire(101);
    await assertion;
    await flushDns();
    expect(timers.pending.size).toBe(0);
  });
  it('does not pass a signal or install timers when timeoutMs is zero', async () => {
    const { dns, calls, timers } = setup(() => Promise.resolve([]), 0);
    expect(await dns.resolveHost('ok')).toEqual([]);
    expect(calls.every((entry) => !('signal' in entry.settings!))).toBe(true);
    expect(timers.history).toEqual([]);
  });
});
