/**
 * Regression: the broker must hand a timer handle back to `clearInterval`
 * EXACTLY as `setInterval` returned it.
 *
 * `TimerHandle` is `unknown` in `@hono-enterprise/common` — deliberately opaque,
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
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices, TimerHandle } from '@hono-enterprise/common';
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

describe('RedisStreamsBroker timer-handle round trip', () => {
  it('clears the poll interval with the identical handle setInterval returned', async () => {
    const { runtime, started, cleared } = createTimerRecordingRuntime();
    const broker = new RedisStreamsBroker(runtime, new JsonSerializer(), {
      client: new FakeRedisStreamsClient(),
      pollIntervalMs: 10,
    });

    await broker.connect();
    await broker.subscribe('timer.topic', () => Promise.resolve());
    expect(started.length).toBe(1);

    await broker.disconnect();

    // Identity, not equality: an opaque handle must round-trip unchanged.
    // Before the fix this received NaN and the assertion failed.
    expect(cleared.length).toBe(1);
    expect(cleared[0]).toBe(started[0]);
  });

  it('stops the poll loop on unsubscribe, so no command runs afterwards', async () => {
    const { runtime, started, cleared } = createTimerRecordingRuntime();
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
    expect(cleared[0]).toBe(started[0]);

    const callsAfterUnsubscribe = client.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A leaked interval would keep polling and grow this count.
    expect(client.calls.length).toBe(callsAfterUnsubscribe);

    await broker.disconnect();
  });
});
