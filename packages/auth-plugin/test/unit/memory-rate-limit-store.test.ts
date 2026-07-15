/**
 * Unit tests for MemoryRateLimitStore.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryRateLimitStore } from '../../src/stores/rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryRateLimitStore', () => {
  it('increment returns count and resetTime = windowStart + windowMs', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRateLimitStore(runtime);

    const result = await store.increment('key-1', 60000);

    expect(result.count).toBe(1);
    expect(result.resetTime).toBe(runtime.now() + 60000);
  });

  it('subsequent increments increase count within the same window', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRateLimitStore(runtime);

    const r1 = await store.increment('key-1', 60000);
    expect(r1.count).toBe(1);

    const r2 = await store.increment('key-1', 60000);
    expect(r2.count).toBe(2);
    expect(r2.resetTime).toBe(r1.resetTime); // Same window

    const r3 = await store.increment('key-1', 60000);
    expect(r3.count).toBe(3);
  });

  it('window resets to count 1 with a fresh resetTime when time advances past windowMs', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRateLimitStore(runtime);

    const r1 = await store.increment('key-1', 60000);
    expect(r1.count).toBe(1);

    // Advance exactly to the window boundary (windowStart + windowMs <= now resets)
    runtime.setNow(r1.resetTime);

    const r2 = await store.increment('key-1', 60000);
    expect(r2.count).toBe(1); // New window
    expect(r2.resetTime).toBe(runtime.now() + 60000);
    expect(r2.resetTime).not.toBe(r1.resetTime);
  });

  it('reset clears the counter', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRateLimitStore(runtime);

    await store.increment('key-1', 60000);
    await store.increment('key-1', 60000);
    await store.reset('key-1');

    const r = await store.increment('key-1', 60000);
    expect(r.count).toBe(1);
  });

  it('different keys are independent', async () => {
    const runtime = createFakeRuntime();
    const store = new MemoryRateLimitStore(runtime);

    await store.increment('key-a', 60000);
    const rA = await store.increment('key-a', 60000);
    const rB = await store.increment('key-b', 60000);

    expect(rA.count).toBe(2);
    expect(rB.count).toBe(1);
  });
});
