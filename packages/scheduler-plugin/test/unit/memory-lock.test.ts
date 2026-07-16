/**
 * Tests for MemoryLock.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryLock', () => {
  function createLock() {
    const runtime = new FakeRuntime();
    return { lock: new MemoryLock(runtime), runtime };
  }

  it('acquires lock on free key', async () => {
    const { lock } = createLock();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('returns null for held key', async () => {
    const { lock } = createLock();
    await lock.acquire('key1', 5000);
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeNull();
  });

  it('allows re-acquire after release', async () => {
    const { lock } = createLock();
    const token1 = await lock.acquire('key1', 5000);
    expect(token1).toBeTruthy();
    await lock.release('key1', token1!);
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeTruthy();
  });

  it('allows acquire after TTL expires', async () => {
    const { lock, runtime } = createLock();
    const token1 = await lock.acquire('key1', 5000);
    expect(token1).toBeTruthy();
    // Advance past TTL
    runtime.advance(6000);
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeTruthy();
  });

  it('does not free key with mismatched token', async () => {
    const { lock } = createLock();
    await lock.acquire('key1', 5000);
    await lock.release('key1', 'wrong-token');
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeNull();
  });

  it('keeps distinct keys independent', async () => {
    const { lock } = createLock();
    const t1 = await lock.acquire('key1', 5000);
    const t2 = await lock.acquire('key2', 5000);
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
  });
});
