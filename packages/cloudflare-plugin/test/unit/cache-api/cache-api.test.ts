/**
 * `caches.default` is the one platform global this package reads, so the
 * resolver is where that read is pinned down. Deno has a `caches` with no
 * `default` at all, which is exactly the case an inline read would break on.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { resolveCacheApi } from '../../../src/cache-api/cache-api.ts';
import { FakeCacheApi } from '../../fakes.ts';

describe('resolveCacheApi', () => {
  it('returns the handle when the scope carries a usable caches.default', () => {
    const cache = new FakeCacheApi();
    expect(resolveCacheApi({ caches: { default: cache } })).toBe(cache);
  });

  it('returns undefined when the scope has no caches at all', () => {
    expect(resolveCacheApi({})).toBeUndefined();
  });

  it('returns undefined for a CacheStorage without default — the Deno case', () => {
    // Deno ships `caches` (open/match/delete) but no `default`; a name-only
    // check would hand back undefined and fail at the first call instead.
    expect(resolveCacheApi({ caches: { open: () => {}, match: () => {} } })).toBeUndefined();
  });

  it('returns undefined when caches.default is not an object', () => {
    expect(resolveCacheApi({ caches: { default: null } })).toBeUndefined();
    expect(resolveCacheApi({ caches: { default: 'edge' } })).toBeUndefined();
    expect(resolveCacheApi({ caches: { default: undefined } })).toBeUndefined();
  });

  it('returns undefined for a partial shim missing any one method', () => {
    const put = (): Promise<void> => Promise.resolve();
    const match = (): Promise<undefined> => Promise.resolve(undefined);
    const del = (): Promise<boolean> => Promise.resolve(false);

    expect(resolveCacheApi({ caches: { default: { put, delete: del } } })).toBeUndefined();
    expect(resolveCacheApi({ caches: { default: { match, delete: del } } })).toBeUndefined();
    expect(resolveCacheApi({ caches: { default: { match, put } } })).toBeUndefined();
    expect(resolveCacheApi({ caches: { default: { match, put, delete: del } } })).toBeDefined();
  });

  it('defaults to globalThis, which on this runtime yields no handle', () => {
    // Proves the default argument is wired rather than dead. Deno's global
    // `caches` has no `default`, so the honest answer here is undefined.
    expect(resolveCacheApi()).toBeUndefined();
  });
});
