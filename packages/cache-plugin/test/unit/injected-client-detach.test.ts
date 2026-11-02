/**
 * The reporter on an injected client is detached when the store stops
 * (M131a audit): a client shared across applications must not report into a
 * stopped one's logger, nor collect one listener pair per application.
 *
 * @module
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RedisStore } from '../../src/stores/redis-store.ts';

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

describe('RedisStore injected client', () => {
  it('reports its errors while connected and detaches on disconnect', async () => {
    const client = eventClient(['get', 'set', 'del', 'exists', 'scan', 'quit', 'ping']);
    const reporter = { report: vi.fn(), recovered: vi.fn() };
    const store = new RedisStore('p', {
      client: client as never,
      connectionErrorReporter: reporter,
    });
    await store.connect();
    client.emit('error', new Error('down'));
    expect(reporter.report).toHaveBeenCalledTimes(1);
    await store.disconnect();
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('ready')).toBe(0);
  });

  it('keeps its error listener through QUIT, then detaches (N-4)', async () => {
    const client = quitEmitsError(
      eventClient(['get', 'set', 'del', 'exists', 'scan', 'quit', 'ping']),
    );
    const reporter = { report: vi.fn(), recovered: vi.fn() };
    const store = new RedisStore('p', {
      client: client as never,
      connectionErrorReporter: reporter,
    });
    await store.connect();
    await store.disconnect();
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('a failed connect and its retry leave one listener pair (N-3)', async () => {
    const client = eventClient(['get', 'set', 'del', 'exists', 'scan', 'quit', 'ping']);
    let attempts = 0;
    client['connect'] = () =>
      ++attempts === 1 ? Promise.reject(new Error('refused')) : Promise.resolve();
    const store = new RedisStore('p', { client: client as never });
    await expect(store.connect()).rejects.toThrow('refused');
    expect(client.listenerCount('error')).toBe(0);
    await store.connect();
    expect(client.listenerCount('error')).toBe(1);
    await store.disconnect();
    expect(client.listenerCount('error')).toBe(0);
  });
});
