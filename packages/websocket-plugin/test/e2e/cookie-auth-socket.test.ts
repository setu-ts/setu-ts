/**
 * End-to-end, cookie-authenticated WebSocket tests — the real-socket half of
 * X3-5 (plans/milestone-73-realtime-authentication.md §3.7–§3.8).
 *
 * A REAL listening app (`SessionPlugin` + `AuthPlugin({ session })` +
 * `WebSocketPlugin`) bound to an ephemeral `127.0.0.1` port, driven by real
 * RFC 6455 handshakes. It proves:
 *
 *   (a) a valid session cookie completes the handshake and `onOpen` observes
 *       `context.user.id`; `ISessionService.fromHeaders(context.headers)`
 *       reads a value the login handler wrote;
 *   (b) an upgrade with NO cookie against the globally guarded path is
 *       refused (401) BEFORE the socket opens — no `onOpen`, no principal;
 *   (c) an upgrade with NO cookie against the unguarded path opens, then
 *       `onOpen` reads the absent `context.user` and closes with `1008`
 *       (policy violation).
 *
 * **How the session cookie reaches a real WebSocket client.** Deno's
 * `WebSocket` client takes only `(url, protocols)` — it exposes no way to
 * attach an arbitrary `Cookie` header, and it does not share a cookie jar
 * with `fetch` (verified on this runtime: a `Set-Cookie` captured from a
 * `fetch` login is NOT replayed on a subsequent `WebSocket` connect).
 * Scenario (a) therefore performs the handshake itself: a raw `Deno.connect`
 * socket writes the RFC 6455 upgrade request carrying the `Cookie` header
 * captured from the `fetch` login, and the test verifies the `101` response
 * and the `Sec-WebSocket-Accept` value (`base64(SHA-1(key + GUID))`). The
 * `onOpen` handler records what it observed and resolves a promise the test
 * awaits — so the assertion reads `context.user.id` and the `fromHeaders`
 * result directly, without parsing WebSocket frames back off the raw socket
 * (which would race the server's keep-alive ping frames). Scenarios (b) and
 * (c) use the plain `WebSocket` client — exactly the cookie-less case they
 * assert.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ISessionService, IWebSocketService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { authMiddleware, AuthPlugin, requireAuth } from '@setu-ts/auth-plugin';

import { WebSocketPlugin } from '../../src/index.ts';

/** Session secret (≥32 chars). */
const SESSION_SECRET = 'cookie-auth-socket-session-secret-32-chars';
/**
 * JWT secret (HS256). `AuthPlugin` requires JWT material at construction even
 * when only the session strategy is exercised; no bearer token is ever sent.
 */
const JWT_SECRET = 'cookie-auth-socket-jwt-secret-32-chars';
/** The default session cookie name (`SessionPlugin` default). */
const COOKIE_NAME = 'setu_session';
/** RFC 6455 §4.2.1 — the GUID appended to the client key for `Sec-WebSocket-Accept`. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Bounded wait for every socket event, so a scenario fails instead of hanging. */
const TIMEOUT_MS = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What `/protected`'s `onOpen` reports back to the test. */
interface ProtectedOpenObservation {
  readonly hasUser: boolean;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly sessionSub: unknown;
  readonly sessionPlan: unknown;
}

/** The outcome of a raw RFC 6455 upgrade handshake. */
interface RawHandshake {
  readonly conn: Deno.Conn;
  readonly statusLine: string;
  readonly headers: Headers;
  /** The `Sec-WebSocket-Key` this client generated, for the accept check. */
  readonly key: string;
}

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------

/**
 * Builds the real application: session middleware at 260 (registered by
 * `SessionPlugin`), `authMiddleware()` at 300 (the authentication band), and
 * a globally guarded path. The guard is pipeline middleware rather than a
 * route option because WebSocket routes live in the plugin's own route table
 * and have no middleware chain (plan §3.8) — a global guard is the mechanism
 * that refuses an upgrade before the handshake.
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
          // id when no explicit subject is present.
          toPrincipal: (view) => {
            const sub = view.data.sub;
            const id = typeof sub === 'string' && sub.length > 0 ? sub : view.id;
            return { id, roles: ['user'] };
          },
        },
      }),
      WebSocketPlugin(),
    ],
  });

  // Priority 300 is the band ARCHITECTURE.md §10 reserves for authentication;
  // a bare add() would take the kernel default of 500 and run after it.
  app.middleware.add(authMiddleware(), { priority: 300 });

  // The globally guarded path: `/protected` requires an authenticated
  // principal. Runs after the authentication band, so `ctx.request.user` is
  // already populated when the guard decides.
  const guard = requireAuth();
  app.middleware.add(
    (ctx, next) => (ctx.request.path === '/protected' ? guard(ctx, next) : next()),
    { priority: 310 },
  );

  // Login: write the identity into the session and let the session
  // middleware's commit emit the `Set-Cookie`. No `authorization` involved.
  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.set('sub', 'alice');
    session.set('plan', 'pro');
    return ctx.response.json({ ok: true });
  });

  return app;
}

/** Picks a free ephemeral port on 127.0.0.1 by binding and immediately releasing one. */
function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

// ---------------------------------------------------------------------------
// Raw RFC 6455 handshake — the only way to attach a Cookie header
// ---------------------------------------------------------------------------

/** Encodes a byte string as base64 (the web `btoa` takes a binary string). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** `base64(SHA-1(input))` — the `Sec-WebSocket-Accept` computation. */
async function sha1Base64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(input));
  return toBase64(new Uint8Array(digest));
}

/**
 * Opens a raw TCP connection and performs the RFC 6455 upgrade handshake,
 * carrying the session cookie when one is given. Returns the live connection
 * plus the parsed response head; the caller owns the socket.
 */
async function rawUpgrade(
  hostname: string,
  port: number,
  path: string,
  cookie: string | undefined,
): Promise<RawHandshake> {
  const conn = await Deno.connect({ hostname, port });
  const key = toBase64(crypto.getRandomValues(new Uint8Array(16)));

  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (cookie !== undefined) {
    lines.push(`Cookie: ${cookie}`);
  }
  await conn.write(encoder.encode(lines.join('\r\n') + '\r\n\r\n'));

  // Read the response head (and only the head — anything after `\r\n\r\n` is
  // frame data this handshake does not need to parse).
  let head = '';
  for (;;) {
    const chunk = new Uint8Array(4096);
    const read = await conn.read(chunk);
    if (read === null) {
      throw new Error('connection closed before the handshake response completed');
    }
    head += decoder.decode(chunk.subarray(0, read), { stream: true });
    const end = head.indexOf('\r\n\r\n');
    if (end !== -1) {
      head = head.slice(0, end + 4);
      break;
    }
  }

  const [statusLine, ...headerLines] = head.split('\r\n');
  const headers = new Headers();
  for (const line of headerLines) {
    if (line === '') {
      continue;
    }
    const separator = line.indexOf(':');
    headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }

  return { conn, statusLine: statusLine ?? '', headers, key };
}

/** Bounds a promise with a timeout so a stuck socket fails the test. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// The e2e
// ---------------------------------------------------------------------------

describe('cookie-authenticated WebSocket (e2e, real sockets)', () => {
  let app: IKernelApplication;
  let port: number;
  /** How many times `/protected`'s `onOpen` has run — the server-side "no principal" witness. */
  let protectedOpens = 0;
  /** Whether `/open`'s `onOpen` saw a `user` key in its context. */
  let openRouteSawUser = false;
  /** The resolver `/protected`'s `onOpen` hands its observation to. */
  let protectedOpenResolver: ((observation: ProtectedOpenObservation) => void) | null = null;

  beforeAll(async () => {
    app = buildApp();
    port = freePort();
    await app.start({ port, hostname: '127.0.0.1' });

    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    const sessions = app.services.get<ISessionService>(CAPABILITIES.SESSION);

    // The globally guarded path. `onOpen` proves the M73 bridge end to end:
    // `context.user` is the principal the session strategy produced from the
    // cookie, and `fromHeaders(context.headers)` re-opens the same session
    // from the upgrade request's headers. It records what it observed and
    // resolves the promise the test awaits — no frame parsing on the client.
    ws.route('/protected', {
      onOpen: async (_conn, context) => {
        protectedOpens++;
        const view = await sessions.fromHeaders(context.headers);
        const observation: ProtectedOpenObservation = {
          hasUser: 'user' in context,
          userId: context.user?.id ?? null,
          sessionId: view?.id ?? null,
          sessionSub: view?.data.sub ?? null,
          sessionPlan: view?.data.plan ?? null,
        };
        protectedOpenResolver?.(observation);
      },
    });

    // The unguarded path. `onOpen` reads the absent `context.user` and
    // closes with 1008 — the second documented refusal mechanism (plan §3.8).
    ws.route('/open', {
      onOpen: (conn, context) => {
        openRouteSawUser = 'user' in context;
        if (context.user === undefined) {
          conn.close(1008, 'authentication required');
        }
      },
    });
  });

  afterAll(async () => {
    await app.stop();
  });

  it('(a) a valid session cookie completes the handshake and onOpen observes the principal', async () => {
    // Step 1: log in over a real fetch and capture the session cookie the
    // session middleware committed.
    const login = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST' });
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie();
    expect(cookies.length).toBe(1);
    const setCookie = cookies[0];
    if (setCookie === undefined) {
      throw new Error('expected login to set a session cookie');
    }
    const cookie = setCookie.split(';')[0];
    expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);

    // Step 2: the RFC 6455 handshake itself, carrying the cookie. Deno's
    // WebSocket client cannot attach a Cookie header (see the module doc), so
    // the handshake is performed on a raw socket. The observation promise is
    // armed before the handshake so a fast `onOpen` cannot resolve before the
    // resolver exists.
    const observationPromise = new Promise<ProtectedOpenObservation>((resolve) => {
      protectedOpenResolver = resolve;
    });

    const handshake = await withTimeout(
      rawUpgrade('127.0.0.1', port, '/protected', cookie),
      TIMEOUT_MS,
      'the raw RFC 6455 handshake',
    );
    try {
      // A genuine 101 with a correct accept value: the handshake completed.
      // The guard passed, which is only possible if the cookie carried through
      // and the session strategy produced a principal — so the accept check is
      // what pins this as a real RFC 6455 handshake rather than a fake 101.
      expect(handshake.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
      const expectedAccept = await sha1Base64(handshake.key + WS_GUID);
      expect(handshake.headers.get('sec-websocket-accept')).toBe(expectedAccept);

      // Step 3: await what onOpen observed.
      const observation = await withTimeout(
        observationPromise,
        TIMEOUT_MS,
        'the onOpen observation',
      );

      // The principal threaded through routeUpgrade is the one the session
      // strategy mapped from the cookie.
      expect(observation.hasUser).toBe(true);
      expect(observation.userId).toBe('alice');
      // And the headers-only session read sees the values login wrote.
      expect(observation.sessionId).not.toBeNull();
      expect(observation.sessionSub).toBe('alice');
      expect(observation.sessionPlan).toBe('pro');
    } finally {
      handshake.conn.close();
    }
  });

  it('(b) no cookie against the guarded path is refused before the socket opens', async () => {
    const opensBefore = protectedOpens;

    // The client-side observable contract: a real WebSocket client with no
    // cookie. The guard answers 401 before the upgrade intent is written, so
    // the handshake never completes — onopen must not fire.
    const client = new WebSocket(`ws://127.0.0.1:${port}/protected`);
    let opened = false;
    const closeEvent = new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), TIMEOUT_MS);
      client.onclose = (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
    client.onopen = (): void => {
      opened = true;
    };
    client.onerror = (): void => {
      // Expected: a refused handshake surfaces as error + close on the client.
    };

    // `onclose` only fires once the connection attempt is fully over, so
    // checking `opened` afterwards is deterministic — no arbitrary window.
    const close = await closeEvent;
    expect(opened).toBe(false);
    // A refused handshake is never a normal close; the exact code is
    // runtime-observable (1006) but not pinned here.
    expect(close.wasClean).toBe(false);
    expect(close.code).not.toBe(1000);

    // The server-side half of the same refusal: the upgrade request is
    // answered 401 by the guard before any socket is opened, and the route's
    // onOpen never ran — no connection, no principal. `app.fetch` (not the
    // global `fetch`) is used: the fetch algorithm strips forbidden request
    // headers (`Upgrade`, `Connection`) when dispatching, so a global fetch
    // would arrive as a plain GET — and a plain GET on an unregistered path
    // is a 404, not the 401 this asserts. `app.fetch` hands the Request to
    // the adapter's handler, where the raw upgrade headers survive to the
    // pipeline — the same pattern guarded-upgrade.test.ts uses.
    const refused = await app.fetch(
      new Request(`http://127.0.0.1:${port}/protected`, {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      }),
    );
    expect(refused.status).toBe(401);
    expect(protectedOpens).toBe(opensBefore);
  });

  it('(c) no cookie against the unguarded path opens, then closes 1008', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/open`);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for open')), TIMEOUT_MS);
      client.onopen = (): void => {
        clearTimeout(timer);
        resolve();
      };
      client.onerror = (): void => {
        clearTimeout(timer);
        reject(new Error('socket errored before opening'));
      };
    });
    const closeEvent = new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), TIMEOUT_MS);
      client.onclose = (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
    });

    try {
      // The unguarded path admits the anonymous upgrade: the socket opens.
      await opened;
      // …and onOpen, reading the absent context.user, closes it with 1008
      // (policy violation). The code is pinned because this test's own onOpen
      // handler is what sends it.
      const close = await closeEvent;
      expect(close.code).toBe(1008);
      // The server-side witness: onOpen ran and saw no user key.
      expect(openRouteSawUser).toBe(false);
    } finally {
      client.close();
    }
  });
});
