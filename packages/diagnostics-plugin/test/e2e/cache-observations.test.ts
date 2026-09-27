/**
 * End-to-end canary for cache operation counters (M98i): a REAL Deno socket,
 * the REAL kernel application and runtime-owned listener, two REAL
 * CachePlugin instances (one opted in, one not), and the signed native
 * client.
 *
 * Canaries are planted in every place the minimization seam must never
 * reach — the key, the prefix, the stored value, a Redis URL, a getOrSet
 * factory result and a thrown error's message — and asserted absent at the
 * source snapshot, the RAW signed wire bytes, and the client DTO. The
 * approved counters are asserted PRESENT alongside, so dropping every record
 * cannot pass.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ICacheDiagnosticsSource, ICacheStore } from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CachePlugin } from '@setu-ts/cache-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY_KEY = 'canary-key-SYNTHETIC';
const CANARY_PREFIX = 'canary-prefix-SYNTHETIC:';
const CANARY_VALUE = 'canary-value-SYNTHETIC';
const CANARY_URL = 'redis://canary-user:canary-pass@canary-host:6379';
const CANARY_FACTORY = 'canary-factory-SYNTHETIC';
const CANARY_ERROR = 'canary-error-SYNTHETIC';

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

/** Reserves a free loopback port. */
function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

describe('Cache observations e2e (M98i canary)', () => {
  it('serves approved counters end to end while every canary stays absent', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        CachePlugin({
          options: { prefix: CANARY_PREFIX, url: CANARY_URL },
          diagnostics: { enabled: true, alias: 'primary' },
        }),
        CachePlugin({ name: 'session' }),
      ],
      diagnostics: {},
    });
    await app.start({ port: freePort(), hostname: '127.0.0.1' });
    try {
      const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
      const other = app.services.get<ICacheStore>(createCapabilityToken('cache.session'));
      await cache.set(CANARY_KEY, CANARY_VALUE, 60);
      expect(await cache.get(CANARY_KEY)).toEqual(CANARY_VALUE);
      expect(await cache.get('absent')).toBeNull();
      expect(await cache.has(CANARY_KEY)).toBe(true);
      expect(await cache.delete(CANARY_KEY)).toBe(true);
      expect(await cache.delete(CANARY_KEY)).toBe(false);
      const getOrSet = (cache as unknown as {
        getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T>;
      }).getOrSet.bind(cache);
      expect(await getOrSet('computed', () => Promise.resolve(CANARY_FACTORY))).toEqual(
        CANARY_FACTORY,
      );
      const failure = new Error(CANARY_ERROR);
      await expect(getOrSet('broken', () => Promise.reject(failure))).rejects.toBe(failure);
      await cache.clear();
      // The unobserved instance's work never appears anywhere.
      await other.set('ignored', 'x');

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.cache();
      client.close();

      // --- Approved counters survive (positive control) ---------------
      expect(response.state).toEqual('ready');
      expect(response.sources.map((s) => s.sourceId)).toEqual(['s1', 's2']);
      const [primary, session] = response.sources;
      expect(primary!.snapshot.alias).toEqual('primary');
      expect(primary!.snapshot.coverage).toEqual('owned-instance');
      expect(session!.snapshot).toEqual({
        state: 'disabled',
        alias: null,
        coverage: 'owned-instance',
        records: [],
        dropped: 0,
      });
      const byOp = new Map(primary!.snapshot.records.map((r) => [r.operation, r]));
      // get: hit, miss, and getOrSet's two internal misses.
      expect(byOp.get('get')).toMatchObject({ count: 4, succeeded: 4, hits: 1, misses: 3 });
      // set: the explicit set plus getOrSet's one successful store.
      expect(byOp.get('set')).toMatchObject({ count: 2, succeeded: 2, failed: 0 });
      expect(byOp.get('has')).toMatchObject({ count: 1, present: 1, absent: 0 });
      expect(byOp.get('delete')).toMatchObject({ count: 2, removed: 1, notRemoved: 1 });
      expect(byOp.get('clear')).toMatchObject({ count: 1, succeeded: 1 });

      const sources = app.services.getAll<ICacheDiagnosticsSource>(
        CAPABILITIES.CACHE_DIAGNOSTICS,
      );
      const local = JSON.stringify(sources.map((s) => s.snapshot()));
      expect(local).toContain('primary');

      // --- Canaries are absent at every layer -------------------------
      const canaries = [
        CANARY_KEY,
        CANARY_PREFIX,
        CANARY_VALUE,
        CANARY_URL,
        'canary-pass',
        CANARY_FACTORY,
        CANARY_ERROR,
        'computed',
        'broken',
        'session',
      ];
      expect(frames.length).toBeGreaterThan(0);
      for (const layer of [local, JSON.stringify(response), ...frames]) {
        for (const canary of canaries) {
          expect(layer).not.toContain(canary);
        }
      }
    } finally {
      await app.stop();
    }
  });
});
