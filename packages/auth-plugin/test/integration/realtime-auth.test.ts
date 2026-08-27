/**
 * Integration test — session-backed passive authentication over HTTP and SSE.
 *
 * This is the negative-control harness for milestone 73, controls #1–#4
 * (plans/milestone-73-realtime-authentication.md §6). It proves, end to end,
 * that a session cookie (with NO `authorization` header) authenticates a normal
 * HTTP route AND an SSE route — the `EventSource` row of X3-5 — and that
 * bearer-then-cookie precedence is correct (§3.6: jwt → api-key → session).
 *
 * The app is a REAL `createApplication` combining:
 *   - `RuntimePlugin` (runtime + HTTP adapter, so `app.fetch` works),
 *   - `SessionPlugin` (registers `sessionMiddleware` at priority 260),
 *   - `AuthPlugin({ jwt, session })` (appends the internal `SessionStrategy`),
 *   - `SsePlugin` (the SSE hub the `/events` route streams through),
 *   - `authMiddleware()` added at priority 300 (the authentication band),
 *   - a `requireAuth()` route guard on `/me` and `/events`.
 *
 * Every step is driven with `app.fetch` (a web `Request` → web `Response`),
 * never `inject()`: step 1 reads the `Set-Cookie` header and step 3 answers
 * with a live stream, both of which `inject()` cannot present.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService, ISseService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';

import { authMiddleware, AuthPlugin, requireAuth } from '../../src/index.ts';

/** Session secret (≥32 chars). */
const SESSION_SECRET = 'realtime-auth-session-secret-at-least-32-chars';
/** JWT secret (HS256). */
const JWT_SECRET = 'realtime-auth-jwt-secret-at-least-32-chars';
/** Base URL for the web `Request`s handed to `app.fetch` (no real socket). */
const BASE = 'http://localhost';
/** The default session cookie name (`SessionPlugin` default). */
const COOKIE_NAME = 'setu_session';

/**
 * Builds the real application under test.
 *
 * `SessionPlugin` registers `sessionMiddleware` at priority 260 (after security
 * headers, before authentication). `authMiddleware()` is added at 300 so the
 * strategy chain runs after the session has loaded. `requireAuth()` guards the
 * two routes that must not be reachable anonymously.
 */
function buildApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SESSION_SECRET }),
      AuthPlugin({
        jwt: { secret: JWT_SECRET },
        session: {
          // The one place that knows where an identity lives in the payload:
          // the login handler stores it under `sub`. Fall back to the session
          // id when no explicit subject is present (type-safe form of
          // `view.data.sub ?? view.id`).
          toPrincipal: (view) => {
            const sub = view.data.sub;
            const id = typeof sub === 'string' && sub.length > 0 ? sub : view.id;
            return { id, roles: ['user'] };
          },
        },
      }),
      SsePlugin({ scalingNotice: false }),
    ],
  });

  // Priority 300 is the band ARCHITECTURE.md §10 reserves for authentication;
  // a bare add() would take the kernel default of 500 and run after it.
  app.middleware.add(authMiddleware(), { priority: 300 });

  // Login: create a session, store the identity, and let the session
  // middleware's commit write the `Set-Cookie`. No `authorization` involved.
  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.set('sub', 'alice');
    return ctx.response.status(200).json({ ok: true });
  });

  // Normal route, guarded: echoes the authenticated principal id.
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ id: ctx.request.user!.id }),
  });

  // SSE route, guarded: the `EventSource` row of X3-5. A cookie-only request
  // must be admitted exactly as a bearer request is, and the streamed frame
  // carries the principal the strategy produced.
  app.router.get('/events', {
    middleware: [requireAuth()],
    handler: (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse.open(ctx);
      conn.send({ data: `hello ${ctx.request.user!.id}` });
      // Close synchronously so the stream terminates and `app.fetch`'s response
      // body can be read to completion without a timer.
      conn.close();
      return conn.result;
    },
  });

  return app;
}

/** The `name=value` part of the first `Set-Cookie`, ready to send back. */
function firstCookie(headers: Headers): string {
  const cookies = headers.getSetCookie();
  expect(cookies.length).toBe(1);
  const cookie = cookies[0].split(';')[0];
  expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
  return cookie;
}

describe('session-backed passive auth (HTTP + SSE)', () => {
  let app: IKernelApplication;
  let cookie: string;
  let jwtToken: string;

  beforeAll(async () => {
    app = buildApp();
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('step 1 — login: creates a session and sets the session cookie', async () => {
    const login = await app.fetch(new Request(`${BASE}/login`, { method: 'POST' }));
    expect(login.status).toBe(200);

    // Capture the session cookie the middleware committed.
    cookie = firstCookie(login.headers);

    // Sign a bearer token for the precedence step (step 5).
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    jwtToken = await jwt.sign({ sub: 'jwt-user', roles: ['admin'] });
  });

  it('step 2 — passive auth on a normal route (cookie, NO authorization) → 200', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/me`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    // Proves SessionStrategy.fromHeaders → toPrincipal produced a principal
    // from the cookie alone, with no `authorization` header present.
    expect(body.id).toBe('alice');
  });

  it('step 3 — passive auth on an SSE route (cookie, NO authorization) → 200 event-stream', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/events`, {
        headers: { cookie, accept: 'text/event-stream' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // The stream is terminated by the handler's `conn.close()`, so it can be
    // read to completion. The frame carries the principal the cookie produced,
    // proving the guarded SSE route admitted an `EventSource`-shaped request.
    const text = await res.text();
    expect(text).toContain('data: hello alice');
  });

  it('step 4 — no cookie → 401', async () => {
    const res = await app.fetch(new Request(`${BASE}/me`));
    expect(res.status).toBe(401);
  });

  it('step 5 — bearer + cookie → the jwt principal wins (pins §3.6 order)', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/me`, {
        headers: { cookie, authorization: `Bearer ${jwtToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    // The jwt strategy runs before the session strategy in the assembled chain
    // (jwt → api-key → session → caller), so the explicit bearer credential
    // wins over the cookie.
    expect(body.id).toBe('jwt-user');
  });
});
