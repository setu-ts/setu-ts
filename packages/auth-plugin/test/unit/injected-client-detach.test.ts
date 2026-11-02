/**
 * The reporter on an injected client is detached when the store stops
 * (M131a audit): a client shared across applications must not report into a
 * stopped one's logger, nor collect one listener pair per application.
 *
 * @module
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RedisRateLimitStore } from '../../src/stores/redis-rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** An injected client that emits events and answers every command. */
function eventClient(methods: readonly string[]): EventEmitter & Record<string, unknown> {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  for (const method of methods)
    client[method] = () => Promise.resolve(method === 'incr' ? 1 : 'OK');
  return client;
}

/** A client whose QUIT emits an error first, as ioredis does on an unreachable server. */
function quitEmitsError<T extends EventEmitter & Record<string, unknown>>(client: T): T {
  (client as Record<string, unknown>)['quit'] = () => {
    client.emit('error', new Error('write EPIPE'));
    return Promise.resolve('OK');
  };
  return client;
}

describe('RedisRateLimitStore injected client', () => {
  it('reports its errors while in use and detaches on disconnect', async () => {
    const client = eventClient(['incr', 'pexpire', 'pttl', 'del', 'quit']);
    const reporter = { report: vi.fn(), recovered: vi.fn() };
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client: client as never,
      connectionErrorReporter: reporter,
    });
    await store.increment('k', 1000);
    client.emit('error', new Error('down'));
    expect(reporter.report).toHaveBeenCalledTimes(1);
    await store.disconnect();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('keeps its error listener through QUIT, then detaches (N-4)', async () => {
    const client = quitEmitsError(eventClient(['incr', 'pexpire', 'pttl', 'del', 'quit']));
    const reporter = { report: vi.fn(), recovered: vi.fn() };
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client: client as never,
      connectionErrorReporter: reporter,
    });
    await store.increment('k', 1000);
    await store.disconnect();
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('fifty concurrent first requests attach one listener pair (N-3)', async () => {
    const client = eventClient(['incr', 'pexpire', 'pttl', 'del', 'quit']);
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client: client as never,
    });
    await Promise.all(Array.from({ length: 50 }, () => store.increment('k', 1000)));
    expect(client.listenerCount('error')).toBe(1);
    await store.disconnect();
    expect(client.listenerCount('error')).toBe(0);
  });
});
