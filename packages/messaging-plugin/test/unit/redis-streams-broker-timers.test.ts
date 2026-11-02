/**
 * Regression: the broker must hand a timer handle back to `clearInterval`
 * EXACTLY as `setInterval` returned it.
 *
 * `TimerHandle` is `unknown` in `@setu-ts/common` — deliberately opaque,
 * so a runtime may return any shape. The broker used to store the handle as a
 * `number` (`Number(intervalId)`), which coerces an object-shaped handle to
 * `NaN`. `clearInterval(NaN)` is a silent no-op, so every subscription leaked a
 * poll loop that kept running after `unsubscribe()` and `disconnect()` — issuing
 * commands against a client that had already been quit.
 *
 * Production was unaffected only by luck: `globalThis.setInterval` returns a
 * Timeout object that coerces to its numeric id, so `Number()` happened to
 * round-trip. Any runtime whose handle does not coerce leaked outright.
 */
import { describe, expect, it } from 'vitest';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';

/**
 * Wraps the shared fake runtime so interval handles stay object-shaped (which is
 * what `createFakeRuntime` already returns) and every cleared handle is recorded.
 */
function createTimerRecordingRuntime(): {
  runtime: IRuntimeServices;
  started: TimerHandle[];
  cleared: TimerHandle[];
} {
  const base = createFakeRuntime();
  const started: TimerHandle[] = [];
  const cleared: TimerHandle[] = [];

  const runtime: IRuntimeServices = {
    ...base,
    setInterval: (fn: () => void, ms: number): TimerHandle => {
      const handle = base.setInterval(fn, ms);
      started.push(handle);
      return handle;
    },
    clearInterval: (handle: TimerHandle): void => {
      cleared.push(handle);
      base.clearInterval(handle);
    },
  };

  return { runtime, started, cleared };
}

describe('RedisStreamsBroker timer-handle round trip (M131a X88-7)', () => {
  it('creates ONE poll and ONE reclaim timer at connect(), none at subscribe()', async () => {
    const { runtime, started } = createTimerRecordingRuntime();
    const broker = new RedisStreamsBroker(runtime, new JsonSerializer(), {
      client: new FakeRedisStreamsClient(),
      pollIntervalMs: 10,
    });

    await broker.connect();
    expect(started.length).toBe(2);

    // subscribe() only registers the subscription; it must not start a timer,
    // or a lazily-subscribing handler would parent poll spans to its request.
    await broker.subscribe('timer.topic', () => Promise.resolve());
    await broker.subscribe('timer.topic-2', () => Promise.resolve());
    expect(started.length).toBe(2);

    await broker.disconnect();
  });

  it('two concurrent connect() calls start one pair of timers (CodeRabbit #543)', async () => {
    const { runtime, started, cleared } = createTimerRecordingRuntime();
    const broker = new RedisStreamsBroker(runtime, new JsonSerializer(), {
      client: new FakeRedisStreamsClient(),
      pollIntervalMs: 10,
    });

    await Promise.all([broker.connect(), broker.connect()]);
    expect(started.length).toBe(2);
    await broker.disconnect();
    // Every timer started was cleared: none outlives disconnect().
    expect(cleared).toEqual(started);
  });

  it('clears both shared timers at disconnect() with the identical handle', async () => {
    const { runtime, started, cleared } = createTimerRecordingRuntime();
    const broker = new RedisStreamsBroker(runtime, new JsonSerializer(), {
      client: new FakeRedisStreamsClient(),
      pollIntervalMs: 10,
    });

    await broker.connect();
    await broker.subscribe('timer.topic', () => Promise.resolve());

    await broker.disconnect();

    // Identity, not equality: an opaque handle must round-trip unchanged.
    // Before the fix this received NaN and the assertion failed.
    expect(cleared.length).toBe(2);
    expect(cleared[0]).toBe(started[0]);
    expect(cleared[1]).toBe(started[1]);
  });

  it('stops a subscription on unsubscribe without clearing the shared timers', async () => {
    const { runtime, cleared } = createTimerRecordingRuntime();
    const client = new FakeRedisStreamsClient();
    const broker = new RedisStreamsBroker(runtime, new JsonSerializer(), {
      client,
      pollIntervalMs: 10,
    });

    await broker.connect();
    const subscription = await broker.subscribe('timer.topic', () => Promise.resolve());

    // Let the loop run, then stop it and record how much work had been done.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await subscription.unsubscribe();

    // The shared timers are NOT cleared on unsubscribe: one subscription
    // stopping must not stop the timers serving its siblings.
    expect(cleared.length).toBe(0);

    const callsAfterUnsubscribe = client.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The stopped subscription's loop no longer polls, so no command runs for
    // it. (A leaked per-subscription interval would keep polling and grow this.)
    expect(client.calls.length).toBe(callsAfterUnsubscribe);

    await broker.disconnect();
  });
});
