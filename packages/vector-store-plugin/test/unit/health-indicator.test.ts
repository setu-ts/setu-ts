/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The `vector-store` readiness indicator: the adapter's probe, cached and
 * time-bounded; an adapter without one; and the closed state.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
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
  it('the cache timeout is final even if the driver answers before the wrapper timer callback', async () => {
    const runtime = createRuntimeServices();
    const timers: (() => void)[] = [];
    const clock = {
      ...runtime,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length as never;
      },
      clearTimeout: () => {},
    };
    const pending = Promise.withResolvers<boolean>();
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const check = createVectorStoreIndicator(
      probed(() => pending.promise),
      clock,
      () => false,
      createConnectionErrorReporter({ source: 'vector', logger: () => logger }),
    );
    const result = check();
    await Promise.resolve();
    expect(timers).toHaveLength(2);
    timers[0]!();
    expect((await result).status).toBe('down');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    timers[1]!();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
  it('warns once, debugs repeats, reports false, ignores unknown and logs recovery', async () => {
    const { runtime, advance } = clockedRuntime();
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const reporter = createConnectionErrorReporter({
      source: 'vector-store-plugin: memory',
      logger: () => logger,
    });
    let value: boolean | undefined = false;
    let reject = true;
    const adapter: IVectorStoreAdapter = new MemoryVectorStore();
    adapter.isHealthy = () =>
      reject ? Promise.reject(new Error('revoked backend key')) : Promise.resolve(value);
    const check = createVectorStoreIndicator(adapter, runtime, () => false, reporter);
    expect((await check()).status).toBe('down');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('revoked backend key');
    advance(PROBE_TTL_MS + 1);
    await check();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    reject = false;
    advance(PROBE_TTL_MS + 1);
    await check();
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('reported unreachable');
    value = undefined;
    advance(PROBE_TTL_MS + 1);
    await check();
    expect(logger.info).not.toHaveBeenCalled();
    value = true;
    advance(PROBE_TTL_MS + 1);
    await check();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
  for (const late of ['true', 'false', 'rejection'] as const) {
    it(`a timeout wins over late ${late} and reports its bound once`, async () => {
      vi.useFakeTimers();
      try {
        const real = createRuntimeServices();
        const runtime = {
          ...real,
          setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
          clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        } as IRuntimeServices;
        const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
        const pending = Promise.withResolvers<boolean>();
        const check = createVectorStoreIndicator(
          probed(() => pending.promise),
          runtime,
          () => false,
          createConnectionErrorReporter({ source: 'vector', logger: () => logger }),
        );
        const result = check();
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
        expect((await result).status).toBe('down');
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logger.warn.mock.calls)).toContain('did not answer within 2000 ms');
        if (late === 'rejection') pending.reject(new Error('late'));
        else pending.resolve(late === 'true');
        await Promise.resolve();
        await Promise.resolve();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.debug).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }
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
