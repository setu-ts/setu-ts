import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * Each refusal here mirrors a case where `caches.default.put` throws. Getting
 * one wrong means an ordinary uncacheable response becomes a logged background
 * failure on every request, so each is asserted on its own.
 */

import { describe, expect, it } from 'vitest';

import { assessCacheability } from '../../../src/cache-api/cacheability.ts';

/** Assesses with the common defaults, overriding only what a case is about. */
function assess(overrides: {
  readonly method?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly cacheableStatuses?: readonly number[];
}): readonly string[] {
  return assessCacheability({
    method: overrides.method ?? 'GET',
    status: overrides.status ?? 200,
    headers: new Headers(overrides.headers ?? {}),
    cacheableStatuses: overrides.cacheableStatuses ?? [200],
  });
}

describe('assessCacheability', () => {
  it('returns no refusals for a plain cacheable GET', () => {
    expect(assess({})).toEqual([]);
  });

  it('refuses a non-GET request, whatever its status', () => {
    expect(assess({ method: 'POST' })).toEqual(['method']);
    expect(assess({ method: 'DELETE' })).toEqual(['method']);
    expect(assess({ method: 'HEAD' })).toEqual(['method']);
  });

  it('accepts a lowercase method rather than refusing it', () => {
    expect(assess({ method: 'get' })).toEqual([]);
  });

  it('refuses a status outside the configured set', () => {
    expect(assess({ status: 404 })).toEqual(['status']);
    expect(assess({ status: 500 })).toEqual(['status']);
  });

  it('honours a widened cacheable-status set', () => {
    expect(assess({ status: 301, cacheableStatuses: [200, 301] })).toEqual([]);
  });

  it('refuses 206 UNCONDITIONALLY, even when the caller allowed it', () => {
    // The load-bearing case: with 206 in cacheableStatuses the status check
    // passes, and only this rule stops the platform throwing.
    expect(assess({ status: 206, cacheableStatuses: [200, 206] })).toEqual(['partial-content']);
    // Outside the set it is refused twice, for two separate reasons.
    expect(assess({ status: 206 })).toEqual(['status', 'partial-content']);
  });

  it('refuses Vary: *', () => {
    expect(assess({ headers: { vary: '*' } })).toEqual(['vary-star']);
  });

  it('refuses a wildcard hidden in a multi-value Vary', () => {
    // A bare equality check would let `Accept, *` through and the put would throw.
    expect(assess({ headers: { vary: 'Accept, *' } })).toEqual(['vary-star']);
    expect(assess({ headers: { vary: ' * ' } })).toEqual(['vary-star']);
  });

  it('allows a Vary listing real field names', () => {
    expect(assess({ headers: { vary: 'Accept-Encoding, Accept-Language' } })).toEqual([]);
  });

  it('refuses a response carrying Set-Cookie', () => {
    expect(assess({ headers: { 'set-cookie': 'session=abc' } })).toEqual(['set-cookie']);
  });

  it('refuses private=Set-Cookie as both set-cookie and private (D9: no escape hatch)', () => {
    expect(
      assess({
        headers: { 'set-cookie': 'session=abc', 'cache-control': 'private=Set-Cookie' },
      }),
    ).toEqual(['set-cookie', 'private']);
    expect(
      assess({
        headers: { 'set-cookie': 'session=abc', 'cache-control': 'max-age=60, PRIVATE=SET-COOKIE' },
      }),
    ).toEqual(['set-cookie', 'private']);
  });

  it.each([
    'private',
    'PRIVATE',
    'no-store',
    'public, no-store',
    'private="x-a, set-cookie"',
    'max-age=60, x="unclosed',
  ])("refuses '%s' as private", (cacheControl) => {
    expect(assess({ headers: { 'cache-control': cacheControl } })).toEqual(['private']);
  });

  it('does not read a private inside a quoted argument as the directive', () => {
    expect(assess({ headers: { 'cache-control': 'public, x="a,private"' } })).toEqual([]);
  });

  it('reports every applicable refusal at once', () => {
    expect(
      assess({
        method: 'POST',
        status: 206,
        headers: { vary: '*', 'set-cookie': 'a=1' },
      }),
    ).toEqual(['method', 'status', 'partial-content', 'vary-star', 'set-cookie']);
  });
});
