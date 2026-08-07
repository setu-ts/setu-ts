# @setu-ts/session-plugin

Cookie-backed sessions and session-backed form CSRF for
[Setu-TS](https://github.com/setu-ts/setu-ts).

Registers an `ISessionService` under `CAPABILITIES.SESSION`. The default is a self-contained
encrypted cookie — AES-256-GCM under a key derived by HKDF-SHA256, entirely through `runtime.subtle`
— so there is **no npm dependency** and it runs on Node, Deno, Bun, and Cloudflare Workers alike.

## Installation

```bash
deno add jsr:@setu-ts/session-plugin
```

## Quick start

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SessionPlugin({ secret: mySecret, csrf: {} }),
  ],
});

app.router.get('/me', (ctx) => {
  const session = getSession(ctx);
  return ctx.response.json({ userId: session.get<string>('userId') ?? null });
});

await app.start({ port: 3000 });
```

You never write a `Set-Cookie` yourself. The middleware loads the session before your handler and
commits it afterwards — by default only when it actually changed, so a pure read does not rewrite
the cookie or defeat downstream caching. (`rolling` and `idleTimeoutMs` deliberately opt out of
that: both need every response to carry a refreshed cookie.)

## Choosing a strategy

|                      | Cookie (default)               | Store (`store: …`)                     |
| -------------------- | ------------------------------ | -------------------------------------- |
| Where the payload is | In the cookie                  | Server-side; cookie holds an opaque id |
| Infrastructure       | None                           | A cache, or your own `ISessionStore`   |
| Immediate revocation | **No** — valid until `Max-Age` | **Yes** — delete the entry             |
| Mass invalidation    | Rotate the secret              | Clear the store                        |
| Size limit           | ~4 KB (browser cookie limit)   | Effectively none                       |
| Cloudflare Workers   | Yes                            | Only with a Workers-compatible store   |

The cookie strategy's trade-off is real and worth stating plainly: a stolen cookie stays valid until
it expires, because nothing server-side is consulted. If you need to log a specific user out right
now, use a store.

```typescript
SessionPlugin({ secret, store: 'memory' }); // single process, dev
SessionPlugin({ secret, store: 'cache' }); // over CAPABILITIES.CACHE
SessionPlugin({ secret, store: myOwnStore }); // any ISessionStore
```

> **`store: 'cache'` shares a blast radius.** Sessions live in the same cache as your application
> data, so a `cache.clear()` from anywhere logs everybody out. Keys are namespaced (`session:` by
> default) so they are identifiable, but a dedicated cache instance is the production
> recommendation.

## Protection modes

```typescript
SessionPlugin({ secret, mode: 'encrypt' }); // default
SessionPlugin({ secret, mode: 'sign', store: 'cache' });
```

- **`'encrypt'`** (default) — AES-256-GCM. The payload is unreadable by the client, and the
  authentication tag means a tampered cookie yields an _empty_ session rather than
  attacker-controlled data.
- **`'sign'`** — HMAC-SHA256 over a readable base64url payload. Integrity only: **anyone holding the
  cookie can read its contents.** Use it with a store, where the cookie carries nothing but an
  opaque id. Do not use it with the cookie strategy for anything you would not put in a URL.

## Secret rotation

`secret` takes a list. Index 0 seals new cookies; every entry can still open existing ones, so
rotating does not log everybody out.

```typescript
SessionPlugin({ secret: [newSecret, oldSecret] });
```

Deploy with both, wait longer than `maxAge`, then drop the old one. Each key is addressed by a short
non-secret `kid` carried in the cookie, so opening is a direct lookup rather than a trial over every
key. A comma-separated `SESSION_SECRET` environment variable works the same way.

## Where the secret comes from

Resolved once at startup, in this order:

1. the `secret` option, when given;
2. `CAPABILITIES.SECRETS` (the secrets plugin), under `secretName` — default `SESSION_SECRET`;
3. the same name in the environment.

A missing or under-32-character secret throws `SessionSecretMissingError` during `register()`. That
is deliberate: without the right secret every session is unreadable, and finding out at boot beats
finding out from production traffic.

## Expiry

`maxAge` (default `7200` seconds) is enforced from a stamp **inside** the payload, not from the
cookie's `Max-Age` — that attribute is client-controlled, so a server that trusts it has no expiry
at all.

```typescript
SessionPlugin({ secret, maxAge: 3600, rolling: true, idleTimeoutMs: 900_000 });
```

- `rolling: false` (default) — absolute expiry from creation.
- `rolling: true` — every response extends the expiry, so an active user is not logged out
  mid-session.
- `idleTimeoutMs` — expire after this long with no requests, independently of `maxAge`. Any request
  refreshes it, a read-only one included, so setting it re-issues the cookie on every response (and
  rewrites the stored entry on the store strategy) to advance the activity stamp. It does not extend
  absolute expiry — that is `rolling`'s job, and the two compose.

## Session fixation

Call `regenerate()` immediately after any privilege change, above all after login:

```typescript
app.router.post('/login', async (ctx) => {
  const session = getSession(ctx);
  session.set('userId', user.id);
  session.regenerate(); // new id, same data
  return ctx.response.json({ ok: true });
});
```

Otherwise a session id an attacker planted before authentication carries into the authenticated
session. On the store strategy the superseded entry is deleted, so this is a real revocation rather
than a rename.

## Form CSRF

This is the **synchronizer-token** strategy, and it is a _different mechanism_ from
`http-security-plugin`'s `csrfMiddleware`, not the same feature configured differently:

|                                        | `http-security-plugin`             | this package                 |
| -------------------------------------- | ---------------------------------- | ---------------------------- |
| Mechanism                              | Stateless `Origin`/`Referer` check | Signed token in session data |
| Needs a session                        | No                                 | Yes                          |
| Works for a plain `<Form>` post        | Yes                                | Yes                          |
| Works when `Origin` is absent/stripped | No                                 | Yes                          |
| Per-session token to embed             | No                                 | Yes                          |

A progressive-enhancement `<Form>` post cannot set a custom header, which is why the stateless
middleware's `customHeader` option cannot be driven by one. **Running both together is the intended
arrangement** — the cheap stateless check at priority 270, the token check at 275.

```typescript
SessionPlugin({ secret, csrf: {} });
```

Render the token into a hidden field:

```typescript
app.router.get('/login', (ctx) => {
  const token = getCsrfToken(ctx); // minted on first call, then stable
  return ctx.response.text(
    `<form method="post">
       <input type="hidden" name="_csrf" value="${token}">
       <button>Sign in</button>
     </form>`,
  );
});
```

Options: `fieldName` (default `_csrf`), `headerName` (for `fetch` posts, and **required for
`multipart/form-data`**, which this package does not parse), and `ignoreMethods` (default
`GET`/`HEAD`/`OPTIONS`).

To validate inside a handler or a React Router action instead of via middleware, call the same
function the middleware uses:

```typescript
import { verifyCsrfToken } from '@setu-ts/session-plugin';

await verifyCsrfToken(ctx); // throws CsrfTokenMismatchError
```

## React Router (Milestone 44)

The session reaches loaders and actions through the SSR plugin's existing `populateLoadContext` hook
— no plugin imports another:

```typescript
ReactRouterPlugin({
  build,
  populateLoadContext: (ctx, context) => {
    context.set(sessionContext, getSession(ctx));
  },
});
```

`getSession(ctx)` is the single accessor, so a loader and a handler see the identical session
object.

## Middleware priorities

| Priority | Middleware           | Why there                                              |
| -------- | -------------------- | ------------------------------------------------------ |
| 260      | `sessionMiddleware`  | After security headers (250), before auth (300)        |
| 275      | `csrfFormMiddleware` | After the session loads and after stateless CSRF (270) |

Session sits below authentication so an auth strategy can read it. Anything that reads the session
must run at a priority **above** 260, or `getSession` throws `SessionMiddlewareMissingError`.

## Options

| Option            | Default          | Notes                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------- |
| `secret`          | resolved         | `string` or rotation list; index 0 seals                                  |
| `secretName`      | `SESSION_SECRET` | Looked up in the secrets manager and the environment                      |
| `mode`            | `'encrypt'`      | `'sign'` exposes its payload                                              |
| `store`           | —                | `'memory'`, `'cache'`, or an `ISessionStore`                              |
| `maxAge`          | `7200`           | Seconds; also the cookie's `Max-Age`                                      |
| `rolling`         | `false`          | Re-issue on every response                                                |
| `idleTimeoutMs`   | —                | No-request expiry; any request refreshes it, so it commits every response |
| `maxCookieBytes`  | `4096`           | Throws `SessionTooLargeError` rather than dropping silently               |
| `cookie.name`     | `hono_session`   |                                                                           |
| `cookie.path`     | `/`              |                                                                           |
| `cookie.domain`   | —                | Omitted means a host-only cookie                                          |
| `cookie.sameSite` | `'lax'`          | `'none'` forces `Secure`                                                  |
| `cookie.secure`   | `true`           | Set `false` only for plain-HTTP local development                         |
| `cookie.httpOnly` | `true`           |                                                                           |
| `csrf`            | —                | Presence enables form CSRF                                                |

## Health

The `session` indicator reports `{ strategy, mode, keys, store }` and goes `down` when a configured
store reports unhealthy — the one session failure that is invisible from outside, since cookies keep
arriving while every session reads as absent.

## Exports

`SessionPlugin`, `SessionService`, `getSession`, `sessionMiddleware`, `csrfFormMiddleware`,
`getCsrfToken`, `verifyCsrfToken`, `CSRF_SESSION_KEY`, `MemorySessionStore`, `CacheSessionStore`,
`SessionSecretMissingError`, `SessionMiddlewareMissingError`, `CsrfTokenMismatchError`,
`SessionTooLargeError`, and the option types.

The `ISession` / `ISessionService` / `ISessionStore` contracts and the `parseCookie` /
`serializeCookie` codec live in
[`@setu-ts/common`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).

## Documentation

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md)
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT
