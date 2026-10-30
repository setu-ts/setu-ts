import { describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { fromNodeRedis } from '@setu-ts/common';
import type { IRateLimitRedisClient } from '../../src/stores/redis-rate-limit-store.ts';
import { nodeRedisFake } from '../../../common/test/fixtures/node-redis-fake.ts';

describe('node-redis facade assignability', () => {
  it('accepts the common adapter without a cast', () => {
    const client: IRateLimitRedisClient = fromNodeRedis(nodeRedisFake());
    expect(typeof client.quit).toBe('function');
    const realClient: typeof client = fromNodeRedis(createClient());
    expect(typeof realClient.quit).toBe('function');
  });
});
