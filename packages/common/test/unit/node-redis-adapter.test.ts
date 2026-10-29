import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromNodeRedis, isConnectionFault } from '../../src/index.ts';
import { nodeRedisFake } from '../fixtures/node-redis-fake.ts';

afterEach(() => vi.useRealTimers());

describe('fromNodeRedis', () => {
  it.each([
    ['get', ['key'], ['GET', 'key']],
    ['set', ['k', 'v'], ['SET', 'k', 'v']],
    ['set', ['k', 'v', undefined, undefined], ['SET', 'k', 'v']],
    ['set', ['k', 'v', 'EX', 5], ['SET', 'k', 'v', 'EX', '5']],
    ['scan', ['0', 'MATCH', undefined], ['SCAN', '0', 'MATCH']],
    ['xadd', ['s', '*', ['f', 'v']], ['XADD', 's', '*', 'f', 'v']],
    ['xadd', ['s', '*', ['f', 5], 'g', 0], ['XADD', 's', '*', 'f', '5', 'g', '0']],
    ['del', [[], 'k', undefined, ['a', 2]], ['DEL', 'k', 'a', '2']],
    ['set', ['key', 'v', 'EX', 12], ['SET', 'key', 'v', 'EX', '12']],
    ['set', ['key', 'v', 'NX', 'PX', 12], ['SET', 'key', 'v', 'NX', 'PX', '12']],
    ['del', ['a', 'b'], ['DEL', 'a', 'b']],
    ['exists', ['a'], ['EXISTS', 'a']],
    ['ping', [], ['PING']],
    ['scan', ['0', 'MATCH', 'a*'], ['SCAN', '0', 'MATCH', 'a*']],
    ['zadd', ['k', 1, 'v'], ['ZADD', 'k', '1', 'v']],
    [
      'zrangebyscore',
      ['k', '-inf', 5, 'LIMIT', 0, 2],
      ['ZRANGEBYSCORE', 'k', '-inf', '5', 'LIMIT', '0', '2'],
    ],
    ['zrem', ['k', 'v'], ['ZREM', 'k', 'v']],
    ['hset', ['k', 'f', 'v'], ['HSET', 'k', 'f', 'v']],
    ['hget', ['k', 'f'], ['HGET', 'k', 'f']],
    ['hdel', ['k', 'f'], ['HDEL', 'k', 'f']],
    ['zcard', ['k'], ['ZCARD', 'k']],
    ['expire', ['k', 12], ['EXPIRE', 'k', '12']],
    ['eval', ['return ARGV[1]', 0, 'v'], ['EVAL', 'return ARGV[1]', '0', 'v']],
    ['xadd', ['s', '*', 'f', 'v'], ['XADD', 's', '*', 'f', 'v']],
    ['xgroup', ['CREATE', 's', 'g', '0'], ['XGROUP', 'CREATE', 's', 'g', '0']],
    [
      'xreadgroup',
      ['GROUP', 'g', 'c', 'STREAMS', 's', '>'],
      ['XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 's', '>'],
    ],
    ['xpending', ['s', 'g', '-', '+', 10], ['XPENDING', 's', 'g', '-', '+', '10']],
    ['xclaim', ['s', 'g', 'c', 0, '1-0'], ['XCLAIM', 's', 'g', 'c', '0', '1-0']],
    ['xinfo', ['GROUPS', 's'], ['XINFO', 'GROUPS', 's']],
    ['xack', ['s', 'g', '1-0'], ['XACK', 's', 'g', '1-0']],
    ['publish', ['ch', 'v'], ['PUBLISH', 'ch', 'v']],
    ['incr', ['k'], ['INCR', 'k']],
    ['pexpire', ['k', 12], ['PEXPIRE', 'k', '12']],
    ['pttl', ['k'], ['PTTL', 'k']],
  ] as const)('translates %s %j → %j', async (method, args, command) => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    const reply = 'reply';
    raw.sendCommand.mockResolvedValue(reply);
    expect(await adapter[method](...args)).toBe(reply);
    expect(raw.sendCommand).toHaveBeenCalledExactlyOnceWith(command);
    expect(raw.connect).toHaveBeenCalledTimes(1);
  });

  it('normalizes call maps and stream pairs through the same path', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    raw.sendCommand.mockResolvedValue({ policy: 'noeviction' });
    expect(await adapter.call('config', 'GET', 'maxmemory-policy')).toEqual([
      'policy',
      'noeviction',
    ]);
    expect(raw.sendCommand).toHaveBeenLastCalledWith(['CONFIG', 'GET', 'maxmemory-policy']);
    raw.sendCommand.mockResolvedValue({ s: [['1-0', ['f', 'v']]] });
    expect(await adapter.xreadgroup('STREAMS', 's', '>')).toEqual([['s', [['1-0', ['f', 'v']]]]]);
  });

  it('coalesces lazy and explicit connect, including while isOpen becomes true', async () => {
    const raw = nodeRedisFake();
    let finish!: () => void;
    raw.connect.mockImplementation(() => {
      raw.isOpen = true;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const adapter = fromNodeRedis(raw);
    expect(adapter.status).toBe('wait');
    const first = adapter.connect();
    expect(adapter.status).toBe('connecting');
    await Promise.resolve();
    expect(adapter.connect()).toBe(first);
    const command = adapter.get('k');
    await Promise.resolve();
    expect(raw.sendCommand).not.toHaveBeenCalled();
    finish();
    raw.isReady = true;
    await first;
    await command;
    expect(raw.connect).toHaveBeenCalledTimes(1);
    expect(adapter.status).toBe('ready');
    await adapter.connect();
    expect(raw.connect).toHaveBeenCalledTimes(1);
  });

  it('retries a failed connect and propagates command failures', async () => {
    const raw = nodeRedisFake();
    const error = new Error('refused');
    raw.connect.mockRejectedValueOnce(error);
    const adapter = fromNodeRedis(raw);
    await expect(adapter.ping()).rejects.toBe(error);
    expect(adapter.status).toBe('wait');
    await adapter.connect();
    raw.sendCommand.mockRejectedValue(error);
    await expect(adapter.ping()).rejects.toBe(error);
  });

  it('bounds a command already written and consumes its late rejection', async () => {
    vi.useFakeTimers();
    const raw = nodeRedisFake();
    raw.isOpen = true;
    raw.isReady = true;
    let rejectLate!: (error: Error) => void;
    raw.sendCommand.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectLate = reject;
        }),
    );
    const adapter = fromNodeRedis(raw, { commandTimeoutMs: 40 });
    let settled = false;
    const outcome = adapter.get('k').catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(39);
    expect(raw.sendCommand).toHaveBeenCalledExactlyOnceWith(['GET', 'k']);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await outcome).toEqual(new Error('Command timed out'));
    expect(isConnectionFault(await outcome)).toBe(true);
    rejectLate(new Error('late'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds lazy connect and clears its memo after expiry', async () => {
    vi.useFakeTimers();
    const raw = nodeRedisFake();
    raw.connect.mockImplementation(() => new Promise(() => {}));
    const adapter = fromNodeRedis(raw, { commandTimeoutMs: 5 });
    const outcome = adapter.connect().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    expect(await outcome).toEqual(new Error('Command timed out'));
    expect(adapter.status).toBe('wait');
  });

  it('defaults the bound to 15 seconds', async () => {
    vi.useFakeTimers();
    const raw = nodeRedisFake();
    raw.isOpen = true;
    raw.sendCommand.mockImplementation(() => new Promise(() => {}));
    const outcome = fromNodeRedis(raw)
      .ping()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toEqual(new Error('Command timed out'));
  });

  it('zero disables timers', async () => {
    vi.useFakeTimers();
    const raw = nodeRedisFake();
    const reply = Promise.withResolvers<unknown>();
    raw.sendCommand.mockReturnValue(reply.promise);
    const adapter = fromNodeRedis(raw, { commandTimeoutMs: 0 });
    const ping = adapter.ping();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(raw.sendCommand).toHaveBeenCalledExactlyOnceWith(['PING']);
    expect(vi.getTimerCount()).toBe(0);
    reply.resolve('PONG');
    expect(await ping).toBe('PONG');
    await adapter.quit();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, -1, Infinity, 2_147_483_648])('refuses invalid timeout %s', (commandTimeoutMs) => {
    expect(() => fromNodeRedis(nodeRedisFake(), { commandTimeoutMs })).toThrow(RangeError);
    expect(() => fromNodeRedis(nodeRedisFake(), { commandTimeoutMs })).toThrow('commandTimeoutMs');
  });

  it('quits once and reports end even when never opened', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    await adapter.quit();
    await adapter.quit();
    expect(raw.close).not.toHaveBeenCalled();
    expect(adapter.status).toBe('end');
    await expect(adapter.ping()).rejects.toThrow('The client is closed');
  });

  it('never opens a socket for a connect queued in the same tick as quit()', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    const connecting = adapter.connect();
    const quitting = adapter.quit();
    await expect(connecting).rejects.toThrow('The client is closed');
    await quitting;
    expect(raw.connect).not.toHaveBeenCalled();
    expect(raw.isOpen).toBe(false);
    expect(adapter.status).toBe('end');
  });

  it('closes the socket a connect in flight opens once quit() has begun', async () => {
    const raw = nodeRedisFake();
    let open!: () => void;
    raw.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          open = () => {
            raw.isOpen = true;
            raw.isReady = true;
            resolve();
          };
        }),
    );
    const adapter = fromNodeRedis(raw);
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(raw.connect).toHaveBeenCalledTimes(1));
    const quitting = adapter.quit();
    await Promise.resolve();
    expect(raw.close).not.toHaveBeenCalled();
    open();
    await connecting;
    await quitting;
    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(raw.isOpen).toBe(false);
  });

  it('quits after a failed connect in flight without surfacing its error', async () => {
    const raw = nodeRedisFake();
    let fail!: () => void;
    raw.connect.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error('Connection timeout'));
        }),
    );
    const adapter = fromNodeRedis(raw);
    const connecting = adapter.connect().catch((error: unknown) => error);
    await vi.waitFor(() => expect(raw.connect).toHaveBeenCalledTimes(1));
    const quitting = adapter.quit();
    fail();
    await quitting;
    expect(await connecting).toEqual(new Error('Connection timeout'));
    expect(raw.close).not.toHaveBeenCalled();
  });

  it('coalesces close and destroys a connection whose close times out', async () => {
    vi.useFakeTimers();
    const raw = nodeRedisFake();
    raw.isOpen = true;
    raw.close.mockImplementation(() => new Promise(() => {}));
    const adapter = fromNodeRedis(raw, { commandTimeoutMs: 5 });
    const closing = adapter.quit();
    expect(adapter.quit()).toBe(closing);
    await vi.advanceTimersByTimeAsync(5);
    await closing;
    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    await adapter.quit();
    expect(adapter.status).toBe('end');
  });

  it('closes gracefully, and destroys on a rejected close without hiding it', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    await adapter.connect();
    await adapter.quit();
    expect(raw.close).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
    const broken = nodeRedisFake();
    broken.isOpen = true;
    broken.close.mockRejectedValue(new Error('close failed'));
    await expect(fromNodeRedis(broken).quit()).rejects.toThrow('close failed');
    expect(broken.destroy).toHaveBeenCalledTimes(1);
  });

  it('disconnects synchronously and reports open but unready as connecting', () => {
    const raw = nodeRedisFake();
    raw.isOpen = true;
    const adapter = fromNodeRedis(raw);
    expect(adapter.status).toBe('connecting');
    adapter.disconnect();
    expect(adapter.status).toBe('end');
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('always installs one error listener and forwards only when configured', () => {
    const silent = nodeRedisFake();
    fromNodeRedis(silent);
    const silentListener = silent.on.mock.calls[0][1] as (error: unknown) => void;
    expect(() => silentListener(new Error('ignored event'))).not.toThrow();
    const raw = nodeRedisFake();
    const onError = vi.fn();
    fromNodeRedis(raw, { onError });
    expect(raw.on).toHaveBeenCalledTimes(1);
    expect(raw.on.mock.calls[0][0]).toBe('error');
    const listener = raw.on.mock.calls[0][1] as (error: unknown) => void;
    const error = new Error('event');
    listener(error);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(raw.off).not.toHaveBeenCalled();
  });

  it('subscribes every channel with ONE dispatcher, so a repeated subscribe delivers once', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    const listener = vi.fn();
    adapter.on('message', listener);
    await adapter.subscribe('ch');
    await adapter.subscribe('ch');
    await adapter.subscribe('other');
    const passed = raw.subscribe.mock.calls.map((call) => call[1]);
    expect(new Set(passed).size).toBe(1);
    // node-redis keeps a channel's listeners in a Set: the same function twice is once.
    const registered = new Set(
      raw.subscribe.mock.calls.filter((call) => call[0] === 'ch').map((call) => call[1]),
    );
    for (const dispatch of registered) dispatch('hello', 'ch');
    expect(listener).toHaveBeenCalledExactlyOnceWith('ch', 'hello');
  });

  it('tolerates node-redis 5 throwing from destroy() on an already closed client', async () => {
    const raw = nodeRedisFake();
    raw.destroy.mockImplementation(() => {
      throw new Error('The client is closed');
    });
    const adapter = fromNodeRedis(raw);
    expect(() => adapter.disconnect()).not.toThrow();
    expect(adapter.status).toBe('end');
    // quit()'s fallback after a rejected close reaches the same best-effort destroy.
    const closing = nodeRedisFake();
    closing.isOpen = true;
    closing.close.mockRejectedValue(new Error('close failed'));
    closing.destroy.mockImplementation(() => {
      throw new Error('The client is closed');
    });
    await expect(fromNodeRedis(closing).quit()).rejects.toThrow('close failed');
  });

  it('keeps a throwing onError inside the error listener', () => {
    const raw = nodeRedisFake();
    fromNodeRedis(raw, {
      onError: () => {
        throw new Error('handler failed');
      },
    });
    const listener = raw.on.mock.calls[0][1] as (error: unknown) => void;
    expect(() => listener(new Error('event'))).not.toThrow();
  });

  it('adapts pub/sub listener order and keeps a private message registry', async () => {
    const raw = nodeRedisFake();
    const adapter = fromNodeRedis(raw);
    const first = vi.fn();
    const second = vi.fn();
    adapter.on('message', first);
    adapter.on('message', second);
    adapter.on('message', first);
    await adapter.subscribe('ch');
    raw.subscribe.mock.calls[0][1]('body', 'ch');
    expect(first).toHaveBeenCalledExactlyOnceWith('ch', 'body');
    expect(second).toHaveBeenCalledExactlyOnceWith('ch', 'body');
    adapter.off('message', first);
    raw.subscribe.mock.calls[0][1]('next', 'ch');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    await adapter.unsubscribe('ch');
    expect(raw.unsubscribe).toHaveBeenCalledExactlyOnceWith('ch');
    adapter.on('ready', first);
    adapter.off('ready', first);
    expect(raw.on).toHaveBeenLastCalledWith('ready', first);
    expect(raw.off).toHaveBeenLastCalledWith('ready', first);
    expect(raw.on).toHaveBeenCalledTimes(2);
  });

  describe('with a client factory', () => {
    it('creates the client on the first connect, once, and attaches its error listener', async () => {
      const raw = nodeRedisFake();
      const factory = vi.fn(() => Promise.resolve(raw));
      const onError = vi.fn();
      const adapter = fromNodeRedis(factory, { onError });
      expect(factory).not.toHaveBeenCalled();
      expect(adapter.status).toBe('wait');
      await Promise.all([adapter.ping(), adapter.get('k')]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(raw.connect).toHaveBeenCalledTimes(1);
      expect(adapter.status).toBe('ready');
      const listener = raw.on.mock.calls.find(([event]) => event === 'error')![1] as (
        error: unknown,
      ) => void;
      listener(new Error('boom'));
      expect(onError).toHaveBeenCalledWith(new Error('boom'));
    });

    it('accepts a factory that returns the client synchronously', async () => {
      const raw = nodeRedisFake();
      expect(await fromNodeRedis(() => raw).ping()).toBe('OK');
    });

    it('holds emitter listeners until the client exists, honouring off()', async () => {
      const raw = nodeRedisFake();
      const adapter = fromNodeRedis(() => raw);
      const kept = vi.fn();
      const dropped = vi.fn();
      adapter.on('ready', kept);
      adapter.on('end', dropped);
      adapter.off('end', dropped);
      adapter.off('never-added', dropped);
      await adapter.connect();
      expect(raw.on).toHaveBeenCalledWith('ready', kept);
      expect(raw.on).not.toHaveBeenCalledWith('end', dropped);
      adapter.off('ready', kept);
      expect(raw.off).toHaveBeenCalledWith('ready', kept);
    });

    it('retries a factory that failed', async () => {
      const raw = nodeRedisFake();
      const factory = vi
        .fn<() => Promise<typeof raw>>()
        .mockRejectedValueOnce(new Error("Cannot find package 'redis'"))
        .mockResolvedValue(raw);
      const adapter = fromNodeRedis(factory);
      await expect(adapter.connect()).rejects.toThrow("Cannot find package 'redis'");
      await adapter.connect();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(adapter.status).toBe('ready');
    });

    it('opens nothing when quit() lands while the factory is still loading', async () => {
      const raw = nodeRedisFake();
      let load!: (client: typeof raw) => void;
      const adapter = fromNodeRedis(
        () =>
          new Promise<typeof raw>((resolve) => {
            load = resolve;
          }),
      );
      const connecting = adapter.connect();
      await vi.waitFor(() => expect(load).toBeTypeOf('function'));
      const quitting = adapter.quit();
      load(raw);
      await expect(connecting).rejects.toThrow('The client is closed');
      await quitting;
      expect(raw.connect).not.toHaveBeenCalled();
      expect(raw.close).not.toHaveBeenCalled();
    });

    it('quits and disconnects cleanly when no client was ever created', async () => {
      const factory = vi.fn(() => nodeRedisFake());
      const quitted = fromNodeRedis(factory);
      await quitted.quit();
      expect(quitted.status).toBe('end');
      const dropped = fromNodeRedis(factory);
      dropped.disconnect();
      expect(dropped.status).toBe('end');
      expect(factory).not.toHaveBeenCalled();
    });
  });
});
