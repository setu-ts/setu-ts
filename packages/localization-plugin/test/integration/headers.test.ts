/**
 * The two response headers through a REAL kernel app and `app.fetch` — not
 * `inject()`, which skips the response mapper (the M97b finding).
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';
import { replaceLocale } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';

import { LocalizationPlugin, localizerFor } from '../../src/index.ts';
import type { LocalizationPluginOptions } from '../../src/index.ts';
import { CATALOGUES } from '../fixtures/catalogues.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(
  extra: Partial<LocalizationPluginOptions> = {},
): Promise<IKernelApplication> {
  app = await createTestApp({
    autoStart: false,
    plugins: [
      RuntimePlugin(),
      LocalizationPlugin({
        supportedLocales: ['en', 'de', 'fr'],
        catalogues: CATALOGUES,
        ...extra,
      } as LocalizationPluginOptions),
    ],
  });
  // A CORS-like stage that varies on Origin, earlier in the pipeline.
  app.middleware.add(async (ctx, next) => {
    ctx.response.appendHeader('Vary', 'Origin');
    await next();
  }, { priority: 10 });
  app.router.get('/page', (ctx) => ctx.response.text(localizerFor(ctx).t('title')));
  app.router.get('/replace', (ctx) => {
    replaceLocale(ctx.request, 'de');
    return ctx.response.text(localizerFor(ctx).t('title'));
  });
  app.router.get('/own', (ctx) => ctx.response.header('Content-Language', 'fr').text('x'));
  app.router.get('/boom', () => {
    throw new Error('handler failed');
  });
  app.router.get('/health', (ctx) => ctx.response.text('ok'));
  await app.start();
  return app;
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app!.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe('localization headers through a real application', () => {
  it('answers in the negotiated locale with Vary and Content-Language', async () => {
    await start();
    const response = await get('/page', { 'accept-language': 'fr-CA, en;q=0.5' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Panier');
    expect(response.headers.get('content-language')).toBe('fr');
    expect(response.headers.get('vary')).toBe('Origin, Accept-Language, Cookie');
  });

  it('drops Cookie from Vary when the cookie source is disabled', async () => {
    await start({ middleware: { cookie: false } });
    const response = await get('/page');
    await response.body?.cancel();
    expect(response.headers.get('vary')).toBe('Origin, Accept-Language');
  });

  it('follows a replaceLocale made by the handler', async () => {
    await start();
    const response = await get('/replace', { 'accept-language': 'fr' });
    expect(await response.text()).toBe('Warenkorb');
    expect(response.headers.get('content-language')).toBe('de');
  });

  it('preserves a handler-set Content-Language', async () => {
    await start();
    const response = await get('/own', { 'accept-language': 'de' });
    await response.body?.cancel();
    expect(response.headers.get('content-language')).toBe('fr');
  });

  it('writes no Content-Language on an error response', async () => {
    await start();
    const response = await get('/boom', { 'accept-language': 'de' });
    await response.body?.cancel();
    expect(response.status).toBe(500);
    expect(response.headers.has('content-language')).toBe(false);
  });

  it('leaves excluded paths alone', async () => {
    await start();
    const response = await get('/health', { 'accept-language': 'de' });
    await response.body?.cancel();
    expect(response.headers.has('content-language')).toBe(false);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('never writes client text into a header', async () => {
    await start();
    const response = await get('/page?locale=en%0D%0AX-Injected:1');
    expect(await response.text()).toBe('Cart');
    expect(response.headers.has('x-injected')).toBe(false);
    expect(response.headers.get('content-language')).toBe('en');
  });
});
