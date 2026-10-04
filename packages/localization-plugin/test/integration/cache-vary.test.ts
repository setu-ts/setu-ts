/**
 * The locale segment in `cache-plugin`'s key, end to end with the REAL
 * `cacheMiddleware` — including the two documented limitations, pinned so the
 * README's ordering statement cannot drift.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';
import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { replaceLocale } from '@setu-ts/common';
import { cacheMiddleware, CachePlugin } from '@setu-ts/cache-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';

import { LocalizationPlugin, localizerFor } from '../../src/index.ts';
import { CATALOGUES } from '../fixtures/catalogues.ts';

let app: IKernelApplication | undefined;
let origin = 0;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

type Placement =
  | { readonly kind: 'route' }
  | { readonly kind: 'global'; readonly priority: number };

interface Setup {
  readonly placement: Placement;
  /** Global middleware applying a stored preference, at this priority. */
  readonly preferenceAt?: number;
  /** The handler itself applies the preference (after the cache lookup). */
  readonly preferenceInHandler?: boolean;
}

/** Applies the preference carried by `x-user-locale`, as a profile lookup would. */
function applyPreference(ctx: IRequestContext): void {
  const preference = ctx.request.headers.get('x-user-locale');
  if (preference !== null) {
    replaceLocale(ctx.request, preference);
  }
}

async function start(setup: Setup): Promise<void> {
  origin = 0;
  app = await createTestApp({
    autoStart: false,
    plugins: [
      RuntimePlugin(),
      CachePlugin(),
      LocalizationPlugin({ supportedLocales: ['en', 'de', 'fr'], catalogues: CATALOGUES }),
    ],
  });
  if (setup.placement.kind === 'global') {
    app.middleware.add(cacheMiddleware({ ttlSeconds: 60 }), {
      priority: setup.placement.priority,
    });
  }
  if (setup.preferenceAt !== undefined) {
    const preference: MiddlewareFunction = async (ctx, next) => {
      applyPreference(ctx);
      await next();
    };
    app.middleware.add(preference, { priority: setup.preferenceAt });
  }
  const handler = (ctx: IRequestContext) => {
    origin++;
    if (setup.preferenceInHandler === true) {
      applyPreference(ctx);
    }
    return ctx.response.text(localizerFor(ctx).t('title'));
  };
  app.router.get(
    '/cart',
    setup.placement.kind === 'route'
      ? { middleware: [cacheMiddleware({ ttlSeconds: 60 })], handler }
      : handler,
  );
  await app.start();
}

async function body(headers: Record<string, string>): Promise<string> {
  const response = await app!.fetch(new Request('http://localhost/cart', { headers }));
  return await response.text();
}

describe('cache entries per locale', () => {
  const placements: readonly Placement[] = [{ kind: 'route' }, { kind: 'global', priority: 50 }];
  for (const placement of placements) {
    it(`keeps one entry per locale with a ${placement.kind} cache`, async () => {
      await start({ placement });
      expect(await body({ 'accept-language': 'de' })).toBe('Warenkorb');
      expect(await body({ 'accept-language': 'en' })).toBe('Cart');
      expect(await body({ 'accept-language': 'de' })).toBe('Warenkorb');
      expect(await body({ 'accept-language': 'en' })).toBe('Cart');
      // Two entries: the origin ran once per locale, then served from cache.
      expect(origin).toBe(2);
    });
  }

  it('reflects a replaceLocale made in middleware BEFORE the lookup', async () => {
    await start({ placement: { kind: 'route' }, preferenceAt: 310 });
    expect(await body({ 'x-user-locale': 'fr' })).toBe('Panier');
    expect(await body({})).toBe('Cart');
    expect(origin).toBe(2);
  });
});

describe('documented limitations (pinned, not claimed to work)', () => {
  it('a global cache BELOW priority 45 keys before the locale exists and shares one entry', async () => {
    await start({ placement: { kind: 'global', priority: 30 } });
    expect(await body({ 'accept-language': 'de' })).toBe('Warenkorb');
    // The German body is served to an English request: exactly why the
    // README says a global cache must sit above 45.
    expect(await body({ 'accept-language': 'en' })).toBe('Warenkorb');
    expect(origin).toBe(1);
  });

  it('a handler-time replaceLocale runs after the lookup and shares one entry', async () => {
    await start({ placement: { kind: 'route' }, preferenceInHandler: true });
    expect(await body({ 'x-user-locale': 'fr' })).toBe('Panier');
    expect(await body({})).toBe('Panier');
    expect(origin).toBe(1);
  });
});
