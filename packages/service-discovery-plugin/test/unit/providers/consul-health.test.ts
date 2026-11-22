import { describe, expect, it } from 'vitest';
import { ConsulProvider } from '../../../src/providers/consul-provider.ts';
import { createFakeHttp, createFakeRuntime } from '../../fixtures/fakes.ts';

const OPTIONS = { address: 'http://127.0.0.1:8500', waitSeconds: 5 };

describe('ConsulProvider health (M70c)', () => {
  it('is reachable when /v1/status/leader answers 2xx', async () => {
    const http = createFakeHttp([{ status: 200, text: '127.0.0.1:8300' }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(true);
    // The probe hits the leader endpoint, not a health read.
    expect(http.calls[0]?.url).toBe('http://127.0.0.1:8500/v1/status/leader');
  });

  it('is unreachable when the agent answers non-2xx', async () => {
    const http = createFakeHttp([{ status: 500, text: 'boom' }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable on a transport failure', async () => {
    const http = createFakeHttp([{ error: new Error('ECONNREFUSED') }]);
    const provider = new ConsulProvider(OPTIONS, http, createFakeRuntime());
    expect(await provider.isHealthy()).toBe(false);
  });
});

it('bounds a hung consul probe even when the HTTP seam ignores abort', async () => {
  const runtime = createFakeRuntime();
  let signal: AbortSignal | null | undefined;
  const http = {
    ...createFakeHttp(),
    request: (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<never>(() => {});
    },
  };
  const provider = new ConsulProvider(OPTIONS, http, runtime);
  const outcome = provider.isHealthy();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(signal?.aborted).toBe(false);
  runtime.runTimeouts();
  expect(await outcome).toBe(false);
  expect(signal?.aborted).toBe(true);
});
