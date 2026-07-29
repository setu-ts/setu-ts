/**
 * Tests for the ioredis injection seam.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptRedisModule,
  RedisModuleError,
  toRedisLoadFailure,
} from '../../src/transports/redis-module.ts';

/** A stand-in for the ioredis class. */
class FakeRedis {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

describe('adaptRedisModule', () => {
  it('adapts a module exposing a default export', () => {
    const module = adaptRedisModule({ default: FakeRedis });
    const client = module.create('redis://localhost:6379') as unknown as FakeRedis;
    expect(client.url).toBe('redis://localhost:6379');
  });

  it('adapts a module exposing a named Redis export', () => {
    // Deno's npm interop surfaces the class under `Redis` rather than `default`
    // depending on how the package is consumed; both must work.
    const module = adaptRedisModule({ Redis: FakeRedis });
    const client = module.create('redis://host') as unknown as FakeRedis;
    expect(client.url).toBe('redis://host');
  });

  it('prefers the default export when both are present', () => {
    class Other {
      readonly url: string;
      constructor(url: string) {
        this.url = `other:${url}`;
      }
    }
    const module = adaptRedisModule({ default: FakeRedis, Redis: Other });
    const client = module.create('u') as unknown as FakeRedis;
    expect(client.url).toBe('u');
  });

  it('throws for a non-object module', () => {
    expect(() => adaptRedisModule('nope')).toThrow(RedisModuleError);
    expect(() => adaptRedisModule(null)).toThrow(RedisModuleError);
  });

  it('throws when neither a default nor a Redis constructor is exposed', () => {
    let caught: unknown;
    try {
      adaptRedisModule({ somethingElse: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof RedisModuleError).toBe(true);
    expect((caught as Error).message).toContain('neither a default export nor a Redis constructor');
  });
});

describe('toRedisLoadFailure', () => {
  it('passes an adaptation failure through unchanged', () => {
    const original = new RedisModuleError('bad module');
    expect(toRedisLoadFailure(original)).toBe(original);
  });

  it('wraps a resolution failure with installation guidance', () => {
    const wrapped = toRedisLoadFailure(new Error('Module not found "npm:ioredis"'));
    expect(wrapped).toBeInstanceOf(RedisModuleError);
    expect(wrapped.message).toContain('Install it to use the');
    expect(wrapped.message).toContain('Module not found');
  });

  it('stringifies a non-Error cause', () => {
    expect(toRedisLoadFailure('denied').message).toContain('Cause: denied');
  });
});
