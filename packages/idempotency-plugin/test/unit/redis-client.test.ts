/**
 * Unit tests for the Redis client seam (plan §3.5).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IdempotencyConfigurationError } from '../../src/errors.ts';
import {
  createRedisIdempotencyClient,
  validateInjectedClient,
} from '../../src/stores/redis-client.ts';
import type { RedisCtor } from '../../src/stores/redis-client.ts';

/** A recording Redis constructor. */
class RecordingRedis {
  static last: { url: string; options: Record<string, unknown> | undefined } | undefined;
  /** Every `on(event, handler)` the client received, in order. */
  static listeners: Array<{ event: string; handler: (value: unknown) => void }> = [];
  constructor(url: string, options?: Record<string, unknown>) {
    RecordingRedis.last = { url, options };
  }
  eval(): Promise<unknown> {
    return Promise.resolve('settled');
  }
  ping(): Promise<string> {
    return Promise.resolve('PONG');
  }
  quit(): Promise<unknown> {
    return Promise.resolve('OK');
  }
  call(): Promise<unknown> {
    return Promise.resolve(['maxmemory-policy', 'noeviction']);
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  on(event: string, handler: (value: unknown) => void): unknown {
    RecordingRedis.listeners.push({ event, handler });
    return this;
  }
}

/** A conforming injected client. */
function injectedClient() {
  return {
    eval: () => Promise.resolve('settled'),
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve('OK'),
    call: () => Promise.resolve(['maxmemory-policy', 'noeviction']),
  };
}

describe('createRedisIdempotencyClient (M109a §3.5)', () => {
  it('passes lazyConnect and the command timeout', () => {
    createRedisIdempotencyClient(RecordingRedis as unknown as RedisCtor, 'redis://x', 15_000);
    expect(RecordingRedis.last?.url).toBe('redis://x');
    expect(RecordingRedis.last?.options).toEqual({ lazyConnect: true, commandTimeout: 15_000 });
  });

  it('omits commandTimeout at 0', () => {
    createRedisIdempotencyClient(RecordingRedis as unknown as RedisCtor, 'redis://x', 0);
    expect(RecordingRedis.last?.options).toEqual({ lazyConnect: true });
  });

  it('attaches the connection-error reporter to the client it BUILDS', () => {
    RecordingRedis.listeners = [];
    const reported: unknown[] = [];
    createRedisIdempotencyClient(RecordingRedis as unknown as RedisCtor, 'redis://x', 0, {
      report: (error) => void reported.push(error),
      recovered: () => {},
    });
    // Both events are wired: `ready` is what turns an outage into one warning
    // plus one recovery line rather than a warning per reconnect attempt.
    expect(RecordingRedis.listeners.map((entry) => entry.event)).toEqual(['error', 'ready']);
    const errorListener = RecordingRedis.listeners.find((entry) => entry.event === 'error');
    const boom = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    errorListener?.handler(boom);
    expect(reported).toEqual([boom]);
  });

  it('attaches nothing when no reporter is supplied', () => {
    RecordingRedis.listeners = [];
    createRedisIdempotencyClient(RecordingRedis as unknown as RedisCtor, 'redis://x', 0);
    expect(RecordingRedis.listeners).toEqual([]);
  });
});

describe('validateInjectedClient (M109a §3.5)', () => {
  it('accepts the four-method shape', () => {
    expect(() => validateInjectedClient(injectedClient())).not.toThrow();
  });

  it('refuses a client missing call, naming store.client', () => {
    const { call: _call, ...rest } = injectedClient();
    try {
      validateInjectedClient(rest);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IdempotencyConfigurationError);
      expect((error as IdempotencyConfigurationError).option).toBe('store.client');
    }
  });
});
