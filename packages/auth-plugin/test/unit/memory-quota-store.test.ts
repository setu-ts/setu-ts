import { describe, expect, it } from 'vitest';
import { MemoryQuotaStore } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('MemoryQuotaStore', () => {
  it('keeps a colon-bearing key apart from a colon-bearing window', async () => {
    // Joined with a plain colon, both pairs would address `a:b:c`.
    const store = new MemoryQuotaStore(createFakeRuntime(0));
    await store.reserve('a:b', 'c', 5, undefined, 1000);
    expect(await store.reserve('a', 'b:c', 1, undefined, 1000)).toEqual({
      admitted: true,
      used: 1,
    });
  });
  it('refuses unlimited reservations beyond MAX_SAFE_INTEGER without corrupting the counter (F2)', async () => {
    const store = new MemoryQuotaStore(createFakeRuntime(0));
    await store.reserve('tenant', '0', Number.MAX_SAFE_INTEGER - 1, undefined, 1000);
    expect(await store.reserve('tenant', '0', 1, undefined, 1000)).toEqual({
      admitted: true,
      used: Number.MAX_SAFE_INTEGER,
    });
    expect(await store.reserve('tenant', '0', 1, undefined, 1000)).toEqual({
      admitted: false,
      used: Number.MAX_SAFE_INTEGER,
    });
    expect(await store.reserve('tenant', '0', 0, undefined, 1000)).toEqual({
      admitted: true,
      used: Number.MAX_SAFE_INTEGER,
    });
  });
  it('clamps a settle that adds usage at MAX_SAFE_INTEGER, so the next reserve is refused (N3)', async () => {
    const store = new MemoryQuotaStore(createFakeRuntime(0));
    await store.reserve('tenant', '0', 10, undefined, 1000);
    await store.adjust('tenant', '0', Number.MAX_SAFE_INTEGER, 1000);
    expect(await store.reserve('tenant', '0', 1, undefined, 1000)).toEqual({
      admitted: false,
      used: Number.MAX_SAFE_INTEGER,
    });
  });
  it('atomically admits exactly ten of 50 concurrent reserves (O2)', async () => {
    const store = new MemoryQuotaStore(createFakeRuntime(0));
    const replies = await Promise.all(
      Array.from({ length: 50 }, () => store.reserve('spend:tenant', '0', 1, 10, 1000)),
    );
    expect(replies.filter((reply) => reply.admitted)).toHaveLength(10);
    expect((await store.reserve('spend:tenant', '0', 0, 10, 1000)).used).toBe(10);
  });

  it('floors refunds at zero and records unlimited reservations', async () => {
    const store = new MemoryQuotaStore(createFakeRuntime(0));
    await store.adjust('tenant', '0', -10, 1000);
    expect(await store.reserve('tenant', '0', 2, undefined, 1000)).toEqual({
      admitted: true,
      used: 2,
    });
    await store.adjust('tenant', '0', -100, 1000);
    expect(await store.reserve('tenant', '0', 0, 0, 1000)).toEqual({ admitted: true, used: 0 });
  });

  it('reclaims expired windows in amortised sweeps, not on every call (O7)', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryQuotaStore(runtime);
    for (let i = 0; i < 1_023; i++) await store.reserve(`tenant-${i}`, '0', 1, 10, 1000);
    runtime.setNow(1000);
    // Below the sweep threshold an expired window still reads as empty.
    expect(await store.reserve('tenant-0', '0', 10, 10, 2000)).toEqual({
      admitted: true,
      used: 10,
    });
    // Reaching the threshold sweeps the expired windows; the live one survives.
    await store.reserve('tenant-new', '0', 1, 10, 2000);
    expect((await store.reserve('tenant-0', '0', 0, 10, 2000)).used).toBe(10);
    expect((await store.reserve('tenant-5', '0', 0, 10, 2000)).used).toBe(0);
  });

  it('sweeps expired windows on both reserve and adjust (O7)', async () => {
    const runtime = createFakeRuntime(0);
    const store = new MemoryQuotaStore(runtime);
    await store.reserve('tenant', '0', 10, 10, 1000);
    runtime.setNow(1000);
    expect(await store.reserve('tenant', '0', 1, 10, 2000)).toEqual({ admitted: true, used: 1 });
    runtime.setNow(2000);
    await store.adjust('tenant', '0', 2, 3000);
    expect((await store.reserve('tenant', '0', 0, 10, 3000)).used).toBe(2);
  });
});
