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
});
