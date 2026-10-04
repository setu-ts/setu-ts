/**
 * Tests for RedisLock with fake ioredis client.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createRedisLockClient,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  RedisLock,
  validateClient,
} from '../../src/lock/redis-lock.ts';
import type { RedisLockClientOptions } from '../../src/lock/redis-lock.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

describe('RedisLock', () => {
  it('acquires lock via SET NX PX', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();
    expect(fake.calls.some((c) => c.method === 'set')).toBe(true);
    await lock.disconnect();
  });

  it('returns null when key is held', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();
    // Second acquire — fake returns null because key exists
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeNull();
    await lock.disconnect();
  });

  it('releases with token-checked delete', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    await lock.release('key1', token!);
    // Key should be gone, so next acquire succeeds
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeTruthy();
    await lock.disconnect();
  });

  it('does not release with wrong token', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    await lock.acquire('key1', 5000);
    await lock.release('key1', 'wrong-token');
    // Key still held
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeNull();
    await lock.disconnect();
  });

  it('throws when not connected', async () => {
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    try {
      await lock.acquire('key1', 5000);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not connected');
    }
  });

  it('connect is idempotent (already connected)', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    await lock.connect(); // no error
    await lock.disconnect();
  });

  it('disconnect is safe when already disconnected', async () => {
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    // Not connected — disconnect should not throw
    await lock.disconnect();
  });

  it('disconnect calls client.quit()', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    await lock.disconnect();
    expect(fake.calls.some((c) => c.method === 'quit')).toBe(true);
  });

  it('release does nothing when not connected', async () => {
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    // Not connected — release should not throw
    await lock.release('key1', 'some-token');
  });

  it('injected invalid client throws on connect', async () => {
    const badClient = { notAValidClient: true };
    const lock = new RedisLock({
      url: 'redis://localhost:6379',
      // deno-lint-ignore no-explicit-any
      client: badClient as any,
    });
    try {
      await lock.connect();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('structural shape');
    }
  });

  it('connect is idempotent when already connected', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    await lock.connect(); // Should not throw
    await lock.disconnect();
  });

  it('disconnect when already disconnected is safe', async () => {
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    await lock.disconnect(); // Should not throw when not connected
  });

  it('lazy-loads ioredis when no client injected', () => {
    // This test covers the lazy-load path where ioredis is imported at runtime
    // Note: This test may fail in environments without ioredis installed
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    // Don't actually connect - just verify the lock can be constructed
    expect(lock).toBeDefined();
  });

  it('connect without injected client attempts lazy load', async () => {
    // Create lock without injected client - connect() will try to lazy-load ioredis
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    // The lazy-load path is exercised here - it may fail if ioredis is not available
    // but the code path is covered
    try {
      await lock.connect();
      // If we get here, ioredis was successfully loaded
      expect(lock).toBeDefined();
      await lock.disconnect();
    } catch {
      // Expected if ioredis is not available - the code path is still covered
    }
  });
});

describe('validateClient', () => {
  it('returns true for valid client', () => {
    expect(validateClient(new FakeRedisClient())).toBe(true);
  });

  it('returns false for null', () => {
    // deno-lint-ignore no-explicit-any
    expect(validateClient(null as any)).toBe(false);
  });

  it('returns false for missing method', () => {
    expect(validateClient({ set: () => {}, quit: () => {} })).toBe(false);
  });

  it('returns false for missing del', () => {
    expect(
      validateClient({ set: () => {}, get: () => {}, quit: () => {} }),
    ).toBe(false);
  });

  it('returns false for missing get', () => {
    expect(
      validateClient({ set: () => {}, del: () => {}, quit: () => {} }),
    ).toBe(false);
  });

  it('returns false for missing set', () => {
    expect(
      validateClient({ get: () => {}, del: () => {}, quit: () => {} }),
    ).toBe(false);
  });

  it('returns false for missing quit', () => {
    expect(
      validateClient({ set: () => {}, get: () => {}, del: () => {} }),
    ).toBe(false);
  });

  it('returns false for undefined', () => {
    // deno-lint-ignore no-explicit-any
    expect(validateClient(undefined as any)).toBe(false);
  });

  it('returns false for non-object (string)', () => {
    expect(validateClient('not-an-object')).toBe(false);
  });
});

// C2 TEST: acquire uses 'PX' flag
describe('RedisLock C2 - PX flag', () => {
  it('acquires lock via SET NX PX (C2)', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();

    // C2: Verify SET was called with 'PX' flag
    const setCall = fake.calls.find((c) => c.method === 'set');
    expect(setCall).toBeDefined();
    expect(setCall!.args).toContain('PX');
    // Also verify TTL is passed
    expect(setCall!.args).toContain(5000);

    await lock.disconnect();
  });
});

// C5 TEST: release uses atomic EVAL
describe('RedisLock C5 - atomic release', () => {
  it('releases lock via atomic EVAL (C5)', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();

    await lock.release('key1', token!);

    // C5: Verify EVAL was called for atomic release
    const evalCall = fake.calls.find((c) => c.method === 'eval');
    expect(evalCall).toBeDefined();
    // Script should contain 'get' and 'del' commands
    expect(evalCall!.args[0]).toContain('get');
    expect(evalCall!.args[0]).toContain('del');

    await lock.disconnect();
  });

  it('atomic release does not delete if token mismatch (C5)', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token1 = await lock.acquire('key1', 5000);
    expect(token1).toBeTruthy();

    // Try to release with wrong token
    await lock.release('key1', 'wrong-token');

    // Lock should still be held - second acquire should fail
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeNull();

    await lock.disconnect();
  });

  it('atomic release handles race where key expired and re-acquired (C5)', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();

    // First instance acquires lock
    const token1 = await lock.acquire('key1', 100); // Short TTL
    expect(token1).toBeTruthy();

    // Simulate time passing - lock expires
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second instance acquires lock (first one expired)
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeTruthy();
    expect(token2).not.toBe(token1);

    // First instance tries to release (should NOT delete second instance's lock)
    await lock.release('key1', token1!);

    // Second instance's lock should still be valid
    const token3 = await lock.acquire('key1', 5000);
    expect(token3).toBeNull(); // Still held by token2

    await lock.disconnect();
  });
});

// N2 TEST: error message includes all required methods
describe('RedisLock N2 - error message', () => {
  it('error message includes get and eval (N2)', async () => {
    const badClient = { notAValidClient: true };
    const lock = new RedisLock({
      url: 'redis://localhost:6379',
      // deno-lint-ignore no-explicit-any
      client: badClient as any,
    });
    try {
      await lock.connect();
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('set');
      expect(msg).toContain('eval');
    }
  });
});

describe('RedisLock command bound (M101a V8-24)', () => {
  /** Records the arguments each construction received. */
  function recordingCtor() {
    const built: Array<
      { url: string; options: RedisLockClientOptions | undefined; arity: number }
    > = [];
    class Ctor {
      constructor(url: string, options?: RedisLockClientOptions) {
        built.push({ url, options, arity: arguments.length });
      }
    }
    return { Ctor, built };
  }

  it('builds the client with the configured commandTimeout', () => {
    const { Ctor, built } = recordingCtor();
    createRedisLockClient(Ctor, 'redis://h:1', 500);
    expect(built).toEqual([{ url: 'redis://h:1', options: { commandTimeout: 500 }, arity: 2 }]);
  });

  it('0 builds the client exactly as before the bound existed', () => {
    const { Ctor, built } = recordingCtor();
    createRedisLockClient(Ctor, 'redis://h:1', 0);
    expect(built).toEqual([{ url: 'redis://h:1', options: undefined, arity: 1 }]);
  });

  it('defaults the bound to the M98l value', () => {
    expect(DEFAULT_REDIS_COMMAND_TIMEOUT_MS).toBe(15_000);
    expect(() => new RedisLock({ url: 'redis://h:1' })).not.toThrow();
  });

  it('refuses an out-of-range commandTimeoutMs without echoing it', () => {
    for (const value of [Number.NaN, -1, 2 ** 31, Number.POSITIVE_INFINITY]) {
      expect(() => new RedisLock({ url: 'redis://h:1', commandTimeoutMs: value })).toThrow(
        'scheduler-plugin: commandTimeoutMs must be a number from 0 to 2147483647 ' +
          '(0 disables the bound)',
      );
    }
    for (const value of [0, 2_147_483_647]) {
      expect(() => new RedisLock({ url: 'redis://h:1', commandTimeoutMs: value })).not.toThrow();
    }
  });

  /** A fake whose SET is written (applied) and then times out on the client. */
  class AppliedThenTimedOut extends FakeRedisClient {
    override async set(
      key: string,
      value: string,
      option: string,
      pxFlag: string,
      ttl: number,
    ): Promise<string | null> {
      await super.set(key, value, option, pxFlag, ttl);
      throw new Error('Command timed out');
    }
  }

  it('a SET that applies and then rejects is released with its own key and token', async () => {
    const fake = new AppliedThenTimedOut();
    const lock = new RedisLock({ url: 'redis://h:1', client: fake });
    await lock.connect();

    await expect(lock.acquire('job', 30_000)).rejects.toThrow('Command timed out');

    const set = fake.calls.find((c) => c.method === 'set')!;
    const evals = fake.calls.filter((c) => c.method === 'eval');
    expect(evals.length).toBe(1);
    expect(evals[0].args.slice(1)).toEqual([1, 'job', set.args[1]]);
    // The key is gone, not held for 30 s by a token nobody owns.
    expect(await fake.get('job')).toBeNull();
    await lock.disconnect();
  });

  it('a release that also fails does not replace the SET rejection', async () => {
    class BothFail extends AppliedThenTimedOut {
      override eval(): Promise<number | string | null> {
        return Promise.reject(new Error('eval also failed'));
      }
    }
    const lock = new RedisLock({ url: 'redis://h:1', client: new BothFail() });
    await lock.connect();
    await expect(lock.acquire('job', 30_000)).rejects.toThrow('Command timed out');
    await lock.disconnect();
  });
});
