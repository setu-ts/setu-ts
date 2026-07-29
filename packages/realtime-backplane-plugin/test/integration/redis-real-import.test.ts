/**
 * Drives the REAL `npm:ioredis` import performed by `loadRedisModule`, so the
 * production load path is exercised rather than only the injected module seam.
 *
 * Guarded: when the driver cannot be resolved (offline CI, no npm cache) the
 * loader must still fail with a descriptive `RedisModuleError` rather than an
 * opaque one — which is itself the assertion. No connection is ever opened.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadRedisModule, RedisModuleError } from '../../src/transports/redis-module.ts';

describe('loadRedisModule (guarded real import)', () => {
  it('either resolves the real ioredis constructor or fails descriptively', async () => {
    let module: Awaited<ReturnType<typeof loadRedisModule>> | undefined;
    let error: Error | undefined;

    try {
      module = await loadRedisModule();
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    if (module !== undefined) {
      // The real driver resolved and the adapter found its constructor — the
      // fact the lazy path depends on.
      expect(typeof module.create).toBe('function');
      return;
    }

    expect(error).toBeInstanceOf(RedisModuleError);
    expect(error?.message).toContain('ioredis');
  });
});
