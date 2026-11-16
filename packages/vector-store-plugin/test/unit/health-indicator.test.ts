/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The `vector-store` readiness indicator: the adapter's probe, cached and
 * time-bounded; an adapter without one; and the closed state.
 */
import { describe, expect, it } from 'vitest';
import type { IRuntimeServices, IVectorStoreAdapter } from '@setu-ts/common';
import { createRuntimeServices } from '@setu-ts/runtime';
import {
  createVectorStoreIndicator,
  PROBE_TIMEOUT_MS,
  PROBE_TTL_MS,
} from '../../src/health/indicator.ts';
import { MemoryVectorStore } from '../../src/index.ts';

/** A runtime whose monotonic clock the test advances, with real timers. */
function clockedRuntime(): { runtime: IRuntimeServices; advance: (ms: number) => void } {
  const real = createRuntimeServices();
  let now = 0;
  const runtime = Object.create(real) as IRuntimeServices;
  Object.defineProperty(runtime, 'hrtime', { value: () => now });
  return { runtime, advance: (ms) => (now += ms) };
}

/** An adapter whose probe answers from `answer`, counting calls. */
function probed(answer: () => Promise<boolean>): IVectorStoreAdapter & { calls: number } {
  const adapter = new MemoryVectorStore() as MemoryVectorStore & { calls: number };
  adapter.calls = 0;
  adapter.isHealthy = async () => {
    adapter.calls++;
    return answer();
  };
  return adapter;
}

describe('createVectorStoreIndicator', () => {
  it('reports up with the adapter name when the probe answers', async () => {
    const { runtime } = clockedRuntime();
    const check = createVectorStoreIndicator(
      probed(async () => true),
      runtime,
      () => false,
    );
    expect(await check()).toEqual({
      status: 'up',
      data: { adapter: 'memory', reachable: true },
    });
  });

  it('reports down when the probe answers false, rejects, or exceeds its window', async () => {
    for (const answer of [
      async () => false,
      async () => Promise.reject(new Error('connection refused')),
    ]) {
      const { runtime } = clockedRuntime();
      const check = createVectorStoreIndicator(probed(answer), runtime, () => false);
      expect(await check()).toEqual({
        status: 'down',
        data: { adapter: 'memory', reachable: false },
      });
    }
    const { runtime } = clockedRuntime();
    const hang = createVectorStoreIndicator(
      probed(() => new Promise<boolean>(() => {})),
      runtime,
      () => false,
    );
    const started = Date.now();
    expect((await hang()).status).toBe('down');
    expect(Date.now() - started).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
  });

  it('reuses one outcome within the cache window and probes again after it', async () => {
    const { runtime, advance } = clockedRuntime();
    let healthy = true;
    const adapter = probed(async () => healthy);
    const check = createVectorStoreIndicator(adapter, runtime, () => false);
    expect((await check()).status).toBe('up');
    healthy = false;
    expect((await check()).status).toBe('up');
    expect(adapter.calls).toBe(1);
    advance(PROBE_TTL_MS + 1);
    expect((await check()).status).toBe('down');
    expect(adapter.calls).toBe(2);
  });

  it('stays up with reachable unknown when the adapter could not tell', async () => {
    const adapter: IVectorStoreAdapter = new MemoryVectorStore();
    Object.defineProperty(adapter, 'isHealthy', { value: async () => undefined });
    const check = createVectorStoreIndicator(adapter, clockedRuntime().runtime, () => false);
    expect(await check()).toEqual({
      status: 'up',
      data: { adapter: 'memory', reachable: 'unknown' },
    });
  });

  it('stays up with reachable unknown for an adapter without a probe', async () => {
    const adapter = new MemoryVectorStore();
    Object.defineProperty(adapter, 'isHealthy', { value: undefined });
    const check = createVectorStoreIndicator(adapter, clockedRuntime().runtime, () => false);
    expect(await check()).toEqual({
      status: 'up',
      data: { adapter: 'memory', reachable: 'unknown' },
    });
  });

  it('reports closed when the adapter closes while the probe is in flight', async () => {
    let isClosed = false;
    const adapter = probed(async () => {
      isClosed = true;
      return true;
    });
    const check = createVectorStoreIndicator(adapter, clockedRuntime().runtime, () => isClosed);
    expect(await check()).toEqual({
      status: 'down',
      data: { adapter: 'memory', state: 'closed' },
    });
    expect(adapter.calls).toBe(1);
  });

  it('reports down once the adapter is closed, without probing', async () => {
    const adapter = probed(async () => true);
    const check = createVectorStoreIndicator(adapter, clockedRuntime().runtime, () => true);
    expect(await check()).toEqual({
      status: 'down',
      data: { adapter: 'memory', state: 'closed' },
    });
    expect(adapter.calls).toBe(0);
  });
});
