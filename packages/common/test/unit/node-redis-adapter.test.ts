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
});
