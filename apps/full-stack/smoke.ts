/**
 * Smoke check for the full-stack example.
 *
 * The rendered pages are evidence, not decoration: the products page must
 * show rows written through the database capability, and the login form must
 * round-trip the session's CSRF token. Driven through `app.fetch`, because the
 * SSR body is a stream and the login step reads `Set-Cookie`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';
import { formatPrice } from '~/models/product.ts';
import type { Product } from '~/models/product.ts';
import { seedProducts } from '~/services/products.server.ts';

const ORIGIN = 'http://full-stack.test';

/** Pulls the hidden CSRF field out of the rendered login form. */
function readCsrfToken(html: string): string {
  const token = /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'the login form rendered no CSRF token');
  return token;
}

/** Collects the cookies a response set, as a single request header value. */
function readCookies(response: Response): string {
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]);
  assert.ok(cookies.length > 0, 'no session cookie was set');
  return cookies.join('; ');
}

describe('full-stack example', () => {
  let app: IKernelApplication;
  let seeded: readonly Product[];

  const get = (path: string): Promise<Response> => app.fetch(new Request(`${ORIGIN}${path}`));

  before(async () => {
    app = await createApp();
    await app.start();
    seeded = await seedProducts(app.services.get<IDatabaseService>(CAPABILITIES.DATABASE));
    assert.ok(seeded.length > 0, 'seeding produced no products');
  });

  after(async () => {
    await app.stop();
  });

  it('server-renders the products written through the database capability', async () => {
    const response = await get('/products');
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /<h1>Products/);
    // Asserted by name and price rather than by count: React splits rendered
    // numbers with comment markers, so `Products (2)` is not a literal substring.
    for (const product of seeded) {
      assert.ok(
        html.includes(product.name) && html.includes(formatPrice(product)),
        `"${product.name}" is missing: the load context did not reach the loader`,
      );
    }
  });

  it('renders a landing page at /, not an empty layout', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    const html = await response.text();

    // A missing index route answers 200 with an empty <body>, so assert content.
    assert.match(html, /<h1>/);
    assert.match(html, /href="\/products"/);
  });

  it('serves the OpenAPI document beside the SSR catch-all', async () => {
    const response = await get('/openapi.json');

    assert.equal(response.status, 200, 'the SSR catch-all is shadowing /openapi.json');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(typeof (await response.json()).openapi, 'string');
  });

  it('serves Swagger UI beside the SSR catch-all', async () => {
    const response = await get('/docs');

    assert.equal(response.status, 200);
    assert.match(await response.text(), /swagger/);
  });

  it("renders a refused document through React Router's error boundary", async () => {
    const response = await get('/forbidden');

    assert.equal(response.status, 403);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Route boundary refusal:/);
  });

  it('accepts a login form that echoes the session CSRF token', async () => {
    const loginPage = await get('/login');
    assert.equal(loginPage.status, 200);
    const csrfToken = readCsrfToken(await loginPage.text());

    const submitted = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: readCookies(loginPage),
        },
        body: new URLSearchParams({
          _csrf: csrfToken,
          email: 'reader@example.test',
          password: 'x',
        }),
      }),
    );

    // 403 would mean the synchronizer token did not round-trip through the session.
    assert.equal(submitted.status, 302);
    assert.equal(submitted.headers.get('location'), '/products');
  });
});
