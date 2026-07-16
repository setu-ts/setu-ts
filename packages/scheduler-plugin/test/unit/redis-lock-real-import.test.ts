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
      // Only the load is guarded — assertions run outside the catch so a real
      // failure cannot masquerade as an absent dependency.
      let mod: { Redis: unknown };
      try {
        mod = await import('npm:ioredis@5.x');
      } catch {
        console.log('Skipping: npm:ioredis@5.x not available');
        return;
      }

      expect(mod.Redis).toBeDefined();
      expect(typeof mod.Redis).toBe('function');
    },
  );
});
