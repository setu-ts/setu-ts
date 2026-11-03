import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RedisQuotaStore } from '../../src/index.ts';
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
    await client.del(`${namespace}:spend:tenant:0`);
  });

  it('expires keys at the absolute deadline', async () => {
    await store.reserve('spend:expiry', '0', 1, 1, runtime.now() - 1);
    expect(await client.exists(`${namespace}:spend:expiry:0`)).toBe(0);
  });
});
