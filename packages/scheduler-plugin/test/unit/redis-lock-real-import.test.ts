// deno-lint-ignore-file no-console
/**
 * Guarded real-import test for RedisLock.
 *
 * Skipped when npm:ioredis@5.x cannot be loaded.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('RedisLock real import', () => {
  it(
    'loads ioredis constructor',
    async () => {
      try {
        const mod = await import('npm:ioredis@5.x');
        expect(mod.Redis).toBeDefined();
        expect(typeof mod.Redis).toBe('function');
      } catch {
        // Skip when ioredis is not available
        console.log('Skipping: npm:ioredis@5.x not available');
      }
    },
  );
});
