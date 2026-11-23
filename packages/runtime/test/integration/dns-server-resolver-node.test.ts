import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import { startDnsServer } from '../fixtures/udp-dns-server.ts';

describe('real Node chosen-server resolver', () => {
  let answer: Awaited<ReturnType<typeof startDnsServer>>;
  let silent: Awaited<ReturnType<typeof startDnsServer>>;
  const runtime = createNodeRuntimeServices();
  beforeAll(async () => {
    answer = await startDnsServer();
    silent = await startDnsServer({ silent: true });
    // The first c-ares lookup in a process can take twice the attempt timeout.
    // This warm-up is deliberately untimed and precedes every timing assertion.
    await runtime.createDnsResolver!({ servers: [answer.server], timeoutMs: 0 }).resolveHost(
      'ok.test',
    );
  });
  afterAll(async () => {
    await answer.stop();
    await silent.stop();
  });
  it('answers SRV, v4-only, v6-only, and exposes every NXDOMAIN failure', async () => {
    const dns = runtime.createDnsResolver!({ servers: [answer.server], timeoutMs: 1000 });
    expect(await dns.resolveSrv('_svc._tcp.ok.test')).toEqual([
      { host: 'ok.test', port: 8080, priority: 10, weight: 5 },
    ]);
    expect(await dns.resolveHost('ok.test')).toEqual(['10.0.0.1']);
    expect(await dns.resolveHost('v6.test')).toEqual(['2001:db8::1']);
    await expect(dns.resolveHost('missing.test')).rejects.toMatchObject({
      cause: { errors: [{ code: 'ENOTFOUND' }, { code: 'ENOTFOUND' }] },
    });
    expect(answer.queries).toBeGreaterThan(0);
  });
  it('bounds a silent server, without leaking ECANCELLED', async () => {
    const timeoutMs = 150;
    const dns = runtime.createDnsResolver!({ servers: [silent.server], timeoutMs });
    const began = runtime.hrtime();
    await expect(dns.resolveHost('hang.test')).rejects.toMatchObject({
      cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] },
    });
    expect(runtime.hrtime() - began).toBeLessThan(timeoutMs + 250);
    expect(silent.queries).toBeGreaterThan(0);
  });
  it('reaches a second server after a silent first within the whole bound', async () => {
    const before = silent.queries;
    // Below c-ares's ~250 ms attempt floor: only the resolver's own per-attempt deadline moves on in time.
    const timeoutMs = 300;
    const began = runtime.hrtime();
    const dns = runtime.createDnsResolver!({ servers: [silent.server, answer.server], timeoutMs });
    expect(await dns.resolveHost('ok.test')).toEqual(['10.0.0.1']);
    expect(runtime.hrtime() - began).toBeLessThan(timeoutMs + 250);
    expect(silent.queries).toBeGreaterThan(before);
  });
});
