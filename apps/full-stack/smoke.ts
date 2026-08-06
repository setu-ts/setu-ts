/**
 * Smoke check for the full-stack example.
 *
 * Proves one behaviour end to end, in three steps:
 *
 * 1. A row is written through the database capability.
 * 2. An SSR-rendered route returns HTML containing that row — so the page is
 *    evidence that `populateLoadContext` bridged the kernel's service registry
 *    into a React Router loader, not that a server started.
 * 3. A `<Form>` login round-trips the session's CSRF token and is accepted,
 *    which is the session and form-CSRF capabilities standing in for the
 *    `lib/session.server.ts` and `lib/csrf.server.ts` a conventional React
 *    Router app hand-rolls.
 *
 * The application is driven through `app.fetch`, never `app.inject()`: the SSR
 * body is a `ReadableStream` and step 3 needs the response's `Set-Cookie`,
 * neither of which `inject` exposes.
 */
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IDatabaseService } from '@hono-enterprise/database-plugin';

import { createApp } from './honoe.config.ts';
import { formatPrice } from '~/models/product.ts';
import { seedProducts } from '~/services/products.server.ts';

const ORIGIN = 'http://full-stack.test';

/** Fails the smoke with a message; `check:apps` reads a non-zero exit. */
function fail(message: string): never {
  throw new Error(message);
}

/** Pulls the hidden CSRF field out of the rendered login form. */
function readCsrfToken(html: string): string {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match?.[1] ?? fail('The login form rendered no CSRF token.');
}

/** Collects the cookies a response set, as a single request header value. */
function readCookies(response: Response): string {
  const cookies = response.headers.getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0]);
  return cookies.length > 0 ? cookies.join('; ') : fail('No session cookie was set.');
}

const app = await createApp();
await app.start();
try {
  // 1 — write through the capability.
  const seeded = await seedProducts(
    app.services.get<IDatabaseService>(CAPABILITIES.DATABASE),
  );
  if (seeded.length === 0) fail('Seeding produced no products.');

  // 2 — read it back through server-side rendering.
  const rendered = await app.fetch(new Request(`${ORIGIN}/products`));
  if (rendered.status !== 200) {
    fail(
      `Expected the SSR products route to answer 200, received ${rendered.status}.`,
    );
  }
  const html = await rendered.text();
  // Every seeded row, name and formatted price. Asserting the whole set rather
  // than a count, because React SSR splits interpolated text with comment
  // markers (`Products (<!-- -->2<!-- -->)`), so a rendered number is not a
  // literal substring — and the set is the stronger claim anyway.
  for (const seededProduct of seeded) {
    if (
      !html.includes(seededProduct.name) ||
      !html.includes(formatPrice(seededProduct))
    ) {
      fail(
        `The SSR page did not render the seeded product "${seededProduct.name}" at ` +
          `${formatPrice(seededProduct)} — the load-context bridge is not delivering the ` +
          'database capability to the loader.',
      );
    }
  }
  if (!html.includes('<h1>Products')) {
    fail('The SSR page did not render the products view.');
  }

  // 2b — the ROOT path. Requested explicitly because it is the one URL a human
  // opens first and the only one no other check covered: `/` matched a
  // `layout()` with no child, so `<Outlet />` rendered nothing and the server
  // answered 200 with an EMPTY document. A status assertion alone would have
  // passed — the page was blank, not broken — so this asserts visible content.
  const landing = await app.fetch(new Request(`${ORIGIN}/`));
  if (landing.status !== 200) {
    fail(`Expected the index route to answer 200, received ${landing.status}.`);
  }
  const landingHtml = await landing.text();
  if (!landingHtml.includes('<h1>')) {
    fail(
      'The index route rendered no heading. A 200 with an empty <body> is what a missing index ' +
        'route looks like: the layout matches, its Outlet has no child, and the page is blank.',
    );
  }
  if (!landingHtml.includes('href="/products"')) {
    fail('The index route did not link to /products.');
  }

  // 3 — the session and its form CSRF token, through the same SSR path.
  const loginPage = await app.fetch(new Request(`${ORIGIN}/login`));
  if (loginPage.status !== 200) {
    fail(
      `Expected the login route to answer 200, received ${loginPage.status}.`,
    );
  }
  const csrfToken = readCsrfToken(await loginPage.text());
  const cookies = readCookies(loginPage);

  const submitted = await app.fetch(
    new Request(`${ORIGIN}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies,
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        email: 'reader@example.test',
        password: 'x',
      }),
    }),
  );
  if (submitted.status !== 302) {
    fail(
      `Expected the CSRF-protected login to redirect (302), received ${submitted.status}. ` +
        'A 403 means the synchronizer token did not round-trip through the session.',
    );
  }
  if (submitted.headers.get('location') !== '/products') {
    fail(
      `Expected a redirect to /products, received ${submitted.headers.get('location')}.`,
    );
  }
} finally {
  await app.stop();
}

// Reached only when every assertion above passed: a failure throws, and an
// uncaught top-level rejection exits non-zero before this line.
//
// The exit is explicit because importing `react-dom/server` under Deno leaves
// the process alive after the application has stopped. Measured three ways:
// importing it ALONE in an otherwise empty script never exits (`timeout` reports
// 124); `deno test`'s op and resource sanitizers report nothing leaked, so it is
// not a handle the framework or this example owns; and the same script with the
// `reactRouter` arm removed exits cleanly. `main.ts` is unaffected — a server is
// supposed to keep running.
Deno.exit(0);
