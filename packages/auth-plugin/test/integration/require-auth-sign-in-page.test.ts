/**
 * `requireAuth({ signInPage })` (M124 §3.2, V10-66): an unauthenticated browser
 * navigation is sent to the sign-in page with `returnTo`; every other
 * unauthenticated request keeps the 401 Problem Details. Driven through a real
 * kernel app so the `Location` and `Vary` headers are the ones a client sees.
 *
 * @module
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { securityMetadataOf } from '@setu-ts/common';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { AuthPluginConfigurationError, requireAuth, safeReturnTo } from '../../src/index.ts';
import { MAX_RETURN_TO_BYTES } from '../../src/sign-in/return-to.ts';

/** Signs the request in when it carries `x-test-user`, as an auth strategy would. */
const signInFromHeader: MiddlewareFunction = async (ctx, next) => {
  const id = ctx.request.headers.get('x-test-user');
  if (id !== null) {
    ctx.request.user = { id };
  }
  await next();
};

/** Writes `Vary: Origin` first, as the CORS middleware does. */
const varyOrigin: MiddlewareFunction = async (ctx, next) => {
  ctx.response.appendHeader('Vary', 'Origin');
  await next();
};

describe('requireAuth({ signInPage })', () => {
  let app: IKernelApplication;
  let handled = 0;
  const handler = (ctx: IRequestContext) => {
    handled += 1;
    return ctx.response.json({ user: ctx.request.user?.id ?? null });
  };

  beforeAll(async () => {
    app = createApplication({ plugins: [RuntimePlugin()] });
    const guard = requireAuth({ signInPage: '/login' });
    for (const path of ['/account', '/account/:id', '/login', '/files/*']) {
      app.router.get(path, { middleware: [varyOrigin, signInFromHeader, guard], handler });
      app.router.post(path, { middleware: [signInFromHeader, guard], handler });
      app.router.put(path, { middleware: [signInFromHeader, guard], handler });
      app.router.head(path, { middleware: [signInFromHeader, guard], handler });
    }
    app.router.get('/with-query', {
      middleware: [requireAuth({ signInPage: '/session/new?locale=en#form' })],
      handler,
    });
    app.router.get('/plain', { middleware: [requireAuth()], handler });
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  function call(
    path: string,
    method = 'GET',
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.fetch(new Request(`http://localhost${path}`, { method, headers }));
  }

  /** The navigation table (§3.2) as data: method, headers, redirected? */
  const NAVIGATION: readonly (readonly [string, Record<string, string>, boolean])[] = [
    ['GET', { 'sec-fetch-mode': 'navigate' }, true],
    ['GET', { 'sec-fetch-mode': 'Navigate ' }, true],
    ['GET', { 'sec-fetch-mode': 'navigate', accept: 'application/json' }, true],
    ['HEAD', { 'sec-fetch-mode': 'navigate' }, true],
    ['GET', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, true],
    ['GET', { accept: 'application/xhtml+xml' }, true],
    ['GET', { accept: 'application/json, TEXT/HTML ; q=0.5' }, true],
    ['GET', { 'sec-fetch-mode': 'cors', accept: 'text/html' }, false],
    ['GET', { 'sec-fetch-mode': 'no-cors' }, false],
    ['GET', { 'sec-fetch-mode': 'same-origin', accept: 'text/html' }, false],
    ['GET', { accept: '*/*' }, false],
    ['GET', { accept: 'text/*' }, false],
    ['GET', { accept: 'text/htmlx' }, false],
    ['GET', { accept: 'application/json' }, false],
    ['GET', {}, false],
    ['GET', { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' }, false],
    ['GET', { 'sec-fetch-mode': 'navigate', 'x-requested-with': 'xmlhttprequest' }, false],
    ['POST', { 'sec-fetch-mode': 'navigate', accept: 'text/html' }, false],
    ['PUT', { accept: 'text/html' }, false],
  ];

  it('redirects a navigation and answers 401 to everything else', async () => {
    for (const [method, headers, redirected] of NAVIGATION) {
      const label = `${method} ${JSON.stringify(headers)}`;
      const response = await call('/account', method, headers);
      if (redirected) {
        expect(response.status, label).toBe(302);
        expect(response.headers.get('location'), label).toBe('/login?returnTo=%2Faccount');
        await response.body?.cancel();
      } else {
        expect(response.status, label).toBe(401);
        expect(response.headers.get('location'), label).toBeNull();
        // The same body requireAuth() without options writes: one 401 path.
        expect(await response.json(), label).toEqual(await (await call('/plain')).json());
      }
    }
  });

  it('never runs the handler for an anonymous request, redirected or refused', async () => {
    handled = 0;
    await (await call('/account', 'GET', { 'sec-fetch-mode': 'navigate' })).body?.cancel();
    await (await call('/account', 'GET', { accept: 'application/json' })).body?.cancel();
    expect(handled).toBe(0);
    const response = await call('/account', 'GET', { 'x-test-user': 'u1' });
    expect(await response.json()).toEqual({ user: 'u1' });
    expect(handled).toBe(1);
  });

  it('appends its Vary entries to an existing Vary on both answers, and adds none when signed in', async () => {
    const redirected = await call('/account', 'GET', { 'sec-fetch-mode': 'navigate' });
    expect(redirected.headers.get('vary')).toBe('Origin, Accept, Sec-Fetch-Mode, X-Requested-With');
    await redirected.body?.cancel();
    const refused = await call('/account', 'GET', { accept: 'application/json' });
    expect(refused.headers.get('vary')).toBe('Origin, Accept, Sec-Fetch-Mode, X-Requested-With');
    await refused.body?.cancel();
    const signedIn = await call('/account', 'GET', { 'x-test-user': 'u1' });
    expect(signedIn.headers.get('vary')).toBe('Origin');
    await signedIn.body?.cancel();
  });

  it('carries the path and query as returnTo, encoded', async () => {
    const response = await call('/account/42?tab=orders&q=a%20b', 'GET', {
      'sec-fetch-mode': 'navigate',
    });
    const location = new URL(response.headers.get('location') ?? '', 'http://localhost');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('returnTo')).toBe('/account/42?tab=orders&q=a%20b');
    await response.body?.cancel();
  });

  it('falls back to / when the requested path is not a safe returnTo', async () => {
    const long = `/files/${'a'.repeat(MAX_RETURN_TO_BYTES)}`;
    const response = await call(long, 'GET', { 'sec-fetch-mode': 'navigate' });
    expect(response.headers.get('location')).toBe('/login?returnTo=%2F');
    await response.body?.cancel();
  });

  it('keeps the sign-in page query and fragment', async () => {
    const response = await call('/with-query?x=1', 'GET', { 'sec-fetch-mode': 'navigate' });
    expect(response.headers.get('location')).toBe(
      '/session/new?locale=en&returnTo=%2Fwith-query%3Fx%3D1#form',
    );
    await response.body?.cancel();
  });

  it('answers 401 rather than redirecting a navigation to the sign-in page itself', async () => {
    for (const path of ['/login', '/login?returnTo=%2Faccount']) {
      const response = await call(path, 'GET', { 'sec-fetch-mode': 'navigate' });
      expect(response.status, path).toBe(401);
      expect(response.headers.get('location'), path).toBeNull();
      await response.body?.cancel();
    }
  });

  it('leaves requireAuth() without options unchanged: 401, no Vary', async () => {
    const response = await call('/plain', 'GET', { 'sec-fetch-mode': 'navigate' });
    expect(response.status).toBe(401);
    expect(response.headers.get('vary')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    await response.body?.cancel();
  });

  it('keeps the authenticated security metadata', () => {
    expect(securityMetadataOf(requireAuth({ signInPage: '/login' }))).toEqual({
      authenticated: true,
    });
  });
});

describe('requireAuth signInPage validation', () => {
  it('refuses a sign-in page that is not a same-origin absolute path, when the guard is built', () => {
    const refused: readonly unknown[] = [
      '',
      'login',
      '//evil.test/login',
      'https://evil.test/login',
      '/\\evil.test',
      '/a\nb',
      '/café',
      `/${'a'.repeat(MAX_RETURN_TO_BYTES)}`,
      42,
      null,
    ];
    for (const signInPage of refused) {
      expect(
        () => requireAuth({ signInPage } as { signInPage: string }),
        String(signInPage),
      ).toThrow(AuthPluginConfigurationError);
      expect(
        () => requireAuth({ signInPage } as { signInPage: string }),
        String(signInPage),
      ).toThrow('requireAuth signInPage must be a same-origin absolute path');
    }
  });

  it('accepts exactly what safeReturnTo keeps', () => {
    for (const signInPage of ['/', '/login', '/session/new?locale=en#form', '/caf%C3%A9']) {
      expect(safeReturnTo(signInPage, '')).toBe(signInPage);
      expect(() => requireAuth({ signInPage })).not.toThrow();
    }
  });
});
