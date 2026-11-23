/**
 * Which responses the session plugin marks private, through a real kernel application on both
 * strategies (V13-111, V13-112, V13-20).
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, IPlugin } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';
import type { SessionPluginOptions } from '../../src/index.ts';

const SECRET = 'test-session-secret-at-least-32-chars';

const get = (url: string, headers: Record<string, string> = {}) =>
  ({ method: 'GET', url: `http://localhost${url}`, headers }) as const;

function cookieOf(headers: Headers): string {
  return headers.getSetCookie()[0]!.split(';')[0]!;
}

function recordingLogger(): { plugin: IPlugin; warnings: Array<[string, unknown]> } {
  const warnings: Array<[string, unknown]> = [];
  const noop = () => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (message: string, fields?: unknown) => warnings.push([message, fields]),
    error: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as ILogger;
  return {
    warnings,
    plugin: {
      name: 'recording-logger',
      version: '1.0.0',
      provides: [CAPABILITIES.LOGGER],
      register(ctx) {
        ctx.services.register(CAPABILITIES.LOGGER, logger);
      },
    },
  };
}

async function buildApp(options: Partial<SessionPluginOptions> = {}, extra: IPlugin[] = []) {
  const app = createApplication({
    plugins: [RuntimePlugin(), ...extra, SessionPlugin({ secret: SECRET, csrf: {}, ...options })],
  });
  app.middleware.add(errorHandler(), { priority: 0, name: 'error-handler' });
  app.router.get('/signin', (ctx) => {
    getSession(ctx).set('userId', 'alice');
    return ctx.response.json({ ok: true });
  });
  app.router.get('/products', (ctx) =>
    ctx.response.json({ user: getSession(ctx).get('userId') ?? null }),
  );
  app.router.get('/plain', (ctx) => ctx.response.text('plain'));
  app.router.get('/login', (ctx) =>
    ctx.response.html(`<input name="_csrf" value="${getCsrfToken(ctx)}">`),
  );
  app.router.get('/missing.png', (ctx) => {
    getCsrfToken(ctx);
    return ctx.response.status(404).text('not found');
  });
  app.router.get('/missing-write.png', (ctx) => {
    getSession(ctx).set('seen404', true);
    return ctx.response.status(404).text('not found');
  });
  app.router.get('/asset.js', (ctx) =>
    ctx.response.header('cache-control', 'public, max-age=31536000, immutable').text('js'),
  );
  app.router.get('/catalogue/:id', (ctx) =>
    ctx.response
      .header('cache-control', 'public, s-maxage=60')
      .json({ user: getSession(ctx).get('userId') ?? null }),
  );
  app.router.get('/public-write', (ctx) => {
    getSession(ctx).set('cart', 1);
    return ctx.response.header('cache-control', 'public, s-maxage=60').text('page');
  });
  app.router.get('/boom', (ctx) => {
    getSession(ctx).get('userId');
    throw new Error('boom');
  });
  await app.start();
  return app;
}

describe.each([
  ['cookie', {}],
  ['store', { store: 'memory' as const }],
])('private responses on the %s strategy', (_name, strategy) => {
  it('a signed-in page answers private, no-store with Vary: Cookie (V13-111)', async () => {
    const app = await buildApp(strategy);
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const page = await app.inject(get('/products', { cookie }));
      expect(page.headers.get('cache-control')).toBe('private, no-store');
      expect(page.headers.get('vary')).toBe('Cookie');
      // Even a handler that does not read the session (S1 is known at load).
      const plain = await app.inject(get('/plain', { cookie }));
      expect(plain.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      await app.stop();
    }
  });

  it("a returning visitor's login page is private (V13-112)", async () => {
    const app = await buildApp(strategy);
    try {
      const first = await app.inject(get('/login'));
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      const cookie = cookieOf(first.headers);
      const again = await app.inject(get('/login', { cookie }));
      expect(again.headers.getSetCookie()).toEqual([]);
      expect(again.headers.get('cache-control')).toBe('private, no-store');
      expect(again.headers.get('vary')).toBe('Cookie');
    } finally {
      await app.stop();
    }
  });

  it('an anonymous page that does not touch the session is not marked', async () => {
    const app = await buildApp(strategy);
    try {
      const page = await app.inject(get('/plain'));
      expect(page.headers.get('cache-control')).toBeNull();
      expect(page.headers.get('vary')).toBeNull();
      expect(page.headers.getSetCookie()).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('an anonymous page that reads the session gets Vary: Cookie only', async () => {
    const app = await buildApp(strategy);
    try {
      const page = await app.inject(get('/products'));
      expect(page.headers.get('cache-control')).toBeNull();
      expect(page.headers.get('vary')).toBe('Cookie');
    } finally {
      await app.stop();
    }
  });

  it('an error thrown on a signed-in route answers private, no-store', async () => {
    const app = await buildApp(strategy);
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const failed = await app.inject(get('/boom', { cookie }));
      expect(failed.statusCode).toBe(500);
      expect(failed.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      await app.stop();
    }
  });

  it('a public asset keeps its directive for a signed-in visitor, with no cookie and no Vary', async () => {
    const { plugin, warnings } = recordingLogger();
    const app = await buildApp({ ...strategy, rolling: true }, [plugin]);
    try {
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      const asset = await app.inject(get('/asset.js', { cookie }));
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(asset.headers.getSetCookie()).toEqual([]);
      expect(asset.headers.get('vary')).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('an explicit public directive is kept with one warning per route', async () => {
    const { plugin, warnings } = recordingLogger();
    const app = await buildApp(strategy, [plugin]);
    try {
      // Anonymous: kept, Vary: Cookie (the session was read), no warning.
      const anonymous = await app.inject(get('/catalogue/7'));
      expect(anonymous.headers.get('cache-control')).toBe('public, s-maxage=60');
      expect(anonymous.headers.get('vary')).toBe('Cookie');
      expect(warnings).toEqual([]);
      // Signed in and read: kept, warned once across three requests and two ids.
      const cookie = cookieOf((await app.inject(get('/signin'))).headers);
      for (const id of ['7', '8', '9']) {
        const page = await app.inject(get(`/catalogue/${id}`, { cookie }));
        expect(page.headers.get('cache-control')).toBe('public, s-maxage=60');
        expect(page.headers.get('vary')).toBe('Cookie');
      }
      expect(warnings).toEqual([
        [
          'session-plugin: a per-visitor response carries a shared-cacheable Cache-Control set by the application',
          { method: 'GET', route: '/catalogue/:id', signal: 'session' },
        ],
      ]);
    } finally {
      await app.stop();
    }
  });

  it('a public directive on a response that commits session data becomes private', async () => {
    const app = await buildApp(strategy);
    try {
      const page = await app.inject(get('/public-write'));
      expect(page.headers.getSetCookie()).toHaveLength(1);
      expect(page.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      await app.stop();
    }
  });

  it('a missing asset starts no session; a navigation or an application write still does (V13-20)', async () => {
    const app = await buildApp(strategy);
    try {
      const image = await app.inject(get('/missing.png', { 'sec-fetch-dest': 'image' }));
      expect(image.statusCode).toBe(404);
      expect(image.headers.getSetCookie()).toEqual([]);
      expect(image.headers.get('cache-control')).toBe('private, no-store');
      const navigation = await app.inject(get('/missing.png', { 'sec-fetch-dest': 'document' }));
      expect(navigation.headers.getSetCookie()).toHaveLength(1);
      const safari = await app.inject(get('/missing.png', { accept: 'text/html,*/*' }));
      expect(safari.headers.getSetCookie()).toHaveLength(1);
      const written = await app.inject(get('/missing-write.png', { 'sec-fetch-dest': 'image' }));
      expect(written.headers.getSetCookie()).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });
});
