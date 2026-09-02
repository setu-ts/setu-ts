/**
 * The single-candidate fast path and its param decoding (M87).
 *
 * `match()` now answers a request that matches exactly one route without
 * building the candidates array, the per-candidate object literal or the
 * `${method} ${path}` map key — the entry rides on the stub handler Hono
 * already hands back. These assert that the shortcut answers identically to
 * the multi-candidate path it bypasses, including the cases where a naive
 * shortcut would diverge: a percent-escape, a MALFORMED percent-escape, and a
 * route with no params at all.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Router } from '../../src/router/router.ts';

describe('Router | single-candidate fast path (M87)', () => {
  it('matches a static route and reports no params', () => {
    const router = new Router();
    router.get('/json', { handler: () => ({ __handlerResult: true } as never) });

    const result = router.match('GET', '/json');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({});
  });

  it('decodes a percent-escaped param exactly as the slow path does', () => {
    const router = new Router();
    router.get('/users/:id', { handler: () => ({ __handlerResult: true } as never) });

    expect(router.match('GET', '/users/a%20b')!.params).toEqual({ id: 'a b' });
    expect(router.match('GET', '/users/a%2Fb')!.params).toEqual({ id: 'a/b' });
  });

  it('passes a param carrying no percent through unchanged', () => {
    const router = new Router();
    router.get('/users/:id', { handler: () => ({ __handlerResult: true } as never) });

    // The fast path skips decodeURIComponent when there is no '%'; it is an
    // identity function there (it does not decode '+'), so '+' must survive.
    expect(router.match('GET', '/users/a+b')!.params).toEqual({ id: 'a+b' });
  });

  it('reports no match for a malformed percent-escape', () => {
    const router = new Router();
    router.get('/users/:id', { handler: () => ({ __handlerResult: true } as never) });

    expect(router.match('GET', '/users/%zz')).toBeNull();
  });

  it('does not hand out a params object a caller can mutate into a shared surprise', () => {
    const router = new Router();
    router.get('/a', { handler: () => ({ __handlerResult: true } as never) });
    router.get('/b', { handler: () => ({ __handlerResult: true } as never) });

    const first = router.match('GET', '/a')!.params as Record<string, string>;
    expect(() => {
      first.injected = 'x';
    }).toThrow();
    expect(router.match('GET', '/b')!.params).toEqual({});
  });

  it('ignores inherited properties, so a polluted prototype cannot inject params', () => {
    const router = new Router();
    router.get('/static', { handler: () => ({ __handlerResult: true } as never) });

    // Hono currently builds its params with a null prototype, so this passes
    // either way today; it pins the property against a change in that
    // dependency's internals, which is what the replaced `Object.entries`
    // form guaranteed by construction.
    const polluted = Object.prototype as unknown as Record<string, string>;
    polluted.injectedByPollution = 'attacker';
    try {
      expect(router.match('GET', '/static')!.params).toEqual({});
    } finally {
      delete polluted.injectedByPollution;
    }
  });

  it('still tie-breaks when more than one route matches', () => {
    const router = new Router();
    router.get('/:wild', { handler: () => ({ __handlerResult: true } as never) });
    router.get('/exact', { handler: () => ({ __handlerResult: true } as never) });

    // Static beats param regardless of registration order — the multi-candidate
    // path, which the fast path must not have shadowed.
    const result = router.match('GET', '/exact');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({});
  });
});
