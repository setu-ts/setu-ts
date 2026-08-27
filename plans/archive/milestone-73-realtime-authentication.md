# Milestone 73 — Realtime Authentication (`@setu-ts/auth-plugin`, `@setu-ts/session-plugin`, `@setu-ts/websocket-plugin`, `@setu-ts/sse-plugin`, `@setu-ts/common`, `@setu-ts/kernel`)

> **Status:** Planning. Branch: `feat/m73-realtime-authentication`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A browser can send exactly **one** credential over an `EventSource` request or a `WebSocket`
constructor: a cookie. No shipped `IAuthStrategy` reads one — `JwtStrategy` and `ApiKeyStrategy`
both read a header — and `AuthPluginOptions` has no hatch through which an application could supply
its own. So the two transports a browser can actually use for realtime work cannot authenticate a
browser at all: an `EventSource` behind `requireAuth()` is `401`ed, and a socket connects as
anonymous with its cookie session unreadable in the very callback the websocket README nominates for
the job. This milestone closes X3-5, whose documentation half M70n closed. It ships a session-backed
passive strategy, a caller-supplied strategy hatch, a headers-only session read so a non-HTTP entry
point can open a cookie, and the bridge that carries the authenticated principal into a WebSocket's
`onOpen`.

- **In scope:** `SessionStrategy` in `auth-plugin`, configured by a new `AuthPluginOptions.session`
  arm; `AuthPluginOptions.strategies` as the caller-supplied hatch; a new
  `ISessionService.fromHeaders(headers)` returning a read-only `SessionView`, implemented by
  `SessionService`; `WebSocketConnectionContext.user` populated by threading `ctx.request.user`
  through `IWebSocketService.routeUpgrade`; the `sse-plugin` authentication documentation the
  package has none of; and the doc corrections §2 names. Public API additions, so §10.2 approval is
  recorded in the PR description and `PUBLIC_API.md` ships in the same PR.
- **NOT this milestone:**
  - A per-WebSocket-route authorization option. WebSocket routes are registered on
    `IWebSocketService.route`, not on the kernel router, so they carry no route middleware. The
    documented answers are a global guard registered in the authentication band and a `1008` close
    from `onOpen`; a route-level `guard` option belongs to a websocket milestone of its own.
  - The pipeline-bypass question. M70a already routes every upgrade through the kernel pipeline
    (`packages/kernel/src/application/application.ts:643-660`), so a guard can refuse an upgrade
    today; what is missing is a strategy that can read the credential.
  - A read-only `room()`/`channel()` lookup and the `SseMessage.data` narrowing — **M74**.
  - Broker trace propagation — **M75**.
  - Per-subscriber authorization filtering on `SseChannel.publish` and `WebSocketRoom.broadcast`.
    Neither registry attaches an identity to a member, and adding one is a fan-out redesign rather
    than an authentication gap; recorded in §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                    | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAuthStrategy`                     | `packages/common/src/services/auth.ts:110`                            | Exactly `readonly name: string` and `authenticate(request: IRequest): Promise<IPrincipal \| null>`. It receives an `IRequest`, never an `IRequestContext` — so it can read headers but cannot reach `ctx.state`, which is where the session middleware puts the loaded session.                                                                                           |
| `IAuthService`                      | `packages/common/src/services/auth.ts:128`                            | `authenticate(request)` and `verifyCredentials({ identifier, secret })`. No strategy registration surface.                                                                                                                                                                                                                                                                |
| `IPrincipal`                        | `packages/common/src/services/auth.ts:16`                             | `{ id, roles?, permissions?, claims? }`, every member `readonly`. Immutable, so it is safe to hand to a long-lived socket.                                                                                                                                                                                                                                                |
| `AuthPluginOptions`                 | `packages/auth-plugin/src/interfaces/index.ts:66`                     | Exactly `jwt`, `apiKey?`, `local?`, `rbac?`. **No `strategies`, no `session`.**                                                                                                                                                                                                                                                                                           |
| Strategy assembly                   | `packages/auth-plugin/src/plugin/auth-plugin.ts:101,115,126,136`      | `const strategies: IAuthStrategy[] = []` at `:101`, JWT pushed at `:115`, API key at `:126`, handed to `new AuthService(strategies, localStrategy)` at `:136`. The array is internal and built from those options alone.                                                                                                                                                  |
| `AuthService.authenticate`          | `packages/auth-plugin/src/services/auth-service.ts:30-38`             | Iterates `this.strategies` in array order; **first non-null principal wins**; returns `null` when none match. So strategy order is the whole precedence rule.                                                                                                                                                                                                             |
| `AuthPlugin` metadata               | `packages/auth-plugin/src/plugin/auth-plugin.ts:58-63`                | `provides` is `[JWT, AUTH, …AUTHORIZATION]`, `priority: PLUGIN_PRIORITY.NORMAL`, and there is **no `optionalDependencies` key at all** (`grep` returns nothing).                                                                                                                                                                                                          |
| `SessionPlugin` metadata            | `packages/session-plugin/src/plugin/session-plugin.ts:84-87`          | `optionalDependencies: [SECRETS, CACHE]`, `provides: [SESSION]`, `priority: PLUGIN_PRIORITY.NORMAL`. **Same priority band as `AuthPlugin`**, so nothing currently orders the two.                                                                                                                                                                                         |
| Session middleware priority         | `packages/session-plugin/src/plugin/session-plugin.ts:29-33`          | `SESSION: 260`, with the comment "After security headers (250), before authentication (300)".                                                                                                                                                                                                                                                                             |
| `ISessionService`                   | `packages/common/src/services/session.ts:126,138`                     | Declares exactly one method, `from(ctx: IRequestContext): ISession`, documented to throw when the middleware did not run. **No headers-only seam.**                                                                                                                                                                                                                       |
| `SessionData`                       | `packages/common/src/services/session.ts:23`                          | `Record<string, unknown>`.                                                                                                                                                                                                                                                                                                                                                |
| `ISession`                          | `packages/common/src/services/session.ts:40-114`                      | Carries `set`/`destroy`/`regenerate` and `toJSON(): SessionData`. Mutations are buffered and written back by the middleware after the handler returns.                                                                                                                                                                                                                    |
| `SessionService.load`               | `packages/session-plugin/src/services/session-service.ts:106-118`     | Reads **only** `parseCookie(ctx.request.headers.get('cookie'))[cookieName]` from the context, then delegates to `#restore(raw, now)`. Nothing else on `ctx` is consulted on the read path.                                                                                                                                                                                |
| `SessionService.#restore`           | `packages/session-plugin/src/services/session-service.ts:225-253`     | `open()` the envelope → `parseSnapshot()` → on the store strategy `store.read(id)`, returning `null` when the entry is gone. So a headers-only read inherits real revocation on the store strategy.                                                                                                                                                                       |
| `SessionSnapshot` (internal)        | `packages/session-plugin/src/services/session.ts:18-28`               | `{ id, data, exp, seen }`. Not barrel-exported.                                                                                                                                                                                                                                                                                                                           |
| `TENANT_BINDING_KEY`                | `packages/session-plugin/src/services/session-tenant-binding.ts:23`   | `'__setu_tenant'` — a reserved key inside `SessionData`, visible to any reader of the payload.                                                                                                                                                                                                                                                                            |
| `parseCookie`                       | `packages/common/src/cookie.ts:63`                                    | `(header: string \| null \| undefined) => Record<string, string>`; percent-decodes, skips pairs without `=`, first occurrence wins. Barrel-exported at `packages/common/src/index.ts:343`.                                                                                                                                                                                |
| `IRequest.user`                     | `packages/common/src/http.ts:55`                                      | `user?: IPrincipal`, guarded by the M71 single-write mechanism.                                                                                                                                                                                                                                                                                                           |
| `replacePrincipal`                  | `packages/common/src/request-identity.ts:161`                         | The deliberate-replacement escape `authMiddleware` already uses.                                                                                                                                                                                                                                                                                                          |
| `authMiddleware`                    | `packages/auth-plugin/src/middleware/auth-middleware.ts:29-52`        | Resolves `CAPABILITIES.AUTH`, calls `authService.authenticate(ctx.request)`, and on a non-null principal calls `replacePrincipal`. **Always calls `next()`** — it authenticates, never authorizes.                                                                                                                                                                        |
| `requireAuth`                       | `packages/auth-plugin/src/guards/index.ts:32-46`                      | Reads `ctx.request.user`; answers `401` through `respondWithError` when absent, without calling `next()`.                                                                                                                                                                                                                                                                 |
| Pipeline-then-protocol order        | `packages/kernel/src/application/application.ts:643-660`              | `await this.#pipeline.execute(ctx, …)` and, inside the terminal callback, `if (await this.#tryUpgrade(ctx)) return;` **before** route matching. So `ctx.request.user` is already populated when the upgrade is decided.                                                                                                                                                   |
| `Application.#tryUpgrade`           | `packages/kernel/src/application/application.ts:738-782`              | Reads `ctx.raw`, probes `CAPABILITIES.WEBSOCKET` with `has`, then calls `await wsService.routeUpgrade(raw)` at `:771`. The live `ctx` is in hand at that call site.                                                                                                                                                                                                       |
| `IWebSocketService.routeUpgrade`    | `packages/common/src/services/websocket.ts:393`                       | `routeUpgrade?(request: Request): Promise<WebSocketUpgradeDecision \| null>` — optional member, single parameter.                                                                                                                                                                                                                                                         |
| `WebSocketConnectionContext`        | `packages/common/src/services/websocket.ts:260-271`                   | Exactly `url`, `path`, `query`, `headers`, `protocol?`. **No identity member of any kind.** Its JSDoc says "read these to authenticate the peer".                                                                                                                                                                                                                         |
| `buildContext`                      | `packages/websocket-plugin/src/services/websocket-service.ts:546-563` | `(request, protocol) => WebSocketConnectionContext`; called at `:356` inside `#route`, deliberately while the native request is still live (the M46 use-after-free fix).                                                                                                                                                                                                  |
| `WebSocketService.routeUpgrade`     | `packages/websocket-plugin/src/services/websocket-service.ts:240-242` | Delegates to `this.createUpgradeRouter()(request)` purely to reuse the logging wrapper.                                                                                                                                                                                                                                                                                   |
| `UpgradeRouterStore`                | `packages/runtime/src/adapters/shared/upgrade-router-store.ts:23-37`  | Post-M70a it holds `set`/`hasRouter` and **no `consult`** — its own module doc states "the router is no longer consulted here". Verified: the Deno adapter touches `#upgrades` only at `:115` and `:133`. **`routeUpgrade` is therefore the only live routing path on all four runtimes**, so threading the principal there reaches every runtime with no adapter change. |
| `WsRouteTable.add` / `match`        | `packages/websocket-plugin/src/routing/ws-route-table.ts:109,128`     | `add(path, handlers, options?)` keyed on exact path; `WebSocketRouteOptions` carries `protocols` and `heartbeat` only — **no guard/auth member**, and WS routes are not kernel routes, so they have no route middleware.                                                                                                                                                  |
| `SseService.open`                   | `packages/sse-plugin/src/services/sse-service.ts:125`                 | `open(ctx: IRequestContext): ISseConnection`. **The application owns the route** — `SsePlugin.register` registers no kernel route — so `ctx.request.user` and `getSession(ctx)` are already readable on the SSE path. No `src` change is needed there.                                                                                                                    |
| `SsePluginOptions`                  | `packages/sse-plugin/src/interfaces/index.ts:13-42`                   | `heartbeatMs?`, `retryMs?`, `scalingNotice?`. No auth seam, and none is added.                                                                                                                                                                                                                                                                                            |
| sse-plugin auth reads               | `packages/sse-plugin/src/`                                            | `grep -niE "user\|principal\|auth\|session\|cookie"` over `src/` returns only `last-event-id` and response-header lines. The package reads no identity at all — confirming this is a docs-only package here.                                                                                                                                                              |
| AI_GUIDELINES §10.2                 | `AI_GUIDELINES.md:596-600`                                            | "No public API may be added, modified, or removed without explicit approval. Approval is documented in the PR description. The `PUBLIC_API.md` document must be updated in the same PR."                                                                                                                                                                                  |
| AI_GUIDELINES §9.4                  | `AI_GUIDELINES.md:577-586`                                            | In prerelease a breaking change needs a `CHANGELOG.md` entry with migration text; "silent" is the defect being named.                                                                                                                                                                                                                                                     |
| ARCHITECTURE §10 ordering rationale | `ARCHITECTURE.md:1860-1864`                                           | "The session sits below authentication **so an auth strategy can read it**." The ordering exists for this milestone's strategy; today no strategy reads it (see C3).                                                                                                                                                                                                      |
| ARCHITECTURE §10 realtime prose     | `ARCHITECTURE.md:1804-1826`                                           | Already correct post-M70a: the pipeline runs for all inbound traffic, and "a guard that answers `401` therefore refuses the upgrade".                                                                                                                                                                                                                                     |
| `PUBLIC_API.md` WebSocket note      | `PUBLIC_API.md:2058-2070`                                             | Already correct post-M70a, including the caveat that an accepted upgrade answers with the runtime's own `101` and carries no middleware-set response headers.                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                                                                                                                                                           | Doc deliverable (same PR)                                                                                                                                                                                                     |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `packages/websocket-plugin/README.md:193` states "**Upgrades bypass the middleware pipeline, by design.** … The adapter therefore consults the plugin's upgrade router first". `ARCHITECTURE.md:1804-1826` and `PUBLIC_API.md:2058` state the opposite, and the source agrees with them. | The source side. M70a moved dispatch into the kernel terminal handler; `UpgradeRouterStore` has no `consult` and the Deno adapter never calls the stored router. The README bullet is pre-M70a text that survived. **This is load-bearing for M73**: the whole strategy design depends on the pipeline having run before the handshake is decided. | Rewrite that bullet to state that the pipeline runs first, that a guard in the authentication band refuses an upgrade, and that `setUpgradeRouter` now only signals to Node that a router exists.                             |
| C2 | `packages/websocket-plugin/README.md:198-206` tells the reader a cookie session "is not yet verifiable" in `onOpen` and points at `smoke/DEFECTS.md` (X3-5). This milestone makes it verifiable.                                                                                         | Replace the bullet. A cookie is now the recommended credential; `context.user` carries the authenticated principal and `ISessionService.fromHeaders(context.headers)` opens the payload. The query-string-token advice is kept as the fallback for applications not running `SessionPlugin`.                                                       | Rewritten bullet, plus a worked `onOpen` example; `smoke/DEFECTS.md` X3-5 row moved from "Deferred follow-ons" to closed with this milestone's PR number.                                                                     |
| C3 | `ARCHITECTURE.md:1860` justifies the 260/300 ordering as existing "so an auth strategy can read it", but no shipped strategy reads the session — the rationale describes a capability the framework did not have.                                                                        | Keep the ordering and make the claim true. `SessionStrategy` is exactly the reader the sentence presupposes.                                                                                                                                                                                                                                       | Amend the paragraph to name `SessionStrategy` as the reader, and state the consequence: with the `session` arm configured, `sessionMiddleware` must be registered above 300 or the strategy sees no cookie-derived principal. |
| C4 | `ARCHITECTURE.md:2761` — the package-diagram note says the §10 pipeline "is likewise bypassed for upgrade requests, by design", contradicting §10's own prose in the same document.                                                                                                      | The §10 prose side. Same stale mechanism as C1, in a second location; leaving a known-false neighbour while fixing C1 is the doc-drift this repo keeps paying for.                                                                                                                                                                                 | Correct the parenthetical to describe the M70a mechanism, and correct the adjacent gRPC paragraph's identical "intercepted inside the HTTP adapter's `fetch` path … before body mapping" sentence.                            |
| C5 | `packages/sse-plugin/README.md` has **no authentication section at all** (135 lines; `grep -niE "auth\|credential\|cookie\|EventSource"` returns zero matches), while `EventSource` being `401`ed is the most visible half of X3-5.                                                      | Add one. The plugin needs no `src` change, so the deliverable here is entirely documentation — and its absence is why the failure looked like a framework limitation rather than a missing strategy.                                                                                                                                               | New `## Authentication` section: `EventSource` sends only cookies, configure `AuthPluginOptions.session`, guard the route with `requireAuth()`, and the cross-origin `withCredentials` + CORS note.                           |
| C6 | `PUBLIC_API.md:1312` describes `AuthPluginOptions` as "(`jwt` / `apiKey` / `local` / `rbac`)", and `packages/auth-plugin/README.md:182-195` has an options table with the same four families. Both become incomplete with this milestone.                                                | Update both, and add a `strategies`/`session` narrative to the auth README's `## Strategies` section (`:98-108`), which today lists three strategies and states the first-non-null rule without saying the set is closed.                                                                                                                          | `PUBLIC_API.md` Auth section: option rows for `session.toPrincipal` and `strategies`, the strategy-order rule, and the `SessionAuthOptions` export row. Auth README: matching table rows and a `SessionStrategy` bullet.      |
| C7 | `PUBLIC_API.md:2032-2033` — the SSE "Channels are in-process" bullet ends mid-sentence, its final words being `SseChannel.size keeps reporting local membership either`, with no closing word.                                                                                           | Complete the sentence. A truncated committed doc in a section this PR is already editing is fixed here rather than left for a reader to trip over.                                                                                                                                                                                                 | One-line correction in the SSE Notes block.                                                                                                                                                                                   |

## 3. Design decisions

### 3.1 Where the cookie is read — `ISessionService.fromHeaders`

- **Decision:** Add `fromHeaders(headers: Headers): Promise<SessionView | null>` to
  `ISessionService` as a **required** member, with
  `SessionView = { readonly id: string; readonly data: Readonly<SessionData> }` exported from
  `common`. `SessionService.fromHeaders` reads the cookie by name from the supplied `Headers`, then
  delegates to the existing `#restore(raw, now)` — the same envelope-open, snapshot-parse and
  store-read path `load()` already uses — and projects the result to `{ id, data }`.
- **Why:** `load(ctx)` consults nothing on the context except `ctx.request.headers.get('cookie')`
  (`session-service.ts:106-118`), so a headers-only read is the existing path with its one context
  touch lifted out; there is no second implementation and therefore nothing that can drift. Required
  rather than optional because a strategy in another package must call it without a
  capability-shaped guard, and the framework's own `SessionService` is the only in-repo implementor
  — the M51b `IGraphqlService.subscribe` precedent, which was likewise required and likewise
  breaking for implementors only.
- **Why a view and not `ISession`:** an `ISession` handed to a caller with no response to commit
  onto would expose `set`, `destroy` and `regenerate` whose writes can never persist. That is the
  silent-no-op class this repo has shipped before (the M6 `sanitize` option). `SessionView` has no
  mutation surface, so nothing can fail silently.
- **Test home:** `packages/session-plugin/test/unit/session-from-headers.test.ts`, and the
  shared-path assertion in `packages/session-plugin/test/unit/session-service.test.ts`.

### 3.2 Revocation, expiry and the reserved tenant key on the headers path

- **Decision:** `fromHeaders` returns `null` for every condition `load()` treats as "no usable
  session" — absent cookie, unopenable envelope, unparseable snapshot, absolute expiry passed, idle
  timeout passed, and (on the store strategy) a store entry that is gone. It does **not** advance
  the `seen` stamp and never writes. `data` is returned verbatim, including the reserved
  `__setu_tenant` key.
- **Why:** routing through `#restore` inherits all six conditions for free, which is the point of
  §3.1. Not advancing `seen` is correct because there is no commit phase on this path; a caller who
  wants rolling behaviour is on the HTTP path and already gets it. The reserved key is returned
  rather than stripped because stripping it would make `fromHeaders(headers).data` and
  `getSession(ctx).toJSON()` disagree about the same session, and a caller reading a documented
  reserved key is better served than one silently handed a different payload.
- **Test home:** `packages/session-plugin/test/unit/session-from-headers.test.ts` — one case per
  condition, plus a store-strategy revocation case driving `MemorySessionStore`.

### 3.3 How a session becomes a principal

- **Decision:** `AuthPluginOptions.session` is `SessionAuthOptions`, whose single **required**
  member is `toPrincipal(view: SessionView): IPrincipal | null`. Returning `null` means "this
  session carries no identity", and the strategy chain continues.
- **Why:** the session payload is application data. Any conventional key the framework picked
  (`user`, `principal`, `sub`) would be a convention nothing enforces, so an application storing its
  identity under a different key would get `undefined` and an anonymous request with nothing failing
  loudly. A required callback names its own contract at the one place that knows it. There is
  deliberately no default.
- **Test home:** `packages/auth-plugin/test/unit/session-strategy.test.ts` (`null` return continues
  the chain) and the integration suite in §6.

### 3.4 Where the strategy lives, and how it reaches the session service

- **Decision:** `SessionStrategy` ships in `auth-plugin` as an internal class
  (`src/strategies/session-strategy.ts`), **not** barrel-exported, matching `JwtStrategy` and
  `ApiKeyStrategy`. It is constructed in `AuthPlugin.register()` only when `options.session` is
  present, and is given the `ISessionService` resolved from `ctx.services` at that moment.
  `auth-plugin` imports `ISessionService` and `SessionView` from **`common`** and never from
  `session-plugin`, so AI_GUIDELINES §2.2 holds.
- **Why not export it:** the `session` arm is the whole configuration surface, so an exported class
  would have no consumer beyond its own test — the dead-surface rule. The two existing strategies
  set the precedent and the auth README already documents them as unexported.
- **Test home:** `packages/auth-plugin/test/unit/session-strategy.test.ts` and
  `packages/auth-plugin/test/unit/barrel-exports.test.ts` (pinning that the class is absent from the
  barrel).

### 3.5 Plugin ordering, and failing at `register()` rather than per request

- **Decision:** `AuthPlugin` gains `optionalDependencies: [CAPABILITIES.SESSION]`. When
  `options.session` is configured and `ctx.services.has(CAPABILITIES.SESSION)` is `false`,
  `register()` throws a plain `Error` naming both plugins and the option
  (`"AuthPlugin: options.session requires SessionPlugin — register SessionPlugin, or drop options.session."`).
- **Why the edge is load-bearing here:** `AuthPlugin` and `SessionPlugin` are **both**
  `PLUGIN_PRIORITY.NORMAL` (`auth-plugin.ts:63`, `session-plugin.ts:87`), so nothing else orders
  them — unlike M45b, where a priority gap already did the ordering and the declared edge turned out
  not to be what guaranteed it. Without the edge, resolution order decides whether the capability is
  present, which is the intermittent failure this repo punishes.
- **Why a plain `Error` and not a new error class:** `AuthPlugin.register` already throws a plain
  `Error` with a named message for its existing misconfiguration (`auth-plugin.ts:46-50`). A new
  exported error class would add two public symbols whose only reader is their own test.
- **Test home:** `packages/auth-plugin/test/unit/auth-plugin.test.ts` (the refusal, and the
  `optionalDependencies` membership assertion).

### 3.6 The caller-supplied hatch and strategy precedence

- **Decision:** `AuthPluginOptions.strategies?: readonly IAuthStrategy[]`. The assembled order is
  fixed: **JWT → API key → session → caller-supplied, in declaration order**. Two strategies sharing
  a `name` — among the built-ins and the supplied set together — makes `register()` throw, naming
  the duplicate.
- **Why this order:** `AuthService.authenticate` takes the first non-null principal
  (`auth-service.ts:30-38`), so order is precedence. A request carrying both a bearer header and a
  cookie is an API client acting for a specific token, and the explicit credential should win;
  putting the built-ins first also means no existing application's behaviour moves when it adopts
  the hatch. Caller strategies run last for the same reason.
- **Why the duplicate-name refusal:** `IAuthStrategy.name` is the strategy's only identity, and a
  second strategy under an existing name is unreachable for anything that reasons about the chain by
  name — the dead-surface class, arriving silently.
- **Test home:** `packages/auth-plugin/test/unit/auth-plugin.test.ts` — an order assertion driving a
  request that satisfies two strategies at once, and the duplicate-name refusal.

### 3.7 The WebSocket bridge — a principal, not a context

- **Decision:** `IWebSocketService.routeUpgrade` gains an **optional second parameter**,
  `routeUpgrade?(request: Request, principal?: IPrincipal)`. The kernel passes `ctx.request.user` at
  `application.ts:771`. `WebSocketConnectionContext` gains an **optional** `user?: IPrincipal`,
  populated by `buildContext(request, protocol, principal)` and omitted when no principal
  authenticated the upgrade.
- **Why a principal and not the request context:** M46 already found that the runtime closes the
  native request once the handshake response is returned, which is why `buildContext` snapshots at
  `websocket-service.ts:356`. An `IRequestContext` handed to `onOpen` would be dead by the time the
  callback fires — the same use-after-free, re-introduced. `IPrincipal` is fully `readonly`
  (`auth.ts:16-25`), so snapshotting it is sound.
- **Why both members are optional:** neither addition breaks an implementor of `IWebSocketService`
  or a consumer of `WebSocketConnectionContext`. A function of lower arity remains assignable to the
  widened method type.
- **Why this reaches all four runtimes with no adapter change:** post-M70a `UpgradeRouterStore` has
  no `consult` and no adapter calls the stored router, so `routeUpgrade` is the only live routing
  path. `WebSocketService.createUpgradeRouter()` keeps its exact public signature; the reporting
  wrapper is extracted into a private `#routeReported(request, principal?)` that both entry points
  call, so the logging behaviour has one implementation and the adapter-facing marker is unchanged.
- **Test home:** `packages/websocket-plugin/test/unit/websocket-service-upgrade-user.test.ts` and
  `packages/kernel/test/integration/upgrade-principal.test.ts`.

### 3.8 Refusing an unauthenticated upgrade

- **Decision:** two documented mechanisms, both tested, and no new option. (a) A guard registered
  globally in the authentication band refuses the upgrade before the handshake, because the pipeline
  runs first. (b) `onOpen` reads `context.user` and calls `conn.close(1008)` when it is absent.
- **Why not a route-level option:** WebSocket routes live in `WsRouteTable`, keyed on exact path
  with options carrying only `protocols` and `heartbeat` (`ws-route-table.ts:109`); they are not
  kernel routes and have no middleware chain. Adding one is a websocket-plugin design of its own,
  and the ROADMAP places the pipeline question outside this milestone.
- **Test home:** `packages/websocket-plugin/test/e2e/cookie-auth-socket.test.ts` covers both — a
  guarded path refused before the socket opens, and a `1008` close from `onOpen`.

### 3.9 The cross-site exposure a cookie-authenticated socket creates

- **Decision:** document, do not default-change. The session cookie defaults to `sameSite: 'lax'`
  (`PUBLIC_API.md:2374`), and a WebSocket handshake is not a top-level navigation, so a `Lax` cookie
  is **not** sent on a cross-site upgrade — cookie-authenticated sockets are same-site by default.
  Setting `cookie.sameSite: 'none'` removes that protection and exposes the application to
  cross-site WebSocket hijacking, which the same-origin policy does not cover for `WebSocket`. The
  new documentation states this and directs such applications to check the `Origin` header in the
  authentication band.
- **Why not enforce an `Origin` check here:** `http-security-plugin` owns origin policy, and
  duplicating it in `auth-plugin` would put the rule in two places (§11.1). No default moves, so no
  existing application's behaviour changes.
- **Test home:** documentation deliverable; the behaviour asserted is the default itself —
  `packages/auth-plugin/test/integration/realtime-auth.test.ts` pins that the strategy reads
  whatever cookie arrives and makes no origin judgement of its own.

### 3.10 SSE needs no source change

- **Decision:** `sse-plugin` ships documentation only. `SsePlugin.register` registers no kernel
  route and `SseService.open(ctx)` receives the live `IRequestContext` (`sse-service.ts:125`), so
  once a cookie-bearing request produces a principal, `requireAuth()` on the application's own SSE
  route admits an `EventSource` exactly as it admits a `fetch`.
- **Why this is worth stating rather than assuming:** the observed X3-5 symptom was a `401` on
  `EventSource`, which reads as an SSE defect; the mechanism is entirely in the strategy chain. A
  test driving a cookie-only request through a `requireAuth()`-guarded SSE route is what turns that
  from a claim into a check.
- **Test home:** `packages/auth-plugin/test/integration/realtime-auth.test.ts` — the
  `EventSource`-shaped case (a `GET` with `accept: text/event-stream`, a `cookie` header, and no
  `authorization`).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                              | Kind             | Consumer / real code path that READS it                                                                                                                                  |
| ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionView` (`common`)                                     | type             | Return element of `ISessionService.fromHeaders`; the parameter type of `SessionAuthOptions.toPrincipal`, which every application configuring `session` writes against.   |
| `ISessionService.fromHeaders` (`common`)                     | interface member | Called by `SessionStrategy.authenticate` in `auth-plugin`, and by application `onOpen` code reading a socket's session payload (documented in the websocket README, C2). |
| `WebSocketConnectionContext.user` (`common`)                 | interface member | Read by application `onOpen` handlers; written by `buildContext` in `websocket-plugin`; asserted by the websocket e2e and the kernel integration test.                   |
| `IWebSocketService.routeUpgrade` second parameter (`common`) | interface member | Passed by `Application.#tryUpgrade` (`application.ts:771`); consumed by `WebSocketService.routeUpgrade`.                                                                 |
| `SessionAuthOptions` (`auth-plugin`)                         | type             | The type of `AuthPluginOptions.session`; named in `PUBLIC_API.md` and the auth README so an application can annotate its own configuration object.                       |
| `AuthPluginOptions.session` (`auth-plugin`)                  | option           | Read by `AuthPlugin.register` to construct `SessionStrategy` and to decide the `CAPABILITIES.SESSION` refusal.                                                           |
| `AuthPluginOptions.strategies` (`auth-plugin`)               | option           | Read by `AuthPlugin.register`, appended to the internal strategy array after the built-ins, and passed to `new AuthService(...)`.                                        |

**Not exported, deliberately:** `SessionStrategy` (§3.4 — the `session` option is the configuration
surface; the two existing strategies are unexported for the same reason) and `SessionSnapshot`
(session-plugin-internal; `SessionView` is the public projection).

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                       | Behavior (per implementation)                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthPluginOptions.session`             | `AuthPlugin.register`          | Absent: no `SessionStrategy` is constructed and the chain is byte-identical to today. Present: `SessionStrategy` is appended after the API-key strategy, and `register()` throws when `CAPABILITIES.SESSION` is not registered. |
| `AuthPluginOptions.session.toPrincipal` | `SessionStrategy.authenticate` | Required. Called with the `SessionView` for a request whose cookie opened. Returning `IPrincipal` populates `ctx.request.user` via `authMiddleware`; returning `null` continues the chain.                                      |
| `AuthPluginOptions.strategies`          | `AuthPlugin.register`          | Absent: unchanged. Present: appended in declaration order after every built-in. A `name` colliding with any other strategy in the assembled array throws at `register()`.                                                       |

## 5. Implementation files

| File                                                          | Purpose                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/session.ts`                     | Add `SessionView`; add `fromHeaders` to `ISessionService` with JSDoc stating the read-only, no-commit contract and the six `null` conditions.                    |
| `packages/common/src/services/websocket.ts`                   | Add `WebSocketConnectionContext.user?`; widen `IWebSocketService.routeUpgrade` with the optional `principal` parameter and document what its absence means.      |
| `packages/common/src/index.ts`                                | Export `SessionView`.                                                                                                                                            |
| `packages/session-plugin/src/services/session-service.ts`     | Implement `fromHeaders`; lift the cookie read out of `load` into one private helper both entry points call.                                                      |
| `packages/auth-plugin/src/strategies/session-strategy.ts`     | New `SessionStrategy` — `name = 'session'`, reads the cookie via `ISessionService.fromHeaders(request.headers)`, maps through `toPrincipal`.                     |
| `packages/auth-plugin/src/interfaces/index.ts`                | Add `SessionAuthOptions`; add `session?` and `strategies?` to `AuthPluginOptions`.                                                                               |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`              | Add `optionalDependencies`; construct `SessionStrategy` behind the capability refusal; append caller strategies; enforce unique names.                           |
| `packages/auth-plugin/src/index.ts`                           | Export `SessionAuthOptions`.                                                                                                                                     |
| `packages/kernel/src/application/application.ts`              | Pass `ctx.request.user` as the second argument at the `routeUpgrade` call site.                                                                                  |
| `packages/websocket-plugin/src/services/websocket-service.ts` | Extract `#routeReported(request, principal?)`; thread the principal through `#route` into `buildContext`; widen `buildContext` with an optional third parameter. |
| `packages/websocket-plugin/README.md`                         | C1 and C2 rewrites, plus the worked cookie-auth `onOpen` example.                                                                                                |
| `packages/sse-plugin/README.md`                               | C5 — the new `## Authentication` section.                                                                                                                        |
| `packages/auth-plugin/README.md`                              | C6 — option-table rows, the strategy-order rule, and the `SessionStrategy` bullet.                                                                               |
| `PUBLIC_API.md`                                               | C6 and C7 — Auth option rows and export row, `ISessionService.fromHeaders` in the Session section, `WebSocketConnectionContext.user` in the WebSocket section.   |
| `ARCHITECTURE.md`                                             | C3 and C4.                                                                                                                                                       |
| `CHANGELOG.md`                                                | Added rows for the three additions; a **Changed** row with migration text for the required `fromHeaders` member (§8, breaking for implementors).                 |
| `smoke/DEFECTS.md`                                            | C2 — X3-5 moved to closed with this PR number.                                                                                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/test/unit/session-from-headers.test.ts`             | `session-service.ts` (`fromHeaders`, shared cookie helper)        | Against `fromHeaders(headers: Headers): Promise<SessionView                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/session-plugin/test/unit/session-service.test.ts` (extended)       | `session-service.ts`                                              | `load(ctx)` and `fromHeaders(ctx.request.headers)` return the same `id` and the same payload for one cookie — the two-entry-points-one-implementation rule, driven under a **non-default** configuration (`mode: 'sign'`, a custom `cookie.name`, and a `store`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/test/unit/session-strategy.test.ts`                    | `session-strategy.ts`                                             | Against `authenticate(request: IRequest): Promise<IPrincipal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/auth-plugin/test/unit/auth-plugin.test.ts` (extended)              | `auth-plugin.ts`, `interfaces/index.ts`                           | `optionalDependencies` contains `CAPABILITIES.SESSION`; `session` configured with no session capability → `register()` throws naming both plugins; assembled order is jwt, api-key, session, then caller strategies, asserted by driving a request satisfying jwt **and** session and observing the jwt principal; `strategies` appended in declaration order; a caller strategy named `'jwt'` → throws; no `session` and no `strategies` → the chain is unchanged from today.                                                                                                                                                                                                                                                                        |
| `packages/auth-plugin/test/unit/barrel-exports.test.ts` (extended)           | `auth-plugin/src/index.ts`                                        | `SessionAuthOptions` is exported (compile-time assertion declared against the barrel, per M70m); `SessionStrategy` is **absent** from the barrel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                | `common/src/index.ts`                                             | `SessionView` is exported; a compile-time assertion pins its shape, since a type-only export is invisible to every runtime assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/common/test/unit/contract-types.test.ts` (extended)                | `services/session.ts`, `services/websocket.ts`                    | Type-level: a `WebSocketConnectionContext` literal without `user` still satisfies the interface; a single-parameter `routeUpgrade` implementation is still assignable to `IWebSocketService`; an `ISessionService` implementation **without** `fromHeaders` is a compile error (`@ts-expect-error`, self-validating — an unused directive fails the build).                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/auth-plugin/test/integration/realtime-auth.test.ts`                | end-to-end, `auth-plugin` + `session-plugin` + kernel             | A real `createApplication` with `RuntimePlugin`, `SessionPlugin`, `AuthPlugin({ session })`, `sessionMiddleware` at 260 and `authMiddleware()` at 300. Step 1 logs in and captures `Set-Cookie`. Step 2 replays that cookie with **no `authorization` header** against a `requireAuth()`-guarded route → `200` with the mapped principal id. Step 3 replays it against a `requireAuth()`-guarded SSE route (`accept: text/event-stream`) → `200` with `content-type: text/event-stream` — the `EventSource` row of X3-5. Step 4: no cookie → `401`. Step 5: a bearer token **and** a cookie → the jwt principal, pinning §3.6's order. Driven with `app.fetch`, never `inject()`, because step 1 reads `Set-Cookie` and step 3 answers with a stream. |
| `packages/websocket-plugin/test/unit/websocket-service-upgrade-user.test.ts` | `websocket-service.ts` (`routeUpgrade`, `#route`, `buildContext`) | `routeUpgrade(request, principal)` produces a decision whose `onOpen` context carries `user` deep-equal to the principal; `routeUpgrade(request)` with no principal produces a context where `'user' in context` is `false` (omitted, not `undefined` — `exactOptionalPropertyTypes`); `createUpgradeRouter()` still type-checks as `(request: Request) => Promise<WebSocketUpgradeDecision                                                                                                                                                                                                                                                                                                                                                           |
| `packages/kernel/test/integration/upgrade-principal.test.ts`                 | `application.ts` (`#tryUpgrade`)                                  | With a fake `IWebSocketService` recording its arguments and a middleware that sets `ctx.request.user` at the authentication band, an upgrade request reaches `routeUpgrade` with that exact principal; with no authenticating middleware it reaches `routeUpgrade` with `undefined`; a service whose `routeUpgrade` takes one parameter still works (the optional-parameter compatibility claim). The fake applies real RFC 6455 detection rather than accepting any GET, so it cannot pass for the wrong reason (the M70a lesson).                                                                                                                                                                                                                   |
| `packages/websocket-plugin/test/e2e/cookie-auth-socket.test.ts`              | end-to-end, real socket on Deno                                   | A real listening app with `SessionPlugin` + `AuthPlugin({ session })`. (a) A real `WebSocket` opened with a valid session cookie completes the handshake and its `onOpen` observes `context.user.id`; the same connection opens `fromHeaders(context.headers)` and reads a value the login handler wrote. (b) An upgrade with no cookie against a globally guarded path is refused **before** the socket opens (`401`, no `onOpen`). (c) An upgrade with no cookie against an unguarded path opens and is closed `1008` by `onOpen` reading an absent `context.user`.                                                                                                                                                                                 |
| `packages/sse-plugin` — no new test                                          | none (documentation only)                                         | The SSE behaviour is asserted in `realtime-auth.test.ts` step 3, in `auth-plugin`, because that is where the strategy that fixes it lives. Recorded here so the mapping is explicit rather than an omission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Negative controls** (each observed failing, then reverted; results recorded in the PR):

1. Revert the `session` arm from `AuthPlugin.register` → the integration steps 2 and 3 fail with
   `401`, reproducing X3-5's observed table verbatim.
2. Revert the principal argument at `application.ts:771` → the kernel integration test and the
   websocket e2e (a) fail, while every other websocket test passes — proving the bridge, not merely
   the context field, is what carries the identity.
3. Change the assembled order to put caller strategies first → the §3.6 order assertion fails while
   the rest of the auth suite passes.
4. Make `SessionStrategy` read `session.data.user` by convention instead of calling `toPrincipal` →
   the strategy unit test's custom-key case fails, proving §3.3's callback is load-bearing.
5. Drop `optionalDependencies` from `AuthPlugin` → assert whether the ordering test still passes. If
   it does, the plan's §3.5 claim is overstated and is corrected in this plan rather than left
   standing (the M45b precedent, where exactly this control falsified the plan's claim).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m73-realtime-authentication, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus, because this milestone changes a package's `src/index.ts` and a committed `common` contract:

```bash
deno task publish:check              # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.9
```

And the repo-wide construct audit over every touched package:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/{common,kernel,auth-plugin,session-plugin,websocket-plugin,sse-plugin}/src
```

## 8. Risks & mitigations

- **`ISessionService.fromHeaders` is required, so it is breaking for any application that implements
  `ISessionService` itself.** Mitigation: the framework's `SessionService` is the only in-repo
  implementor (verified by grep), the M51b `IGraphqlService.subscribe` precedent covers exactly this
  shape, and a **Changed** CHANGELOG entry ships with migration text naming the one method to add.
  Callers are unaffected — the addition is source-compatible for every consumer.
- **A cookie-authenticated socket widens what a cross-site page can reach**, if an application sets
  `cookie.sameSite: 'none'`. Mitigation: §3.9 — no default moves, and the exposure plus the
  `Origin`-check remedy is documented in the websocket README, the sse README and `PUBLIC_API.md`.
- **A `SessionView` handed to `onOpen` is a snapshot taken at handshake time and never refreshes**,
  so a session destroyed mid-connection leaves the socket open. Mitigation: state it plainly in the
  websocket README beside the example, and point at the `1008` close as the application-side
  revocation path. A push-based revocation channel is out of scope (§9).
- **`toPrincipal` runs on every request carrying a cookie**, so an expensive implementation is a
  per-request cost on the hot path. Mitigation: `fromHeaders` short-circuits to `null` before
  `toPrincipal` for a request with no session cookie, the JSDoc states the callback must be cheap
  and synchronous-shaped, and the store strategy's one store read is the same read `load()` already
  performs for the same request.
- **The websocket e2e needs a real socket and a real listening port.** Mitigation: the package
  already runs real-socket e2e on Deno since M46; the new file follows it and takes an ephemeral
  port rather than a constant.
- **Two of this milestone's doc corrections (C1, C4) touch text outside the packages it changes.**
  Mitigation: both are named deliverables here, and C4's gRPC half is one sentence in the same
  paragraph block as the WebSocket half — leaving a known-false neighbour is the drift this plan
  exists to stop.

## 9. Out of scope

- **A read-only `room()`/`channel()` lookup, and the `SseMessage.data` narrowing** — **M74** owns
  both. Reading presence for a caller-supplied name is still a write after this milestone.
- **Broker trace propagation** — **M75**.
- **A per-route `guard` option on `WebSocketRouteOptions`.** §3.8 gives two working mechanisms; a
  route-level option is a websocket-plugin design decision (where the guard runs, what it receives,
  what it can answer with) that this milestone does not take.
- **Per-subscriber authorization on fan-out.** `SseChannel.publish` skips only closed members
  (`channel-registry.ts:65`) and `WebSocketRoom.broadcast` likewise attaches no identity, so
  filtering a broadcast by principal is a registry redesign, not an authentication gap. Named here
  so it is not read as an oversight.
- **Push-based session revocation for a live socket.** A `SessionView` is a snapshot; invalidating
  an open connection when its session is destroyed needs a revocation channel the framework has no
  contract for. Recorded in §8 and in the websocket README.
- **Deriving OpenAPI security from a cookie strategy.** M57's `deriveSecurity` reads the brand on
  route middleware; `SessionStrategy` is not middleware and neither `EventSource` nor a WebSocket
  upgrade appears in an OpenAPI document, so there is nothing to derive.
- **The `Origin` check for cross-site upgrades.** `http-security-plugin` owns origin policy (§3.9);
  duplicating it here would put one rule in two packages.
