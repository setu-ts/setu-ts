/**
 * `watchConnection` (M131a audit): the reporter on an injected client detaches,
 * so a stopped application no longer receives the client's events and a
 * shared client does not collect one listener pair per application.
 *
 * @module
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { watchConnection } from '../../src/index.ts';

function reporter() {
  return { report: vi.fn<(error: unknown) => void>(), recovered: vi.fn<() => void>() };
}

describe('watchConnection', () => {
  it('routes error and ready events to the reporter until detached', () => {
    const client = new EventEmitter();
    const sink = reporter();
    const watch = watchConnection(client, sink);
    expect(watch.attached).toBe(true);
    client.emit('error', new Error('down'));
    client.emit('ready');
    expect(sink.report).toHaveBeenCalledTimes(1);
    expect(sink.recovered).toHaveBeenCalledTimes(1);
    watch.detach();
    watch.detach();
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('ready')).toBe(0);
  });

  it('does not accumulate listeners across many applications sharing one client', () => {
    const client = new EventEmitter();
    for (let app = 0; app < 12; app++) watchConnection(client, reporter()).detach();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('removes through removeListener when the client has no off', () => {
    const listeners = new Map<string, unknown>();
    const client = {
      on: (event: string, listener: unknown) => listeners.set(event, listener),
      removeListener: (event: string) => listeners.delete(event),
    };
    watchConnection(client).detach();
    expect(listeners.size).toBe(0);
  });

  it('drops events after detach on a client that cannot remove listeners', () => {
    const handlers: ((value: unknown) => void)[] = [];
    const client = {
      on: (_event: string, listener: (value: unknown) => void) => handlers.push(listener),
    };
    const sink = reporter();
    const watch = watchConnection(client, sink);
    watch.detach();
    for (const handler of handlers) handler(new Error('late'));
    expect(sink.report).not.toHaveBeenCalled();
    expect(sink.recovered).not.toHaveBeenCalled();
  });
});
