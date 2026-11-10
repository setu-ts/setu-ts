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
  it.each(['utc-day', 'utc-month', 1000] as const)(
    'M139c reads settled usage and a new %s window without charging',
    async (window) => {
      const { quota, runtime, store } = setup({ limit: 100, window });
      const reserve = vi.spyOn(store, 'reserve');
      await quota.settle(await quota.reserve('tenant', 40), 30);
      const end = window === 1000 ? Math.ceil(runtime.now() / 1000) * 1000 : Date.UTC(2026, 1, 1);
      expect(await quota.usage('tenant')).toEqual({
        used: 30,
        limit: 100,
        remaining: 70,
        windowEndsAt: end,
      });
      expect(await quota.usage('other')).toMatchObject({ used: 0, remaining: 100 });
      expect(await quota.usage('tenant')).toMatchObject({ used: 30 });
      expect(reserve).toHaveBeenCalledOnce();
      runtime.setNow(end);
      expect(await quota.usage('tenant')).toMatchObject({ used: 0, remaining: 100 });
    },
  );
  it('M139c resolves callback limits, clamps remaining and shares policy/key storage', async () => {
    let limit: number | undefined = 100;
    const callback = vi.fn((key: string) => {
      expect(key).toBe('tenant');
      return Promise.resolve(limit);
    });
    const { quota, options } = setup({ limit: callback });
    await quota.reserve('tenant', 40);
    limit = 10;
    expect(await quota.usage('tenant')).toMatchObject({ used: 40, limit: 10, remaining: 0 });
    limit = undefined;
    expect(await quota.usage('tenant')).toMatchObject({
      used: 40,
      limit: undefined,
      remaining: undefined,
    });
    expect(callback).toHaveBeenCalledTimes(3);
    expect(await createQuota({ ...options, name: 'other' }).usage('tenant')).toMatchObject({
      used: 0,
    });
    limit = -1;
    await expect(quota.usage('tenant')).rejects.toThrow(TypeError);
    const error = new Error('limit lookup failed');
    await expect(
      createQuota({ ...options, limit: () => Promise.reject(error) }).usage('tenant'),
    ).rejects.toBe(error);
  });
  it('M139c uses one key refusal table through reserve and usage before storage', async () => {
    const { quota, store } = setup();
    const read = vi.spyOn(store, 'read');
    const reserve = vi.spyOn(store, 'reserve');
    for (const key of ['', 'x'.repeat(513), 'é'.repeat(257), '\ud800', null, 1]) {
      for (const call of [() => quota.reserve(key as string, 0), () => quota.usage(key as string)])
        await expect(call()).rejects.toThrow(
          'Quota key must be well-formed, non-empty and at most 512 UTF-8 bytes',
        );
    }
    expect(read).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    await quota.reserve('é'.repeat(256), 1);
    expect(await quota.usage('é'.repeat(256))).toMatchObject({ used: 1 });
  });
  it('admits at the boundary, refuses above it, and freezes receipts', async () => {
    const { quota } = setup();
    const receipt = await quota.reserve('tenant', 10);
    expect(receipt).toEqual({ key: 'tenant', amount: 10, windowId: '2026-01-31' });
    expect(Object.isFrozen(receipt)).toBe(true);
    await expect(quota.reserve('tenant', 1)).rejects.toMatchObject({
      name: 'QuotaExceededError',
      policyName: 'spend',
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
    const other = createQuota({
      ...options,
      store: { read: vi.fn().mockResolvedValue(0), reserve: vi.fn(), adjust },
    });
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
      const quota = createQuota({
        ...options,
        store: { read: vi.fn().mockResolvedValue(0), reserve, adjust },
      });
      await expect(quota.reserve('tenant', amount)).rejects.toThrow(TypeError);
      expect(reserve).not.toHaveBeenCalled();
      const receipt = await quota.reserve('tenant', 1);
      await expect(quota.settle(receipt, amount)).rejects.toThrow(TypeError);
      expect(adjust).not.toHaveBeenCalled();
      expect(() => createQuota({ ...options, limit: amount })).toThrow(TypeError);
      reserve.mockClear();
      await expect(
        createQuota({
          ...options,
          store: { read: vi.fn().mockResolvedValue(0), reserve, adjust },
          limit: () => amount,
        }).reserve('tenant', 1),
      ).rejects.toThrow(TypeError);
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it('bounds keys in UTF-8 bytes (O7)', async () => {
    const { quota } = setup();
    for (const key of ['', 'x'.repeat(513), 'é'.repeat(257), '\uD800'])
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
        createQuota({
          ...options,
          store: { read: vi.fn().mockResolvedValue(0), reserve, adjust },
          limit,
        }).reserve('tenant', 1),
      ).rejects.toBe(fault);
    }
    expect(reserve).not.toHaveBeenCalled();
    const quota = createQuota({
      ...options,
      store: { read: vi.fn().mockResolvedValue(0), reserve, adjust },
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
