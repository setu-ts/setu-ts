import { describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { fromNodeRedis } from '../../src/index.ts';
import type { NodeRedisAdapter, NodeRedisClientLike } from '../../src/index.ts';

describe('node-redis real client types', () => {
  it('accepts default RESP3 and RESP2 clients without casts', () => {
    const clients: NodeRedisClientLike[] = [createClient(), createClient({ RESP: 2 })];
    for (const client of clients) {
      const adapter: NodeRedisAdapter = fromNodeRedis(client);
      expect(adapter.status).toBe('wait');
    }
  });
});
