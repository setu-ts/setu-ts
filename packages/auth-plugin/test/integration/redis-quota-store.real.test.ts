import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RedisQuotaStore } from '../../src/index.ts';
import { quotaStoreKey } from '../../src/quota/store-key.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const url = process.env['REDIS_URL'];
describe.skipIf(!url)('RedisQuotaStore real Redis (O2)', () => {
  let client: Redis;
  let store: RedisQuotaStore;
  const runtime = createFakeRuntime();
  const namespace = `m134-${runtime.uuid()}`;
  beforeAll(() => {
    client = new Redis(url!);
    store = new RedisQuotaStore({ client, namespace });
  });
  afterAll(async () => {
    await store.close();
  });

  it('admits exactly one concurrent reservation over the last unit and exposes refunds', async () => {
    const expiry = runtime.now() + 60_000;
    const results = await Promise.all([
      store.reserve('spend:tenant', '0', 1, 1, expiry),
      store.reserve('spend:tenant', '0', 1, 1, expiry),
    ]);
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    await store.adjust('spend:tenant', '0', -1, expiry);
    expect((await store.reserve('spend:tenant', '0', 1, 1, expiry)).admitted).toBe(true);
    await client.del(quotaStoreKey(namespace, 'spend:tenant', '0'));
  });

  it('expires keys at the absolute deadline', async () => {
    await store.reserve('spend:expiry', '0', 1, 1, runtime.now() - 1);
    expect(await client.exists(quotaStoreKey(namespace, 'spend:expiry', '0'))).toBe(0);
  });

  it('refuses unlimited reservations beyond MAX_SAFE_INTEGER without a 503 (F2)', async () => {
    const key = quotaStoreKey(namespace, 'spend:safe', '0');
    const expiry = runtime.now() + 60_000;
    try {
      await store.reserve('spend:safe', '0', Number.MAX_SAFE_INTEGER - 1, undefined, expiry);
      expect(await store.reserve('spend:safe', '0', 1, undefined, expiry)).toEqual({
        admitted: true,
        used: Number.MAX_SAFE_INTEGER,
      });
      expect(await store.reserve('spend:safe', '0', 1, undefined, expiry)).toEqual({
        admitted: false,
        used: Number.MAX_SAFE_INTEGER,
      });
      expect(await client.get(key)).toBe(String(Number.MAX_SAFE_INTEGER));
      expect((await store.reserve('spend:safe', '0', 0, undefined, expiry)).admitted).toBe(true);
    } finally {
      await client.del(key);
    }
  });
  it('clamps a settle that adds usage at MAX_SAFE_INTEGER, so the next reserve is refused, not a 503 (N3)', async () => {
    const key = quotaStoreKey(namespace, 'spend:clamp', '0');
    const expiry = runtime.now() + 60_000;
    try {
      await store.reserve('spend:clamp', '0', 10, undefined, expiry);
      await store.adjust('spend:clamp', '0', Number.MAX_SAFE_INTEGER, expiry);
      expect(await client.get(key)).toBe(String(Number.MAX_SAFE_INTEGER));
      expect(await store.reserve('spend:clamp', '0', 1, undefined, expiry)).toEqual({
        admitted: false,
        used: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      await client.del(key);
    }
  });
});
