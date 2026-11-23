import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDenoRuntimeServices } from '../../src/adapters/deno/deno-runtime.ts';
import { startDnsServer } from '../fixtures/udp-dns-server.ts';

describe('real Deno chosen-server resolver', () => {
  let answer: Awaited<ReturnType<typeof startDnsServer>>;
  let silent: Awaited<ReturnType<typeof startDnsServer>>;
  const runtime = createDenoRuntimeServices();
  beforeAll(async () => {
    answer = await startDnsServer();
    silent = await startDnsServer({ silent: true });
  });
  afterAll(async () => {
    await answer.stop();
    await silent.stop();
  });
  it('answers addresses and SRV and exposes NXDOMAIN', async () => {
    const dns = runtime.createDnsResolver!({ servers: [answer.server], timeoutMs: 1000 });
    expect(await dns.resolveHost('ok.test')).toEqual(['10.0.0.1']);
    expect(await dns.resolveSrv('_svc._tcp.ok.test')).toEqual([
      { host: 'ok.test', port: 8080, priority: 10, weight: 5 },
    ]);
    await expect(dns.resolveHost('missing.test')).rejects.toMatchObject({
      cause: { errors: [{ name: 'NotFound' }, { name: 'NotFound' }] },
    });
    expect(answer.queries).toBeGreaterThan(0);
  });
  it('rotates after a silent first server within the whole bound', async () => {
    const timeoutMs = 1000;
    const began = runtime.hrtime();
    expect(
      await runtime.createDnsResolver!({
        servers: [silent.server, answer.server],
        timeoutMs,
      }).resolveHost('ok.test'),
    ).toEqual(['10.0.0.1']);
    expect(runtime.hrtime() - began).toBeLessThan(timeoutMs + 250);
    expect(silent.queries).toBeGreaterThan(0);
  });
  it('bounds a silent server with ETIMEOUT', async () => {
    const timeoutMs = 150;
    const began = runtime.hrtime();
    await expect(
      runtime.createDnsResolver!({ servers: [silent.server], timeoutMs }).resolveHost('hang.test'),
    ).rejects.toMatchObject({ cause: { errors: [{ code: 'ETIMEOUT' }, { code: 'ETIMEOUT' }] } });
    expect(runtime.hrtime() - began).toBeLessThan(timeoutMs + 250);
  });
});
