import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
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
    expect(first.slice(1)).toEqual([1, '3:app12:spend:tenant7:2026-01', 3, 10, 1000]);
    const hostile = "'; redis.call('FLUSHALL'); --";
    await store.reserve(hostile, '2', 3, undefined, 2000);
    expect(client.eval.mock.calls[1]![0]).toBe(first[0]);
    expect(first[0]).not.toContain(hostile);
    expect(client.eval.mock.calls[1]!.slice(1)).toEqual([
      1,
      `3:app${hostile.length}:${hostile}1:2`,
      3,
      '',
      2000,
    ]);
    await store.adjust('spend:tenant', '2026-01', -2, 1000);
    expect(client.eval.mock.calls[2]!.slice(1)).toEqual([
      1,
      '3:app12:spend:tenant7:2026-01',
      -2,
      1000,
    ]);
    await store.close();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it('keeps namespaces apart when a namespace or key contains a colon', async () => {
    // Joined with plain colons, both tuples would address `app:spend:x:y:0`.
    const { client, store } = setup();
    const other = new RedisQuotaStore({ client, namespace: 'app:spend' });
    await store.reserve('spend:x:y', '0', 1, undefined, 1000);
    await other.reserve('x:y', '0', 1, undefined, 1000);
    const [first, second] = client.eval.mock.calls.map((call) => call[2]);
    expect(first).not.toBe(second);
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

  it.each(['disconnected', 'Command timed out'])(
    'wraps reserve and adjustment backend failures without admitting and answers a value-free 503: %s (O5, F1)',
    async (message) => {
      const { client, store } = setup();
      const fault = new Error(message);
      client.eval.mockRejectedValue(fault);
      for (const operation of [
        () => store.reserve('tenant', '0', 1, 10, 1000),
        () => store.adjust('tenant', '0', -1, 1000),
      ]) {
        const rejection = operation();
        await expect(rejection).rejects.toBeInstanceOf(QuotaStoreUnavailableError);
        await expect(rejection).rejects.toMatchObject({
          name: 'QuotaStoreUnavailableError',
          cause: fault,
        });
      }
      const app = createApplication({ plugins: [RuntimePlugin()] });
      app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 1 });
      app.router.get('/quota', {
        handler: async (ctx) => {
          await store.reserve('tenant', '0', 1, 10, 1000);
          return ctx.response.text('must not run');
        },
      });
      await app.start();
      try {
        const response = await app.fetch(new Request('http://localhost/quota'));
        expect(response.status).toBe(503);
        expect(response.headers.get('content-type')).toBe('application/problem+json');
        const body = await response.text();
        expect(body).not.toContain(message);
        expect(JSON.parse(body)).toEqual({
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          detail: 'Quota storage is temporarily unavailable.',
          instance: '/quota',
        });
      } finally {
        await app.stop();
      }
    },
  );
});
