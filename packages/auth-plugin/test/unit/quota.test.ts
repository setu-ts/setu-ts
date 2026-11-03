/* eslint-disable require-await -- Test doubles preserve asynchronous provider and service contracts. */
import { describe, expect, it, vi } from 'vitest';
import { createQuota, MemoryQuotaStore, QuotaExceededError } from '../../src/index.ts';
import type { IQuotaStore, QuotaOptions } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function setup(overrides: Partial<QuotaOptions> = {}) {
  const runtime = createFakeRuntime(Date.UTC(2026, 0, 31, 23, 59, 59, 999));
  const store = new MemoryQuotaStore(runtime);
  const options = {
    name: 'spend',
    limit: 10,
    window: 'utc-day' as const,
    store,
    runtime,
    ...overrides,
  };
  return { quota: createQuota(options), runtime, store, options };
}

describe('createQuota', () => {
  it('admits at the boundary, refuses above it, and freezes receipts', async () => {
    const { quota } = setup();
    const receipt = await quota.reserve('tenant', 10);
    expect(receipt).toEqual({ key: 'tenant', amount: 10, windowId: '2026-01-31' });
    expect(Object.isFrozen(receipt)).toBe(true);
    await expect(quota.reserve('tenant', 1)).rejects.toMatchObject({
      name: 'spend',
      retryAfterSeconds: 1,
    });
    await expect(quota.reserve('other', 10)).resolves.toMatchObject({ amount: 10 });
  });

  it('refunds, adds extra usage and settles/releases only once, including concurrently', async () => {
    const { quota } = setup();
    const receipt = await quota.reserve('tenant', 8);
    await Promise.all([quota.settle(receipt, 4), quota.release(receipt)]);
    const extra = await quota.reserve('tenant', 6);
    await quota.settle(extra, 8);
    await expect(quota.reserve('tenant', 0)).rejects.toBeInstanceOf(QuotaExceededError);
    await quota.release(extra);
    await expect(quota.reserve('tenant', 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('release makes the held units available again', async () => {
    const { quota } = setup();
    await quota.release(await quota.reserve('tenant', 10));
    await expect(quota.reserve('tenant', 10)).resolves.toMatchObject({ amount: 10 });
  });

  it('refuses forged and foreign reservations without touching storage (O4)', async () => {
    const adjust = vi.fn<IQuotaStore['adjust']>().mockResolvedValue();
    const { quota, options } = setup();
    const foreign = await quota.reserve('tenant', 10);
    const other = createQuota({ ...options, store: { reserve: vi.fn(), adjust } });
    for (const receipt of [
      foreign,
      { ...foreign },
      Object.freeze({ key: 'tenant', windowId: '2026-01-31', amount: 100 }),
    ]) {
      await expect(other.settle(receipt, 0)).rejects.toThrow(TypeError);
      await expect(other.release(receipt)).rejects.toThrow(TypeError);
    }
    expect(adjust).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, 2 ** 53, 2 ** 53 + 2])(
    'refuses hostile units %s before the store (O3)',
    async (amount) => {
      const { options } = setup();
      const reserve = vi
        .fn<IQuotaStore['reserve']>()
        .mockResolvedValue({ admitted: true, used: 0 });
      const adjust = vi.fn<IQuotaStore['adjust']>().mockResolvedValue();
      const quota = createQuota({ ...options, store: { reserve, adjust } });
      await expect(quota.reserve('tenant', amount)).rejects.toThrow(TypeError);
      expect(reserve).not.toHaveBeenCalled();
      const receipt = await quota.reserve('tenant', 1);
      await expect(quota.settle(receipt, amount)).rejects.toThrow(TypeError);
      expect(adjust).not.toHaveBeenCalled();
      expect(() => createQuota({ ...options, limit: amount })).toThrow(TypeError);
      reserve.mockClear();
      await expect(
        createQuota({ ...options, store: { reserve, adjust }, limit: () => amount }).reserve(
          'tenant',
          1,
        ),
      ).rejects.toThrow(TypeError);
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('bounds keys in UTF-8 bytes (O7)', async () => {
    const { quota } = setup();
    for (const key of ['', 'x'.repeat(513), 'é'.repeat(257)])
      await expect(quota.reserve(key, 0)).rejects.toThrow(TypeError);
    await expect(quota.reserve('é'.repeat(256), 0)).resolves.toMatchObject({ amount: 0 });
  });

  it('propagates throwing/rejecting callbacks without reserving and records unlimited usage', async () => {
    const { options } = setup();
    const reserve = vi.fn<IQuotaStore['reserve']>().mockResolvedValue({ admitted: true, used: 1 });
    const adjust = vi.fn<IQuotaStore['adjust']>().mockResolvedValue();
    const fault = new Error('limit unavailable');
    for (const limit of [
      () => {
        throw fault;
      },
      () => Promise.reject(fault),
    ]) {
      await expect(
        createQuota({ ...options, store: { reserve, adjust }, limit }).reserve('tenant', 1),
      ).rejects.toBe(fault);
    }
    expect(reserve).not.toHaveBeenCalled();
    const quota = createQuota({
      ...options,
      store: { reserve, adjust },
      limit: async (key) => {
        expect(key).toBe('tenant');
        return undefined;
      },
    });
    const receipt = await quota.reserve('tenant', 1);
    expect(reserve.mock.calls[0]?.[3]).toBeUndefined();
    await quota.settle(receipt, 3);
    expect(adjust).toHaveBeenCalledWith('spend:tenant', '2026-01-31', 2, Date.UTC(2026, 1, 2));
  });

  it.each(['utc-day', 'utc-month', 1000] as const)(
    'keeps settlement in the reserved %s window across its boundary',
    async (window) => {
      const { options, runtime, store } = setup({ window });
      const adjust = vi.spyOn(store, 'adjust');
      const quota = createQuota(options);
      const receipt = await quota.reserve('tenant', 10);
      runtime.setNow(Date.UTC(2026, 1, 1));
      const next = await quota.reserve('tenant', 10);
      expect(next.windowId).not.toBe(receipt.windowId);
      expect(next.windowId).toBe(
        window === 'utc-day'
          ? '2026-02-01'
          : window === 'utc-month'
            ? '2026-02'
            : String(Math.floor(runtime.now() / 1000)),
      );
      await quota.release(receipt);
      expect(adjust.mock.calls[0]?.[1]).toBe(receipt.windowId);
      await expect(quota.reserve('tenant', 1)).rejects.toBeInstanceOf(QuotaExceededError);
    },
  );

  it('isolates named policies sharing one store', async () => {
    const { quota, options } = setup();
    await quota.reserve('tenant', 10);
    await expect(
      createQuota({ ...options, name: 'other' }).reserve('tenant', 10),
    ).resolves.toBeDefined();
  });

  it('validates policy names and windows once at construction', () => {
    const { options } = setup();
    for (const name of ['', 'Upper', 'a:b', 'a b'])
      expect(() => createQuota({ ...options, name })).toThrow(TypeError);
    for (const window of [0, -1, 0.5, NaN, Infinity, 2 ** 53])
      expect(() => createQuota({ ...options, window })).toThrow(TypeError);
  });
});
