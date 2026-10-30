# @setu-ts/session-plugin

Cookie-backed sessions and session-backed form CSRF for
[Setu-TS](https://github.com/setu-ts/setu-ts).

Registers an `ISessionService` under `CAPABILITIES.SESSION`. The default is a self-contained
encrypted cookie — AES-256-GCM under a key derived by HKDF-SHA256, entirely through `runtime.subtle`
— so there is **no npm dependency** and it runs on Node, Deno, Bun, and Cloudflare Workers alike.

## Installation

```bash
npm install @setu-ts/session-plugin
# Deno: deno add npm:@setu-ts/session-plugin
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

**Ending every session of one user** — after a password change, or from a "sign out everywhere"
button — needs neither strategy's revocation. `@setu-ts/auth-plugin`'s `signIn.sessionStamp` records
a digest of a stamp kept on your user record and compares it on every request, so bumping the stamp
ends all of that user's sessions on the cookie strategy too. See the auth plugin's
[Ending every session of a user](https://github.com/setu-ts/setu-ts/blob/main/packages/auth-plugin/README.md#ending-every-session-of-a-user).

Sessions also use whole-payload snapshot commits. Two overlapping requests that each change session
state can therefore lose one change on both the cookie and store strategies; a store improves
revocation, not concurrent-write merging. Keep writes to one session in one request, and keep state
that must be concurrently updated out of the session (for example, in a database with an explicit
concurrency strategy).

```typescript
SessionPlugin({ secret, store: 'memory' }); // single process, dev
SessionPlugin({ secret, store: 'cache' }); // over CAPABILITIES.CACHE
SessionPlugin({ secret, store: myOwnStore }); // any ISessionStore
```

**Anonymous sessions stay in the cookie** (M113e). On the store strategy, a session holding only the
reserved keys — the form-CSRF token and the tenant binding — is sealed into the cookie and writes no
store row, so a public page rendering a form does not add a row per visitor. The first write of any
other key (signing in) moves the session into the store, and clearing every other key (signing out)
deletes the row again, so a copy of the signed-in cookie restores nothing. Promotion to the store
rotates the session id, so a copied anonymous cookie can never read the signed-in row. The reserved
keys need no revocation, and the cookie is sealed under the same keys as every other one; under
`mode: 'sign'` the browser can read its own CSRF token, which the form already shows it. Pending
sign-in state from `auth-plugin` (state, nonce, PKCE verifier) is not a reserved key and still goes
to the store.

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

Cookie `secure` defaults to `true`. Set `cookie: { secure: 'auto' }` when the same deployment serves
local HTTP and proxied HTTPS: it emits `Secure` exactly when `requestOriginOf(ctx).protocol` is
`https`, including on cookie deletion. Register IP security with `trustProxy: true` and your
`trustedProxies` so TLS termination is reflected in that origin. Without IP security it follows
`ctx.request.url`. `false` remains available for local HTTP. `'auto'` with `sameSite: 'none'` throws
at construction because `SameSite=None` forces `Secure` regardless. See
[deployment behind a reverse proxy](https://github.com/setu-ts/setu-ts/blob/main/docs/deployment.md#behind-a-reverse-proxy).

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

When `csrf` is enabled, this `POST` is itself an unsafe method and needs the form token before it
can run — a bare `POST /login` is refused `403` before it can mint a session. See the sequence in
[Form CSRF](#form-csrf): a safe request first, then the mutation carrying the token.

## Tenant binding

When the application is multi-tenant, a session should stay bound to the tenant it was minted under.
`tenantBinding` (default `true`) does that:

- **Seal.** When a tenant is resolved for the request and the session carries no binding yet, the
  tenant id is written into the session on commit. A session is sealed exactly once — a session
  already bound to a tenant is never re-bound, even if a later request resolves a different one.
- **Compare.** On a later request, the session's tenant is compared with the tenant resolved for
  that request. A mismatch is refused with `403` (`Tenant Mismatch`) before the handler runs.

The compare runs on **whichever side sees the tenant second**, so the middleware priority the tenant
resolver runs at does not matter: when the tenant is resolved before the session loads (the shipped
resolvers, at the default priority 40) the session middleware compares; when the tenant is resolved
after the session loads (a custom resolver that needs the authenticated principal, at a priority
above 300) the tenant middleware compares the session it finds in `ctx.state`. Both call sites share
one implementation and answer the identical `403`.

One case stays at commit: a tenant written by application code **inside** a handler is seen by
neither middleware before the handler runs. On an unbound session the seal records it and the NEXT
request compares; on a bound session it is not re-sealed, so the next request under the handler's
tenant is refused. No middleware can precede the handler's own write, so this is documented rather
than fixed.

When either the session or the request carries no tenant, nothing is compared, so an application
without tenancy is inert. `false` restores the previous behaviour (no seal, no compare).

```typescript
SessionPlugin({ secret, tenantBinding: true }); // default: seal the tenant on commit
SessionPlugin({ secret, tenantBinding: false }); // opt out: no seal, no compare
```

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
arrangement** — the cheap stateless check at priority 270, the token check at 325, after
authentication (300).

```typescript
SessionPlugin({ secret, csrf: {} });
```

Render the token into a hidden field:

```typescript
import { csrfTokenField } from '@setu-ts/session-plugin';

app.router.get('/login', (ctx) => {
  return ctx.response.html(
    `<form method="post">${csrfTokenField(ctx)}<button>Sign in</button></form>`,
  );
});
```

`csrfTokenField` mints the session token on its first call and returns the complete trusted hidden
input. The field name follows your `SessionPlugin` configuration: the form-CSRF middleware publishes
its resolved config, and the helper reads it, so a form rendered by the helper names the field the
verifier checks — a customized `csrf.fieldName` needs NO extra step. An explicit
`csrfTokenField(ctx, { fieldName: 'authenticity_token' })` is an override, for a standalone
`csrfFormMiddleware` on a different name or a custom renderer; with no published config and no
argument (a request the middleware never saw, such as a React Router action), the shared `'_csrf'`
default applies.

Hono's `html` tag escapes interpolated strings. When using it or the view plugin's Hono-backed
engines, mark this helper's generated markup as raw at the application rendering boundary:

```typescript
import { html } from 'hono/html';
import type { IRequestContext } from '@setu-ts/common';
import { csrfTokenField } from '@setu-ts/session-plugin';
import { raw } from '@setu-ts/view-plugin';

// UNCHECKED-EXEMPT: LoginForm takes IRequestContext, so the gate never renders
// it, and raw() wraps csrfTokenField(ctx) — trusted markup that escapes the
// configured field name itself.
const LoginForm = (ctx: IRequestContext) =>
  html`
    <form method="post">${raw(csrfTokenField(ctx))}<button>Sign in</button></form>
  `;
```

The `raw()` call is appropriate only because `csrfTokenField` generates this fixed markup and
escapes the configured field name; do not use it for application-provided form content.

Options: `fieldName` (default `_csrf`), `headerName` (defaults to `x-csrf-token`, so a `fetch` post
can present the token in that header without further configuration; an explicit name still wins, and
the header is read FIRST, so a client that sends it triggers no body parse at all — including for
`multipart/form-data`, whose FIELD carries the token too since M94b, while a token arriving as a
multipart FILE part is refused (a client chooses freely whether a part carries a `filename`, so a
non-string value never reaches the comparison)), `ignoreMethods` (default `GET`/`HEAD`/`OPTIONS`),
`exclude` (exact paths or regular expressions that skip form CSRF), and `exemptBearer` (default
`true`). `exclude` is only for a separately-mounted non-browser protocol surface such as
Connect/gRPC — never use it for an application form route.

<!-- version:history -->

**A bearer API beside forms needs no exclusion** (M113e). A request carrying
`Authorization: Bearer <token>` skips form CSRF when a bearer (header-credential) strategy
authenticated it AND it restored no session — the session is new — so a JWT- or
API-token-authenticated JSON route in the same application reaches its guard rather than answering
`403`. That is safe because a browser never attaches a bearer token by itself, and a page on another
origin cannot add an `Authorization` header without a CORS preflight your server approves. The
exemption is decided by the credential that authenticated the request AND the session it restored,
not by the header's presence: the form check runs at 325, after authentication (300), and reads the
credential source recorded and the session `session-plugin` parks. A request carrying a valid
session cookie must present a CSRF token even with a valid bearer token, because the handler would
otherwise act on that browser's session — an origin CORS lets send credentials can send its own
valid bearer token beside the victim's cookie, authenticating as the attacker while the session
middleware restored the victim's session (M113e, L3). A non-browser API client sends no session
cookie, so its new session keeps the exemption; a junk bearer header beside a session cookie is
still verified, and an unauthenticated bearer header is verified too (it fails closed when the
session or the credential source is missing). `Basic` credentials are NOT exempt, because browsers
re-send cached Basic credentials automatically. `exemptBearer: false` verifies every unsafe request,
the behaviour before 0.10.0. A request the bearer rule exempts also gets no browser session:
whatever its handler writes to the session is not committed and no `Set-Cookie` is sent (M113e, L4),
so it cannot plant a session in a browser whose cookie no longer restores. **This holds even on a
path listed in `csrf.exclude`**: the bearer rule is checked first, so a bearer→cookie "exchange"
login route issues no cookie and logs nothing (V10-14). For such a route set `exemptBearer: false`,
which commits the session as releases before 0.10.0 did.

### What `SameSite` does not separate

`cookie.sameSite` defaults to `'lax'`, which is a real defence and a commonly misread one. It is
evaluated against the **site** — scheme plus registrable domain — and **a port is not part of a
site**. So `http://127.0.0.1:5300` and `http://127.0.0.1:5301` are same-site, and the session cookie
rides a subresource request between them exactly as it would within one application. `localhost` and
`127.0.0.1` ARE different sites; two ports on either are not.

That matters because `ignoreMethods` exempts `GET`/`HEAD`/`OPTIONS` from form CSRF, which is right:
the web's rule is that those methods are safe (RFC 9110), so a token on them is not standard
practice. The two rules are individually correct and meet at one assumption — **that your GET
handlers have no side effects.** A GET that mutates is reachable from any co-hosted application,
with the session cookie attached, through nothing more than an `<img>` tag; neither `SameSite=Lax`
nor form CSRF stands between them, and measured, such a request lands.

This is the ordinary shape of a development machine, of a shared corporate domain, and of any
deployment where a second service answers on another port of the same name. Two things follow:

- Keep every `GET` free of side effects. If one must mutate, make it a `POST` so form CSRF covers
  it, rather than adding it to a token check.
- Do not read "`SameSite=Lax` by default" as isolation from another port — and do not reach for a
  cookie prefix to get it. **Cookies are not scoped by port at all** (RFC 6265 §8.5), so a service
  on another port of the same host receives the cookie whatever attributes it carries. `__Host-` is
  still worth setting for what it DOES do — it requires `Secure`, forbids `Domain`, and pins
  `Path=/`, which stops a sibling SUBDOMAIN from setting or reading the cookie — but that is a
  subdomain boundary, not a port one, and `__Secure-` is weaker still. Real separation at the host
  level means a distinct hostname or registrable domain; short of that, only application-level
  authorization on each request, or running the two services where they cannot share a host name,
  keeps them apart.

### The sequence: safe request, then mutation

`csrfFormMiddleware` verifies every method outside `ignoreMethods` — including the endpoint that
establishes the session — and that is the right design: an exemption for `/login` would be a hole.
The consequence is that the token must be minted by a **safe** request before the mutation that
needs it:

1. A safe request (the `GET /login` above) creates the session and mints the token via
   `getCsrfToken(ctx)`; the token is committed with that response's cookie.
2. The mutation presents the cookie **and** the token — in the form field for a `<Form>` post, or in
   the `x-csrf-token` header for a `fetch` post.

A bare `POST /login` with no prior request is refused `403` by design: the token lives in the
session that does not exist yet. This is correct CSRF practice for a rendered form, and it is the
sequence an API client must follow when `csrf` is enabled.

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
  serverBuildPath: './build/server/index.js',
  populateLoadContext: (ctx, context) => {
    context.set(sessionContext, getSession(ctx));
  },
});
```

`getSession(ctx)` is the single accessor, so a loader and a handler see the identical session
object.

## Middleware priorities

| Priority | Middleware           | Why there                                                                                                                                                                    |
| -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 260      | `sessionMiddleware`  | After security headers (250), before auth (300)                                                                                                                              |
| 325      | `csrfFormMiddleware` | After the session loads (260) and after authentication (300), before authorization (350): the bearer exemption reads the credential source recorded and the session it parks |

Session sits below authentication so an auth strategy can read it. Anything that reads the session
must run at a priority **above** 260, or `getSession` throws `SessionMiddlewareMissingError`.

## Options

| Option              | Default          | Notes                                                                                                                                                                                                                        |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret`            | resolved         | `string` or rotation list; index 0 seals                                                                                                                                                                                     |
| `secretName`        | `SESSION_SECRET` | Looked up in the secrets manager and the environment                                                                                                                                                                         |
| `mode`              | `'encrypt'`      | `'sign'` exposes its payload                                                                                                                                                                                                 |
| `store`             | —                | `'memory'`, `'cache'`, or an `ISessionStore`                                                                                                                                                                                 |
| `maxAge`            | `7200`           | Seconds; also the cookie's `Max-Age`                                                                                                                                                                                         |
| `rolling`           | `false`          | Re-issue on every response                                                                                                                                                                                                   |
| `idleTimeoutMs`     | —                | No-request expiry; any request refreshes it, so it commits every response                                                                                                                                                    |
| `maxCookieBytes`    | `4096`           | Throws `SessionTooLargeError` rather than dropping silently                                                                                                                                                                  |
| `cookie.name`       | `setu_session`   | Renamed from `hono_session`; pin the old name to preserve in-flight sessions                                                                                                                                                 |
| `cookie.path`       | `/`              |                                                                                                                                                                                                                              |
| `cookie.domain`     | —                | Omitted means a host-only cookie                                                                                                                                                                                             |
| `cookie.sameSite`   | `'lax'`          | `'none'` forces `Secure`                                                                                                                                                                                                     |
| `cookie.secure`     | `true`           | `boolean \| 'auto'`; auto follows the trusted protocol and conflicts with `sameSite: 'none'`                                                                                                                                 |
| `cookie.httpOnly`   | `true`           |                                                                                                                                                                                                                              |
| `csrf`              | —                | Presence enables form CSRF                                                                                                                                                                                                   |
| `csrf.exemptBearer` | `true`           | Only a bearer request a header-credential strategy authenticated AND that restored no session (a new session) skips form CSRF; a valid session cookie still needs a token even with a valid bearer token; `Basic` never does |
| `tenantBinding`     | `true`           | Seal the tenant on commit and refuse a session presented under another                                                                                                                                                       |

## Health

The `session` indicator reports `{ strategy, mode, keys, store }` and goes `down` when a configured
store reports unhealthy — the one session failure that is invisible from outside, since cookies keep
arriving while every session reads as absent.

## Exports

| Export                          | Kind      |
| ------------------------------- | --------- |
| `csrfFormMiddleware`            | function  |
| `csrfTokenField`                | function  |
| `getCsrfToken`                  | function  |
| `getSession`                    | function  |
| `sessionMiddleware`             | function  |
| `SessionPlugin`                 | function  |
| `verifyCsrfToken`               | function  |
| `CacheSessionStore`             | class     |
| `CsrfTokenMismatchError`        | class     |
| `MemorySessionStore`            | class     |
| `SessionMiddlewareMissingError` | class     |
| `SessionSecretMissingError`     | class     |
| `SessionService`                | class     |
| `SessionTooLargeError`          | class     |
| `CSRF_CONFIG_STATE_KEY`         | const     |
| `CSRF_SESSION_KEY`              | const     |
| `CacheSessionStoreOptions`      | interface |
| `CsrfFormOptions`               | interface |
| `MemorySessionStoreDeps`        | interface |
| `PublishedCsrfConfig`           | interface |
| `SessionCookieOptions`          | interface |
| `SessionPluginOptions`          | interface |
| `SessionServiceDeps`            | interface |
| `SessionMode`                   | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Documentation

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#sessionplugin-setu-tssession-plugin)
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT

## Readiness and dependency outages (M113b)

A cache-backed session inherits `CacheStoreUnavailableError` from Redis cache operations. With
`errorHandler`, an outage answers 503 with value-free cache detail; the original driver failure
stays in `cause`. Cookie-only sessions are unchanged.
