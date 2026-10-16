import { describe, expect, it } from 'vitest';
import type { IDiscoveryHttp } from '../../src/interfaces/index.ts';
import { ConsulProvider } from '../../src/providers/consul-provider.ts';
import { KubernetesProvider } from '../../src/providers/kubernetes-provider.ts';
import { createFakeHttp, createFakeRuntime } from '../fixtures/fakes.ts';
import type { FakeRuntime } from '../fixtures/fakes.ts';

function createProvider(kind: 'consul' | 'kubernetes', http: IDiscoveryHttp, runtime: FakeRuntime) {
  return kind === 'consul'
    ? new ConsulProvider(
        { address: 'https://consul.test', waitSeconds: 5, token: 'acl-canary' },
        http,
        runtime,
      )
    : new KubernetesProvider(
        { namespace: 'default', apiServer: 'https://kube.test', token: 'sa-token' },
        http,
        runtime,
      );
}

describe.each(['consul', 'kubernetes'] as const)('%s probe cancellation', (kind) => {
  it('aborts a hung probe request at 2000 ms through the runtime timer', async () => {
    const runtime = createFakeRuntime();
    let signal: AbortSignal | null | undefined;
    let settled = false;
    const http: IDiscoveryHttp = {
      request: (_url, init) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      stream: () => Promise.reject(new Error('unused stream')),
    };
    const read = createProvider(kind, http, runtime)
      .isHealthy()
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(runtime.timeouts).toHaveLength(1);
    expect(runtime.timeouts[0]).toMatchObject({ ms: 2000, cleared: false });
    runtime.advance(1999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    runtime.advance(1);
    runtime.runTimeouts();
    expect(signal?.aborted).toBe(true);
    expect(await read).toBe(false);
    expect(runtime.timeouts[0]?.cleared).toBe(true);
  });

  it.each(['success', 'non-2xx', 'reject'] as const)(
    'clears the timer without aborting a prompt %s',
    async (outcome) => {
      const runtime = createFakeRuntime();
      const http = createFakeHttp([
        outcome === 'reject'
          ? { error: new Error('unreachable') }
          : { status: outcome === 'success' ? 200 : 503 },
      ]);
      expect(await createProvider(kind, http, runtime).isHealthy()).toBe(outcome === 'success');
      const init = http.calls[0]?.init;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      expect(runtime.timeouts[0]).toMatchObject({ ms: 2000, cleared: true });
      runtime.advance(2000);
      runtime.runTimeouts();
      expect(init?.signal?.aborted).toBe(false);
      expect(new Headers(init?.headers).get('X-Consul-Token')).toBeNull();
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        kind === 'kubernetes' ? 'Bearer sa-token' : null,
      );
    },
  );
});
