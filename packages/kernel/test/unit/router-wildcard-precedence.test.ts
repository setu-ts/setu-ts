/**
 * Wildcard route precedence (M70g — register rows X5-1 and F1).
 *
 * Before this milestone `parsePattern` classified `*` as a STATIC segment, so
 * `GET /*` scored the same specificity as `GET /openapi.json` and the tie fell
 * through to registration order. A full-stack application mounts the SSR
 * catch-all at `PLUGIN_PRIORITY.NORMAL` (500) while `openapi-plugin` registers at
 * `OPENAPI` (700) BY DESIGN, so the catch-all always registered first and the
 * documentation endpoints silently answered the SSR 404 page.
 *
 * Every case below is asserted in BOTH registration orders, because "the right
 * route wins" is only meaningful if it does not depend on who registered first.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { Router } from '../../src/router/router.ts';
import type { RouteHandler } from '@setu-ts/common';

/** Builds a router, registering the two patterns in the given order. */
function matchWith(
  patterns: readonly [string, string],
  order: 'as-listed' | 'reversed',
  path: string,
): string | null {
  const router = new Router();
  const labels = new Map<RouteHandler, string>();
  const handlerFor = (pattern: string): RouteHandler => {
    const handler = (() => new Response()) as unknown as RouteHandler;
    labels.set(handler, pattern);
    return handler;
  };
  const ordered = order === 'as-listed' ? patterns : [patterns[1], patterns[0]];
  for (const pattern of ordered) router.get(pattern, handlerFor(pattern));

  const result = router.match('GET', path);
  return result === null ? null : labels.get(result.definition.handler) ?? null;
}

/** Asserts the winner is the same whichever route was registered first. */
function expectWinner(
  patterns: readonly [string, string],
  path: string,
  winner: string,
): void {
  expect(matchWith(patterns, 'as-listed', path)).toBe(winner);
  expect(matchWith(patterns, 'reversed', path)).toBe(winner);
}

describe('Router wildcard precedence', () => {
  it('a single-segment exact path beats a root catch-all (X5-1, F1)', () => {
    expectWinner(['/*', '/openapi.json'], '/openapi.json', '/openapi.json');
    expectWinner(['/*', '/docs'], '/docs', '/docs');
  });

  it('an exact root handler beats a root catch-all', () => {
    // PUBLIC_API.md's full-stack note relies on this: the template omits a
    // hello-world route because an exact `/` would shadow the SSR index.
    expectWinner(['/*', '/'], '/', '/');
  });

  it('a param beats a wildcard at the same position', () => {
    // Not merely a tie before M70g — an INVERSION: `/a/*` counted two statics
    // against `/a/:id`'s one, so the wildcard won in both orders.
    expectWinner(['/a/*', '/a/:id'], '/a/x', '/a/:id');
  });

  it('a deeper wildcard beats a shallower one', () => {
    expectWinner(['/*', '/assets/*'], '/assets/app.js', '/assets/*');
  });

  it('a multi-segment exact path beats a root catch-all', () => {
    expectWinner(['/*', '/a/b'], '/a/b', '/a/b');
  });

  it('the catch-all still serves everything nothing else claims', () => {
    expectWinner(['/*', '/openapi.json'], '/anything/else', '/*');
  });

  it('ranks by segment COUNTS, which is the one documented limit', () => {
    // `/a/*` (one static, one wildcard) loses to `/:x/b` (one static, no
    // wildcard) although a per-position rule would prefer the literal `a`.
    // Pinned so a future move to per-segment ranking is a deliberate change
    // rather than an accidental one. See `Router.match`'s JSDoc.
    expectWinner(['/a/*', '/:x/b'], '/a/b', '/:x/b');
  });

  it('records the wildcard count on the entry it hoists at registration', () => {
    const router = new Router();
    router.get('/*', (() => new Response()) as unknown as RouteHandler);
    router.get('/assets/*', (() => new Response()) as unknown as RouteHandler);
    router.get('/a/:id', (() => new Response()) as unknown as RouteHandler);

    expect(router.getAll().map((e) => ({ p: e.pattern, s: e.statics, w: e.wildcards }))).toEqual([
      { p: '/*', s: 0, w: 1 },
      { p: '/assets/*', s: 1, w: 1 },
      { p: '/a/:id', s: 1, w: 0 },
    ]);
  });
});

describe('Router duplicate-route refusal', () => {
  it('names the plugin that registered the route first (X5-6)', () => {
    const router = new Router(() => 'react-router');
    router.get('/*', (() => new Response()) as unknown as RouteHandler);

    expect(() => router.get('/*', (() => new Response()) as unknown as RouteHandler)).toThrow(
      "Route 'GET /*' is already registered by plugin 'react-router'.",
    );
  });

  it('names the application when no plugin owns the route', () => {
    const router = new Router();
    router.get('/dup', (() => new Response()) as unknown as RouteHandler);

    expect(() => router.get('/dup', (() => new Response()) as unknown as RouteHandler)).toThrow(
      "Route 'GET /dup' is already registered by the application.",
    );
  });
});
