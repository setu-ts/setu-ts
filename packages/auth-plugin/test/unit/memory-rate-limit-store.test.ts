/**
 * Unit tests for MemoryRateLimitStore.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MemoryRateLimitStore } from '../../src/stores/rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

Deno.test('MemoryRateLimitStore — increment returns count and resetTime', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRateLimitStore(runtime);

  const result = await store.increment('key-1', 60000);

  assertEquals(result.count, 1);
  assertEquals(result.resetTime, runtime.now() + 60000);
});

Deno.test('MemoryRateLimitStore — subsequent increments increase count', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRateLimitStore(runtime);

  const r1 = await store.increment('key-1', 60000);
  assertEquals(r1.count, 1);

  const r2 = await store.increment('key-1', 60000);
  assertEquals(r2.count, 2);
  assertEquals(r2.resetTime, r1.resetTime); // Same window
});

Deno.test('MemoryRateLimitStore — window resets when time advances past windowMs', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRateLimitStore(runtime);

  const r1 = await store.increment('key-1', 60000);
  assertEquals(r1.count, 1);

  // Advance past window
  runtime.setNow(r1.resetTime + 1);

  const r2 = await store.increment('key-1', 60000);
  assertEquals(r2.count, 1); // New window
});

Deno.test('MemoryRateLimitStore — reset clears the counter', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRateLimitStore(runtime);

  await store.increment('key-1', 60000);
  await store.reset('key-1');

  const r = await store.increment('key-1', 60000);
  assertEquals(r.count, 1);
});

Deno.test('MemoryRateLimitStore — different keys are independent', async () => {
  const runtime = createFakeRuntime();
  const store = new MemoryRateLimitStore(runtime);

  const r1 = await store.increment('key-a', 60000);
  const r2 = await store.increment('key-b', 60000);

  assertEquals(r1.count, 1);
  assertEquals(r2.count, 1);
});
