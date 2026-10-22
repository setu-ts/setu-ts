import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { CacheStoreUnavailableError, RedisStore } from '../../src/index.ts';
import { createFakeIoredis } from '../fixtures/fake-ioredis-client.ts';

describe('RedisStore connection faults', () => {
  for (const operation of ['get', 'set', 'delete', 'has', 'clear'] as const) {
    for (const fault of [true, false]) {
      it(`${operation} ${fault ? 'wraps connection faults' : 'preserves command errors'}`, async () => {
        const original = Object.freeze(
          Object.assign(
            new Error(fault ? 'outage' : 'WRONGTYPE'),
            fault ? { code: 'ECONNRESET' } : {},
          ),
        );
        const { client } = createFakeIoredis();
        const reject = (): Promise<never> => Promise.reject(original);
        client.get = reject;
        client.set = reject;
        client.del = reject;
        client.exists = reject;
        client.scan = reject;
        const store = new RedisStore('m113b:', { client });
        await store.connect();
        const run = () =>
          operation === 'get'
            ? store.get('k')
            : operation === 'set'
              ? store.set('k', 1)
              : operation === 'delete'
                ? store.delete('k')
                : operation === 'has'
                  ? store.has('k')
                  : store.clear();
        try {
          const error = await run().catch((caught: unknown) => caught);
          if (fault) {
            expect(error).toBeInstanceOf(CacheStoreUnavailableError);
            expect((error as Error).cause).toBe(original);
            expect(httpStatusHintOf(error)).toEqual({
              status: 503,
              title: 'Service Unavailable',
              detail: 'The cache is temporarily unavailable.',
            });
          } else expect(error).toBe(original);
        } finally {
          await store.disconnect();
        }
      });
    }
  }
});
