import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IKernelApplication } from '@setu-ts/kernel';
import { errorHandler } from '@setu-ts/exceptions';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';

import { LocalizationPlugin } from '../../src/index.ts';
import { EN } from '../fixtures/catalogues.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(options: { cacheControl?: string; expose?: boolean } = {}) {
  app = await createTestApp({
    autoStart: false,
    plugins: [
      RuntimePlugin(),
      LocalizationPlugin({
        supportedLocales: ['en', 'de-AT'],
        // A partial locale: its served catalogue must carry the default's
        // messages too, as the server's `t()` does.
        catalogues: { en: EN, 'de-AT': { title: 'Warenkorb' } },
        allowPartialCatalogues: true,
        ...(options.expose === false ? {} : {
          exposeCatalogues: {
            basePath: '/i18n',
            ...(options.cacheControl === undefined ? {} : { cacheControl: options.cacheControl }),
          },
        }),
      }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0 });
  await app.start();
}

const get = (path: string) => app!.fetch(new Request(`http://localhost${path}`));

describe('the catalogue route', () => {
  it('serves a supported locale, overlaid on the default, with cache headers', async () => {
    await start();
    const response = await get('/i18n/de-AT');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('content-language')).toBe('de-AT');
    expect(await response.json()).toEqual({
      locale: 'de-AT',
      messages: { ...EN, title: 'Warenkorb' },
    });
  });

  it('honours a configured Cache-Control', async () => {
    await start({ cacheControl: 'no-store' });
    const response = await get('/i18n/en');
    await response.body?.cancel();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers an unknown locale with a fixed Problem Details 404 that echoes nothing', async () => {
    await start();
    const response = await get('/i18n/%3Cscript%3E');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe('about:blank');
    expect(body.title).toBe('Not Found');
    expect(body.status).toBe(404);
    expect(body.detail).toBe('Unknown locale');
    expect(body).not.toHaveProperty('message');
    // The detail is fixed; the only request-derived member is the responder's
    // standard `instance` — the request path, percent-encoded as received —
    // which every Problem Details response in the application carries.
    expect(body.instance).toBe('/i18n/%3Cscript%3E');
    expect(JSON.stringify(body)).not.toContain('<');
  });

  it('is exact: a non-canonical spelling is not served', async () => {
    await start();
    const response = await get('/i18n/de-at');
    await response.body?.cancel();
    expect(response.status).toBe(404);
  });

  it('registers nothing when exposeCatalogues is absent', async () => {
    await start({ expose: false });
    const response = await get('/i18n/en');
    await response.body?.cancel();
    expect(response.status).toBe(404);
  });
});
