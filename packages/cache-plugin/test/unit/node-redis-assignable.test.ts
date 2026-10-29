import { describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { fromNodeRedis } from '@setu-ts/common';
import type { IRedisClient } from '../../src/interfaces/index.ts';
import { nodeRedisFake } from '../../../common/test/fixtures/node-redis-fake.ts';

describe('node-redis facade assignability', () => {
  it('accepts the common adapter without a cast', () => {
    const client: IRedisClient = fromNodeRedis(nodeRedisFake());
    expect(typeof client.quit).toBe('function');
    const realClient: typeof client = fromNodeRedis(createClient());
    expect(typeof realClient.quit).toBe('function');
  });
});
