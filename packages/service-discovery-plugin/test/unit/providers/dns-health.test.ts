import { expect, it } from 'vitest';
import { DnsProvider } from '../../../src/providers/dns-provider.ts';
import { createFakeDns, createFakeRuntime } from '../../fixtures/fakes.ts';

it('reports the last lookup outcome, including absence and a hung lookup abandoned at the bound', async () => {
  const answers: { a: readonly string[] | Error } = { a: ['10.0.0.1'] };
  const provider = new DnsProvider(createFakeDns(answers), createFakeRuntime(), {
    mode: 'a',
    port: 80,
    domainTemplate: '{service}',
    watchIntervalMs: 100,
  });
  expect(await provider.isHealthy()).toBe(true);
  await provider.resolve('billing');
  expect(await provider.isHealthy()).toBe(true);
  answers.a = new Error('SERVFAIL');
  await expect(provider.resolve('billing')).rejects.toThrow('SERVFAIL');
  await expect(provider.isHealthy()).rejects.toBe(answers.a);
  answers.a = Object.assign(new Error('absent'), { code: 'ENODATA' });
  expect(await provider.resolve('billing')).toEqual([]);
  expect(await provider.isHealthy()).toBe(true);
  const abort = new AbortController();
  const hung = new DnsProvider(
    { resolveHost: () => new Promise<never>(() => {}), resolveSrv: () => Promise.resolve([]) },
    createFakeRuntime(),
    { mode: 'a', port: 80, domainTemplate: '{service}', watchIntervalMs: 100 },
  );
  const pending = hung.resolve('billing', abort.signal);
  abort.abort(new Error('read bound'));
  await expect(pending).rejects.toThrow('read bound');
  await expect(hung.isHealthy()).rejects.toThrow('read bound');
});
