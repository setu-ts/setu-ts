/**
 * The documented CSRF sequence, composed with the documented session-fixation
 * login (M90h §3.4).
 *
 * X33-2: with `SessionPlugin({ csrf: {} })` — the registration `PUBLIC_API.md`
 * shows — a bare `POST /login` is refused `403` before it can mint a token,
 * because the token lives in the session that does not exist yet. The README's
 * `## Session fixation` example is exactly `app.router.post('/login', …)`
 * calling `session.set()`/`session.regenerate()`; composed with the `csrf: {}`
 * from the same README it `403`s. Two documented features of one plugin, both
 * correct alone, that do not work together as written.
 *
 * The fix is the sequence, not an exemption: `csrfFormMiddleware` verifies
 * every method outside `ignoreMethods` and an exemption for `/login` would be a
 * hole (X33-2 records this is the right design). So the README now documents
 * the two-step sequence — a safe request that mints the session and its token
 * via `getCsrfToken(ctx)`, then the mutation carrying it — and this test drives
 * exactly that against `SessionPlugin({ csrf: {} })`, plus the fixation login
 * in the same application.
 *
 * The successful path is asserted FIRST, so the file cannot pass vacuously the
 * way X33-2's own harness did: there every attack was refused for the wrong
 * reason because the victim had never logged in. A live session and a
 * successful legitimate mutation are established before anything about refusal
 * is asserted.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { getCsrfToken, getSession, SessionPlugin } from '../../src/index.ts';

const SECRET = 'documented-csrf-sequence-at-least-32-char';

/**
 * The README's two sections, composed in one app: a safe `GET /login` that
 * mints the token (the `## Form CSRF` example) and a `POST /login` that is the
 * `## Session fixation` example verbatim — `session.set()` then
 * `session.regenerate()`.
 */
function buildApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, csrf: {} })],
  });

  app.router.get('/login', (ctx) => {
    const session = getSession(ctx);
    const token = getCsrfToken(ctx); // minted on first call, then stable
    return ctx.response.json({ token, id: session.id });
  });

  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.set('userId', 'alice');
    session.regenerate(); // new id, same data
    return ctx.response.json({ ok: true, id: session.id });
  });

  app.router.get('/read', (ctx) => {
    const session = getSession(ctx);
    return ctx.response.json({ userId: session.get<string>('userId') ?? null, id: session.id });
  });

  return app;
}

/** The `name=value` part of the first `Set-Cookie`, ready to send back. */
function cookieOf(headers: Headers): string {
  const raw = headers.get('set-cookie');
  expect(raw).not.toBe(null);
  return (raw as string).split(';')[0];
}

describe('documented CSRF sequence (X33-2)', () => {
  it('the safe-request-then-mutation sequence answers 200 and the fixation login runs', async () => {
    const app = buildApp();
    await app.start();
    try {
      // Step 1: the safe request mints the session and its token.
      const get = await app.inject({ method: 'GET', url: 'http://localhost/login' });
      expect(get.statusCode).toBe(200);
      const { token, id: loginId } = get.json<{ token: string; id: string }>();
      expect(token).not.toBe('');
      const cookie = cookieOf(get.headers);

      // Step 2: the mutation presents the cookie AND the token. This is the
      // `## Session fixation` example — set the user, regenerate the id.
      const post = await app.inject({
        method: 'POST',
        url: 'http://localhost/login',
        headers: { cookie, 'x-csrf-token': token },
      });
      expect(post.statusCode).toBe(200);
      const { ok, id: regeneratedId } = post.json<{ ok: boolean; id: string }>();
      expect(ok).toBe(true);
      // regenerate() produced a NEW id — the whole point of the fixation
      // example — so the post's id differs from the one the safe request saw.
      expect(regeneratedId).not.toBe(loginId);

      // The session is LIVE: a follow-up read on the regenerated cookie sees
      // the user the mutation set. This is the "assert a live session" half of
      // §3.4 — without it a refusal on the POST could pass for the wrong
      // reason (the victim never logged in).
      const read = await app.inject({
        method: 'GET',
        url: 'http://localhost/read',
        headers: { cookie: cookieOf(post.headers) },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json<{ userId: string | null }>().userId).toBe('alice');
    } finally {
      await app.stop();
    }
  });

  it("carries the token in the README's PRIMARY carrier, the hidden form field", async () => {
    // The README's own `## Form CSRF` example renders
    // `<input type="hidden" name="_csrf" value="${token}">`, so the form field
    // — not the header — is the carrier a reader copies first. The sequence
    // test above drives `x-csrf-token`; this drives `_csrf`, so both documented
    // carriers are pinned rather than one standing in for the other.
    const app = buildApp();
    await app.start();
    try {
      const get = await app.inject({ method: 'GET', url: 'http://localhost/login' });
      const { token } = get.json<{ token: string }>();
      const cookie = cookieOf(get.headers);

      const post = await app.inject({
        method: 'POST',
        url: 'http://localhost/login',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: `_csrf=${encodeURIComponent(token)}&username=alice`,
      });

      expect(post.statusCode).toBe(200);
      expect(post.json<{ ok: boolean }>().ok).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('a bare POST /login with no prior safe request is refused 403', async () => {
    const app = buildApp();
    await app.start();
    try {
      // No GET first, no cookie, no token: the session does not exist yet, so
      // there is no token to present. This is the documented refusal, and it
      // is asserted AFTER the successful path above so it cannot pass by
      // virtue of the victim never having logged in.
      const post = await app.inject({ method: 'POST', url: 'http://localhost/login' });
      expect(post.statusCode).toBe(403);
      expect(post.json<{ detail: string }>().detail).toBe('CSRF token validation failed');
    } finally {
      await app.stop();
    }
  });
});
