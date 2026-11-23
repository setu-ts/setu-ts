/**
 * Swagger UI "Try it out" under form CSRF, in real Chromium (V13-60).
 *
 * A local application (kernel, the session plugin with form CSRF, this plugin self-hosting Swagger
 * UI) is served over a real socket and driven through Playwright. Skips with a named reason when
 * Chromium cannot be launched.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { CREDENTIAL_SOURCE_STATE_KEY } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';

import { OpenApiPlugin } from '../../src/index.ts';

const SECRET = 'swagger-browser-session-secret-at-least-32-chars';

let browser: Browser | undefined;
let skipReason: string | undefined;
try {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: 'chromium' });
} catch (error) {
  skipReason = `Chromium could not be launched: ${(error as Error).message.split('\n')[0]}`;
}

/** Serves a fetch handler over node:http. */
function serve(
  handler: (request: Request) => Promise<Response>,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
      void handler(
        new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      ).then(async (response) => {
        const out: Record<string, string | string[]> = {};
        response.headers.forEach((value, name) => {
          if (name !== 'set-cookie') out[name] = value;
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** Marks a request carrying `Authorization` as header-authenticated, as a bearer strategy does. */
const bearerStrategy: IPlugin = {
  name: 'test-bearer',
  version: '1.0.0',
  register(ctx) {
    ctx.middleware.add(
      async (c, next) => {
        if (c.request.headers.get('authorization')?.startsWith('Bearer ') === true) {
          c.state.set(CREDENTIAL_SOURCE_STATE_KEY, 'header');
        }
        await next();
      },
      { priority: 300, name: 'test-bearer' },
    );
  },
};

interface Harness {
  app: IKernelApplication;
  server: Server;
  origin: string;
  idp: { server: Server; origin: string; seen: Array<Record<string, string>> };
  tokenRouteCalls: () => number;
  ordersCalls: () => number;
}

let harness: Harness | undefined;

/** The directory of swagger-ui-dist 5.0.0, the floor of the `^5` peer range. */
let floorDirectory: string | undefined;
try {
  const mod = await import('swagger-ui-dist-floor/absolute-path.js');
  floorDirectory = mod.default();
} catch {
  floorDirectory = undefined;
}

/** The Swagger UI versions the suite runs on: the pinned one, and the peer-range floor. */
const VERSIONS: ReadonlyArray<readonly [string, string | undefined]> = [
  ['5.33.3 (the pinned version)', undefined],
  ['5.0.0 (the peer-range floor)', floorDirectory ?? 'missing'],
];

async function start(): Promise<Harness> {
  const seen: Array<Record<string, string>> = [];
  const idp = await serve((request) => {
    seen.push(Object.fromEntries(request.headers.entries()));
    return Promise.resolve(
      new Response(
        request.method === 'OPTIONS' ? null : '{"access_token":"t","token_type":"bearer"}',
        {
          status: request.method === 'OPTIONS' ? 204 : 200,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'content-type': 'application/json',
          },
        },
      ),
    );
  });
  let tokenCalls = 0;
  let ordersCalls = 0;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      bearerStrategy,
      SessionPlugin({ secret: SECRET, csrf: {}, cookie: { secure: false } }),
      OpenApiPlugin({
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          oauth: {
            type: 'oauth2',
            flows: { password: { tokenUrl: `${idp.origin}/token`, scopes: {} } },
          },
        },
        // Authorized schemes are sent only on operations that list them.
        security: [{ bearer: [] }],
      }),
    ],
  });
  app.middleware.add(
    async (c, next) => {
      if (c.request.path === '/docs/csrf-token') tokenCalls += 1;
      await next();
    },
    { priority: 5, name: 'count-token-route' },
  );
  app.router.get('/signin', (ctx) => {
    getSession(ctx).set('userId', 'alice');
    return ctx.response.text('signed in');
  });
  app.router.post('/orders', (ctx) => {
    ordersCalls += 1;
    return ctx.response.status(201).json({ ok: true });
  });
  await app.start();
  const { server, origin } = await serve((request) => app.fetch(request));
  return {
    app,
    server,
    origin,
    idp: { ...idp, seen },
    tokenRouteCalls: () => tokenCalls,
    ordersCalls: () => ordersCalls,
  };
}

beforeAll(async () => {
  if (browser !== undefined) harness = await start();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (harness !== undefined) {
    await harness!.app.stop();
    harness!.server.close();
    harness!.idp.server.close();
  }
});

/**
 * Opens the docs page. `assets` serves the Swagger UI files from another swagger-ui-dist
 * directory; `withoutInterceptor` strips the interceptor from the served page.
 */
async function openDocs(
  page: Page,
  assets: string | undefined,
  withoutInterceptor = false,
): Promise<void> {
  const h = harness!;
  if (assets !== undefined) {
    await page.route(/\/docs\/swagger-ui[^/]*\.(js|css)$/, async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').pop()!;
      await route.fulfill({
        body: await readFile(`${assets}/${file}`),
        contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript',
      });
    });
  }
  if (withoutInterceptor) {
    await page.route(`${h.origin}/docs`, async (route) => {
      const response = await route.fetch();
      const page = await response.text();
      // The interceptor's source spans several lines, up to its `(<token url>, window),` call.
      const html = page.replace(/\n\s*requestInterceptor: [\s\S]*?, window\),/, '');
      if (html === page) throw new Error('the interceptor was not found in the page');
      await route.fulfill({ response, body: html });
    });
  }
  await page.goto(`${h.origin}/docs`);
  await page.waitForSelector('.opblock-summary');
}

/** Runs Try-it-out on `POST /orders` and returns the sent request's headers and the status. */
async function tryPostOrders(
  page: Page,
): Promise<{ headers: Record<string, string>; status: number }> {
  const h = harness!;
  await page.click('.opblock-post .opblock-summary');
  await page.click('.opblock-post .try-out__btn');
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url() === `${h.origin}/orders` && r.request().method() === 'POST',
    ),
    page.click('.opblock-post .execute'),
  ]);
  return { headers: response.request().headers(), status: response.status() };
}

(browser === undefined ? describe.skip : describe).each(VERSIONS)(
  `Swagger UI %s Try-it-out in real Chromium${skipReason === undefined ? '' : ` — skipped: ${skipReason}`}`,
  (_version, assets) => {
    it('has its assets installed', () => {
      expect(assets).not.toBe('missing');
    });

    it('an anonymous visit to the docs page, spec and assets sets no cookie', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await openDocs(page, assets);
        expect(await context.cookies()).toEqual([]);
        const token = await page.evaluate(async () => (await fetch('/docs/csrf-token')).status);
        expect(token).toBe(204);
        expect(await context.cookies()).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it('a signed-in Try-it-out POST under form CSRF carries the token and passes', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${harness!.origin}/signin`);
        await openDocs(page, assets);
        const sent = await tryPostOrders(page);
        expect(sent.headers['x-csrf-token']).toBeDefined();
        expect(sent.status).toBe(201);
      } finally {
        await context.close();
      }
    });

    it('the same with Authorize and a bearer token passes', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${harness!.origin}/signin`);
        await openDocs(page, assets);
        await page.evaluate(() => {
          const ui = (
            globalThis as unknown as { ui: { preauthorizeApiKey: (n: string, v: string) => void } }
          ).ui;
          ui.preauthorizeApiKey('bearer', 'test-token');
        });
        const sent = await tryPostOrders(page);
        expect(sent.headers.authorization).toBe('Bearer test-token');
        expect(sent.headers['x-csrf-token']).toBeDefined();
        expect(sent.status).toBe(201);
      } finally {
        await context.close();
      }
    });

    it('with the interceptor removed, the signed-in Try-it-out POST is refused 403', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${harness!.origin}/signin`);
        await openDocs(page, assets, true);
        const sent = await tryPostOrders(page);
        expect(sent.headers['x-csrf-token']).toBeUndefined();
        expect(sent.status).toBe(403);
      } finally {
        await context.close();
      }
    });

    it('an OAuth2 password authorize to another origin carries no CSRF token and fetches none', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${harness!.origin}/signin`);
        await openDocs(page, assets);
        const before = harness!.tokenRouteCalls();
        harness!.idp.seen.length = 0;
        await page.click('.btn.authorize');
        await page.fill('#oauth_username', 'u');
        await page.fill('#oauth_password', 'p');
        await Promise.all([
          page.waitForResponse(
            (r) => r.url().startsWith(harness!.idp.origin) && r.request().method() === 'POST',
          ),
          page.click('.auth-container:has(#oauth_username) .btn.modal-btn.auth.authorize'),
        ]);
        expect(harness!.idp.seen.length).toBeGreaterThan(0);
        for (const headers of harness!.idp.seen) {
          expect(headers['x-csrf-token']).toBeUndefined();
          expect(headers['access-control-request-headers'] ?? '').not.toContain('x-csrf-token');
        }
        expect(harness!.tokenRouteCalls()).toBe(before);
      } finally {
        await context.close();
      }
    });

    it('a cross-site page cannot read the token route, and its form POST is refused', async () => {
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${harness!.origin}/signin`);
        await page.goto(`${harness!.idp.origin}/elsewhere`);
        const read = await page.evaluate(async (origin) => {
          try {
            const response = await fetch(`${origin}/docs/csrf-token`, { credentials: 'include' });
            return `read ${response.status}`;
          } catch {
            return 'blocked';
          }
        }, harness!.origin);
        expect(read).toBe('blocked');
        const before = harness!.ordersCalls();
        await page.evaluate(async (origin) => {
          await fetch(`${origin}/orders`, {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'x=1',
          });
        }, harness!.origin);
        // Refused by form CSRF before the handler ran.
        expect(harness!.ordersCalls()).toBe(before);
      } finally {
        await context.close();
      }
    });
  },
);
