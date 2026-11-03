import { describe, expect, it, vi } from 'vitest';
import { RedisQuotaStore, QuotaStoreUnavailableError } from '../../src/index.ts';
import type { IQuotaRedisClient } from '../../src/index.ts';

function setup(reply: unknown = [1, 3]) {
  const client = {
    eval: vi.fn<IQuotaRedisClient['eval']>().mockResolvedValue(reply),
    quit: vi.fn().mockResolvedValue('OK'),
  };
  return { client, store: new RedisQuotaStore({ client, namespace: 'app' }) };
}

describe('RedisQuotaStore', () => {
  it('passes keys and values through KEYS/ARGV and keeps script text constant (O6)', async () => {
    const { client, store } = setup();
    expect(await store.reserve('spend:tenant', '2026-01', 3, 10, 1000)).toEqual({
      admitted: true,
      used: 3,
    });
    const first = client.eval.mock.calls[0]!;
    expect(first.slice(1)).toEqual([1, 'app:spend:tenant:2026-01', 3, 10, 1000]);
    const hostile = "'; redis.call('FLUSHALL'); --";
    await store.reserve(hostile, '2', 3, undefined, 2000);
    expect(client.eval.mock.calls[1]![0]).toBe(first[0]);
    expect(first[0]).not.toContain(hostile);
    expect(client.eval.mock.calls[1]!.slice(1)).toEqual([1, `app:${hostile}:2`, 3, '', 2000]);
    await store.adjust('spend:tenant', '2026-01', -2, 1000);
    expect(client.eval.mock.calls[2]!.slice(1)).toEqual([1, 'app:spend:tenant:2026-01', -2, 1000]);
    await store.close();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it('returns a refused reply', async () => {
    expect(await setup([0, 10]).store.reserve('tenant', '0', 1, 10, 1000)).toEqual({
      admitted: false,
      used: 10,
    });
  });

  it.each([null, [], [2, 1], [1, -1], [1, 1.2], [1, '2']])(
    'fails closed for unreadable reply %j',
    async (reply) => {
      await expect(setup(reply).store.reserve('tenant', '0', 1, 10, 1000)).rejects.toBeInstanceOf(
        QuotaStoreUnavailableError,
      );
    },
  );

  it('refuses clients missing eval or quit and empty namespaces', () => {
    for (const client of [null, {}, { quit: async () => {} }, { eval: async () => {} }]) {
      expect(
        () => new RedisQuotaStore({ client: client as IQuotaRedisClient, namespace: 'app' }),
      ).toThrow(TypeError);
    }
    expect(
      () =>
        new RedisQuotaStore({
          client: { quit: async () => {} } as IQuotaRedisClient,
          namespace: 'app',
        }),
    ).toThrow('eval');
    expect(() => new RedisQuotaStore({ client: setup().client, namespace: '' })).toThrow(
      'namespace',
    );
  });

  it('wraps reserve and adjustment backend failures without admitting (O5)', async () => {
    const { client, store } = setup();
    const fault = new Error('disconnected');
    client.eval.mockRejectedValue(fault);
    for (const operation of [
      () => store.reserve('tenant', '0', 1, 10, 1000),
      () => store.adjust('tenant', '0', -1, 1000),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        name: 'QuotaStoreUnavailableError',
        cause: fault,
      });
    }
  });
});
