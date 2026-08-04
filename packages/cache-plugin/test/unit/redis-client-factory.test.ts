import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createLazyRedisClient } from '../../src/stores/redis-store.ts';

describe('createLazyRedisClient', () => {
  it('passes lazyConnect to the ioredis constructor', () => {
    let receivedUrl = '';
    let receivedOptions: { readonly lazyConnect: true } | undefined;
    class FakeRedis {
      constructor(url: string, options: { readonly lazyConnect: true }) {
        receivedUrl = url;
        receivedOptions = options;
      }
    }

    createLazyRedisClient(FakeRedis, 'redis://cache.example:6379');

    expect(receivedUrl).toBe('redis://cache.example:6379');
    expect(receivedOptions).toEqual({ lazyConnect: true });
  });
});
