# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`honoe new --template full-stack`** (Milestone 36c) — scaffolds a React Router 8 SSR
  application: the `routes → features → services → models` layering, `flatRoutes` `_app`/`_auth`
  layout groups, the `~/*` alias, the `.server.ts` convention, one worked feature, and the Vite
  build files. What it deliberately does **not** emit is as important as what it does: no
  `lib/session.server.ts`, `lib/csrf.server.ts`, `lib/sse.server.ts`, `lib/kv.server.ts` or
  `lib/service-logger.server.ts`, because those are the session, SSE, secrets and logger
  capabilities, reached through the service registry the SSR plugin attaches to every request. The
  session reaches loaders through a context key the **application** declares and
  `populateLoadContext` fills, so no plugin imports another. Every runtime target is supported;
  Cloudflare Workers omits `assetsDir` and leaves assets to the platform binding. This is the only
  template that composes through a starter rather than inline wiring — its plugin set is twenty-two,
  and a generated file a human is meant to edit should not open with twenty-two imports they did not
  choose.
- **`contextKeyFor` in `@hono-enterprise/react-router-plugin`** (Milestone 36c) — creates React
  Router context keys by name, memoised, so the same name always yields the same object. Keys are
  matched by identity, and in a framework-mode application the module declaring them exists twice:
  Vite inlines application modules into the server build, while the runtime loads `honoe.config.ts`
  from source. Two hand-written `{ defaultValue }` literals then match nothing, and every read
  silently returns the default — a session that is always `null`, a CSRF token that is always empty,
  with no error raised. Requires the server build to treat `@hono-enterprise/*` as external
  (`environments.ssr.build.rollupOptions.external`), which the `full-stack` template configures. The
  `serverBuildPath` JSDoc now also states that the path must be **absolute**: the loader does
  `await import(serverBuildPath)`, so a relative specifier resolves against the plugin's own module
  and can never find the application's build.
- **`createFullStackAppFromConfig` in `@hono-enterprise/full-stack-starter`** (Milestone 36c) —
  `(build: (config: IConfig) => FullStackStarterOptions, configOptions?) =>
  Promise<IKernelApplication>`.
  Plugin options must be decided before the plugins are constructed, which is before `ConfigPlugin`
  has registered anything; this loads configuration once, hands the snapshot to the resolver, and
  passes that same object into the application, so the values the composition branched on are the
  values handlers read. It applies to every option uniformly, which is why no plugin option carries
  a `urlFromConfig`-style config-key field — such a field would need its value at the same
  impossible moment. Secrets remain out of reach by construction: they are served by a plugin that
  exists only after registration.
- **`loadConfig` and `ConfigPluginOptions.instance` in `@hono-enterprise/config-plugin`** (Milestone
  36c) — `loadConfig(runtime, options?)` is the same implementation `ConfigPlugin` registers,
  reachable without an application; `instance` registers a supplied snapshot verbatim, reading
  nothing from the environment. `ConfigPlugin.register` now delegates to `loadConfig`, so merging,
  expansion, and validation cannot drift between the two paths.
- **`createRuntimeServices` in `@hono-enterprise/runtime`** (Milestone 36c) — builds
  `IRuntimeServices` for the detected platform without an application. The barrel previously
  exported `detectRuntime` and four per-platform factories but nothing joining them, so the platform
  → adapter map was unreachable outside `RuntimePlugin.register`; that method now delegates here,
  leaving one implementation behind two entry points. `RuntimeAdapterFactories` and
  `CreateRuntimeServicesOptions` are exported alongside it.
- **Gated `session` arm on the three starters** (Milestone 36c) — `RestStarterOptions.session`
  registers `SessionPlugin`, inherited by the microservice and full-stack tiers. M48 shipped after
  the starters, so no tier could previously register a session at all. Gated because the plugin
  throws during `register()` without an adequate secret; **no default changes**.
- **Parameter-level `@Inject` in `@hono-enterprise/decorator-plugin`** (Milestone 36b) — `Inject`
  now works on a constructor parameter as well as on the class, binding one token to that argument
  by position, which is the form a developer arriving from NestJS expects:
  `constructor(@Inject(CAPABILITIES.DATABASE) private db: IDatabase) {}`. The class-level positional
  list is **deprecated, not removed** (AI_GUIDELINES §9.2) and keeps working for the whole `0.x`
  line. A token is still always required — inferring it from the parameter's type needs
  `emitDecoratorMetadata`, which Deno does not support — so three ambiguous cases throw at startup
  rather than misinjecting silently: mixing the two forms on one class, leaving a constructor
  parameter undecorated below the last injected one, and applying `@Inject` to a _method_ parameter.
- **Gated `realtime` and `di` arms on the three starters** (Milestone 36b) — `realtime` groups
  `websocket`, `sse`, and `backplane` sub-arms; `di` adds `DiPlugin`. Added to `RestStarterOptions`,
  so the microservice and full-stack tiers inherit them. **No default changes**: with no arm
  supplied the plugin set of all three tiers is byte-identical to the previous release. Supplying
  `di` does change how decorated services are constructed (`DecoratorPlugin` switches to its
  container path), which is why it is opt-in. `RealtimeArm` is exported from all three starter
  barrels.
- **`honoe new --template nest`** (Milestone 36b) — the REST plugin set plus `DiPlugin`, an
  `@Injectable` service, and a `@Controller` using parameter-level `@Inject`. Emits inline wiring
  like the other templates, and refuses no runtime target.
- **`Wiring.args`, `TemplateDefinition.localImports`, and `TemplateDefinition.files` in
  `@hono-enterprise/cli`** — the template contract could previously express neither a plugin call
  argument nor an extra emitted source file. All three are optional and every existing template
  renders byte-identically (`args` absent → `Symbol()`).
- **`@hono-enterprise/session-plugin`** (Milestone 48) — cookie-backed sessions and session-backed
  form CSRF, registering an `ISessionService` under the new `CAPABILITIES.SESSION` token. The
  default is a self-contained encrypted cookie (AES-256-GCM under an HKDF-SHA256 derived key,
  entirely through `runtime.subtle`), so the package has **zero npm dependencies** and works on
  Cloudflare Workers. Setting `store` (`'memory'`, `'cache'`, or a custom `ISessionStore`) moves the
  payload server-side and leaves an opaque id in the cookie, which is what makes immediate
  revocation possible. Secret rotation goes through a key list — index 0 seals, every entry opens —
  with an HKDF-derived non-secret `kid` in the envelope so opening is a lookup rather than trial
  decryption. Ships `getSession`, `getCsrfToken`, `verifyCsrfToken`, `csrfFormMiddleware`,
  `sessionMiddleware`, both stores, and four error types. Note that `mode: 'sign'` protects
  integrity only and leaves the payload readable by the client; `'encrypt'` is the default so that
  choice is never accidental.
- **`parseCookie` / `serializeCookie` / `CookieAttributes` in `@hono-enterprise/common`** — the
  framework's single cookie codec. It lives in `common` because the session plugin and the decorator
  plugin's `@Cookie` both need it and no plugin may import another (the `encodeFrameData`
  precedent).
- **`ISessionService` / `ISession` / `ISessionStore` / `SessionData` contracts** and
  `CAPABILITIES.SESSION` in `@hono-enterprise/common`. No `IRequest` widening was needed: the
  session middleware parks the session in `ctx.state`, so a `cookies` field with no consumer was
  declined.
- **`scalingNotice` option on `WebSocketPluginOptions` and `SsePluginOptions`** (`boolean`, default
  `true`) — set `false` to silence the startup notice described below, for a deployment where you
  have decided single-replica fan-out is correct and do not want the line on every boot. It
  suppresses the message only: room and channel delivery are identical either way, and the notice
  never appears once a backplane is registered.

### Changed

- **`DecoratorPlugin` now prefers the DI container for any class registered in it, with or without
  `@Injectable`.** `instantiate()` required service metadata before consulting the container, so a
  `@Controller` — which carries no `@Injectable` — took the service-registry path even in an
  application with `DiPlugin`, where its dependencies live in the container and not the registry,
  and construction failed outright with "No service registered for capability". The guard
  contradicted the function's own documented behavior. Reachable before this release only for a
  controller whose constructor took arguments; parameter-level `@Inject` makes that composition
  ordinary, which is how it surfaced.
- **`decorator-plugin`'s exported `parseCookies` now delegates to `common`'s `parseCookie`, which
  changes its output in three cases.** The signature is unchanged and no call site needs editing,
  but the values it returns can differ, so read this if you use `@Cookie` or call `parseCookies`
  directly. Each difference is a defect fix rather than a preference:
  - **Values are percent-decoded.** A cookie written by any standards-compliant server (including
    this framework's own `serializeCookie`) was previously returned still-encoded — `@Cookie('x')`
    handed you `a%20b` where the value was `a b`. If you were decoding the result yourself, remove
    that step; double-decoding will now corrupt a value containing a literal `%`.
  - **One layer of RFC 6265 quoting is stripped**, so `sid="abc"` yields `abc` rather than `"abc"`.
  - **A repeated cookie name resolves to the first occurrence, not the last.** Browsers send the
    most specific cookie first, so the first is the one that was meant.

  The alternative was two cookie parsers in the tree, which AI_GUIDELINES §11.1 forbids. Shipping
  the correction during `0.1.x` pre-release rather than freezing the defect follows the precedent of
  the Milestone 14d wire change and the Milestone 30b FCM replacement.

- **`websocket-plugin` and `sse-plugin` now say at startup that rooms and channels are
  process-local** when no realtime backplane is registered — one `info` line naming the limitation,
  the plugin that lifts it, and the transport it needs (`'redis'` or `'messaging'`; the backplane
  plugin's default `'memory'` transport is a single-process bus, so registering it bare would
  silence the notice without fanning anything out). Cross-replica fan-out has shipped since
  `0.1.0-alpha.3`, but a single-replica app and a three-replica app behave identically right up to
  the point where two thirds of your clients silently stop receiving broadcasts, with no error
  raised anywhere. Both READMEs gain a **Scaling beyond one replica** section for the same reason.
  If you run a single replica the line is informational and safe to ignore; registering a backplane
  under the `REALTIME_BACKPLANE` token removes it.

### Fixed

- **`honoe new` now refuses a project plan containing the same path twice** (Milestone 36c). The
  overwrite check probes the filesystem, so it could not see a duplicate inside one plan: both files
  were written and the last silently won. A template emitting `deno.json` would have overwritten the
  framework manifest with no warning.
- **The CLI drift gate resolved starter packages to the wrong directory** (Milestone 36c). It mapped
  `@hono-enterprise/<name>` to `packages/<name>`, but the three starters live under
  `packages/starters/`, so any template importing one could not be type-checked. It also rewrote
  every import-map entry, mangling a template's project-local alias (`~/`) into a package path.
- **`websocket-plugin`'s README no longer claims cross-replica fan-out is unimplemented.** It stated
  "fan-out across replicas is a follow-up milestone; today two instances behind a load balancer do
  not share rooms", which stopped being true when `realtime-backplane-plugin` shipped in
  `0.1.0-alpha.3`.
- **`sse-plugin`'s README named a method that does not exist.** Its named-channels example called
  `channel.broadcast(...)`; the committed `SseChannel` contract exposes `publish(...)` and no
  `broadcast`, so the snippet would not compile.
- **`realtime-backplane-plugin`: `RedisBackplane.connect()` no longer leaks a connection on a failed
  open, and is safe to call concurrently.** The connected guard was only set after both connections
  had been constructed, so two overlapping calls each built their own pair — and if the second
  construction threw, the first connection was already live with nothing holding a reference to
  close it. The open is now memoized, so overlapping callers join one attempt and none of them
  returns before `SUBSCRIBE` has actually landed; a failed attempt quits whatever it built, removes
  its own listener from injected clients but does not close them (they belong to the caller), and
  clears the memo so a later call retries. A `close()` arriving mid-open now wins as well: the open
  retires whatever it built instead of publishing two live connections onto a backplane that has
  already shut down, which is what a shutdown during startup would otherwise strand.
  `RealtimeBackplanePlugin` calls `connect()` exactly once and `close()` only from `onClose`, so no
  application behavior changes — this closes the seam for callers driving the transport directly.

## [0.1.0-alpha.3] — 2026-07-30

**Two breaking changes ship in this release.** Both are narrow, but you meet them in production
rather than in this file, so they are stated here in full and again under _Changed_.

> **⚠️ Breaking 1 of 2: brokered request-reply changes on the wire.** `request()`/`respond()` move
> from `<topic>` to a derived `rr.req.<topic>` channel, so a responder running `0.1.0-alpha.2` and a
> caller running this version **will not talk to each other**. RPC callers and responders must be
> restarted together, not rolled one at a time. Fire-and-forget `publish`/`subscribe` are
> unaffected, as is every other plugin. If you do not use `request`/`respond`, nothing here applies
> to you.

> **⚠️ Breaking 2 of 2: the FCM push channel takes service-account credentials.**
> `FcmProviderOptions.serverKey` is **replaced** by `{ projectId, clientEmail, privateKey }`, so
> existing config stops compiling. That is deliberate rather than a deprecation: `serverKey`
> addressed the legacy endpoint Google switched off in 2024, so every push sent through it already
> failed. A compile error is the only honest signal. If you do not configure a `push` channel,
> nothing here applies to you.

**Kafka gains request-reply, and five of the known limitations recorded against `0.1.0-alpha.1` are
closed.** Every entry below was a real capability gap rather than a documentation problem, so each
is fixed in code; the alpha.1 list annotates them in place rather than deleting them, because that
section records what was true of that release.

Kafka was not the reason Kafka lacked request-reply: the shared request-reply core minted its own
inbox topic and imposed it on every broker, which only works where topics are cheap and
per-instance-addressable. Brokers now supply their own reply inbox, so Kafka can read a shared reply
topic under a per-instance consumer group instead. The same seam is where a future native AMQP
`replyTo` or NATS JetStream reply-subject transport would plug in. Two defects in the M14c
implementation are fixed alongside it, both consequences of RPC sharing a topic with ordinary
pub/sub.

Alongside that, WebSocket rooms and SSE channels gain cross-replica fan-out, `feature-flags-plugin`
gains a LaunchDarkly provider, and `resilience-plugin` timeouts finally cancel the work they bound.

### Added

- **Kafka now supports brokered request-reply.** `KafkaBroker.request`/`respond` previously rejected
  outright; all five brokers are now reply-capable. Replies travel on a shared reply topic — the new
  `replyTopic` option, default `'messaging.replies'` — read by a consumer group unique to each
  broker instance, so delivery is exclusive to the caller rather than load-balanced across the
  shared default group. **The reply topic must already exist**: `IKafkaFactory` exposes no admin
  surface, so the broker creates no topics. Every instance receives every reply and discards those
  it did not originate; give a high-traffic service its own `replyTopic` to bound that fan-out.
- Each broker now supplies its own reply inbox through an internal seam, rather than having a topic
  string imposed on it by the shared request-reply core. The four brokers that were already
  reply-capable pass a shared helper and are behaviourally unchanged.
- **`notification-plugin` push delivery works again, on FCM HTTP v1.** `FcmProvider` now posts to
  `/v1/projects/{projectId}/messages:send` with an OAuth2 bearer token minted from a service
  account: it signs an RS256 JWT assertion with `runtime.subtle` and caches the token until shortly
  before expiry, so a send costs one request in the steady state. Zero npm dependencies and
  Workers-portable, like the other HTTP providers. A new `FcmTokenSource` export lets you source
  tokens elsewhere (a GCP metadata server, a key-holding broker) instead of from a local key.
- **`@hono-enterprise/realtime-backplane-plugin`** — cross-replica fan-out for WebSocket rooms and
  SSE channels. It registers an `IRealtimeBackplane` under the new `CAPABILITIES.REALTIME_BACKPLANE`
  token, which `websocket-plugin` and `sse-plugin` resolve **optionally** — so adding the plugin is
  the entire change needed to make `ws.room('lobby')` and `sse.channel('news')` reach clients on
  other replicas, and removing it restores in-process behavior with no application change. Four
  transports: `'memory'` (the default, and a real single-process bus rather than a no-op),
  `'messaging'` (over whatever broker is registered under `CAPABILITIES.MESSAGING`, reusing all five
  existing brokers with no new dependency), `'redis'` (pub/sub over an inject-or-lazy `ioredis`),
  and `'custom'`.
- **A LaunchDarkly provider** for `@hono-enterprise/feature-flags-plugin`
  (`provider: 'launchdarkly'`), plus an optional `IFeatureFlags.isEnabledAsync` for callers that can
  await an answer carrying no cold-context caveat.
- **Real cancellation** in `@hono-enterprise/resilience-plugin`: `wrap` hands the protected call an
  `AbortSignal`, and the returned callable accepts an optional caller-owned one.
- **`@hono-enterprise/sdk`** — the client SDK publishes for the first time. Together with the
  realtime backplane above, that brings the published total to **38 packages**. A portable,
  zero-npm-dependency HTTP client for consuming a Hono Enterprise API from a browser or a server:
  `createClient()` returns an `IHttpClient` with one `request<TResponse, TBody>()` method, plus
  bearer and API-key request-interceptor factories, request/response interceptors, retry with
  fixed/exponential backoff honoring a delta-seconds `Retry-After`, a rolling-window circuit
  breaker, and a sliding-window rate limiter. Both the transport (`fetch`) and time
  (`IClientTiming`) are injectable seams, so nothing needs a network or a real clock to test. It
  registers no plugin and resolves no capability token — its only in-repo import is type-level from
  `@hono-enterprise/common`, which re-exports `RetryPolicy`, `CircuitBreakerPolicy`, and
  `BackoffStrategy` through the SDK barrel so consumers need not depend on `common` directly.
  `generateOpenApiClient(document, options?)` is a pure function turning an OpenAPI 3.1 document
  into type-checked TypeScript client source; it throws `OpenApiCodegenError` with the offending
  path and method rather than emitting a client that misbehaves or will not compile.

### Changed

- **BREAKING: `FcmProviderOptions.serverKey` is replaced by service-account fields.** The push
  channel now takes `{ projectId, clientEmail, privateKey }` (or a `tokenSource`) instead of
  `serverKey`. This is not a deprecation: `serverKey` addressed an endpoint Google switched off in
  2024, so every send through it already failed. Existing config becomes a compile error, which is
  the intended signal.

  ```typescript
  // Before — never reached a live endpoint
  push: { provider: 'fcm', options: { serverKey: config.get('FCM_SERVER_KEY') } }

  // After — values come from the service-account JSON
  push: {
    provider: 'fcm',
    options: {
      projectId: config.get('FCM_PROJECT_ID'),
      clientEmail: config.get('FCM_CLIENT_EMAIL'),
      privateKey: config.get('FCM_PRIVATE_KEY'),
    },
  }
  ```

  A `push` channel using the default signer now needs `CAPABILITIES.RUNTIME` (for Web Crypto and the
  clock) and throws during `register` without it, rather than failing on the first notification.
- **BREAKING (wire format): request-reply traffic moved to a derived channel.** `request(topic, …)`
  now publishes to, and `respond(topic, …)` subscribes to, `rr.req.<topic>` instead of `<topic>`. A
  `0.1.0-alpha.2` responder and a later requester **do not interoperate** — during an upgrade,
  restart RPC responders and callers together rather than rolling them one at a time.
  Fire-and-forget `publish`/`subscribe` are unaffected.
- **`IResilienceService.wrap` and `ICircuitBreaker.execute` widened.** `wrap<T>` now takes a
  `ResilientCall<T>` (`(signal: AbortSignal) => Promise<T>`) and returns a `HardenedCall<T>`
  (`(signal?: AbortSignal) => Promise<T>`). **Source-compatible for callers** — a zero-argument
  `() => Promise<T>` is still accepted and `await guarded()` still works — but **breaking for
  implementors**, because `fn` sits in a contravariant position, so an object literal declaring
  `wrap<T>(fn: () => Promise<T>)` no longer satisfies the interface. Implementors add the parameter.
- **`websocket-plugin` and `sse-plugin` `register()` are now async**, awaiting the optional
  backplane subscription. The kernel already awaited an async `register`, so applications are
  unaffected; a test calling `plugin.register(ctx)` directly must now await it.

### Fixed

- **Request envelopes leaked into plain subscribers.** A responder shared the raw topic with
  pub/sub, so a `subscribe('orders', …)` handler received the raw `rr-request` envelope instead of
  the payload. Separate channels fix this at the routing layer.
- **A responder could swallow a competing consumer's message.** Where a responder and an ordinary
  subscriber shared a topic _and_ a queue (competing-consumer delivery), the responder consumed its
  share of the round-robin and its envelope guard discarded anything that was not a request — the
  message vanished with no signal. Fan-out subscribers were unaffected.
- **The reply inbox subscribed without a queue name**, so on a broker that falls back to a shared
  consumer group (Kafka) replies could be delivered to a different instance than the caller, which
  then discarded them by correlation-id lookup — surfacing as an unexplained timeout. Each inbox now
  claims its own queue.
- **Resilience timeouts cancel the work they bound.** `timeout` raced the protected call against a
  timer and left it running; it now aborts the call's signal with the same `TimeoutError` instance
  it rejects with, so a call that forwards the signal to its I/O genuinely stops. Retry stops
  looping on abort and wakes its backoff early — that sleep also no longer leaks a timer handle on
  every attempt — and a bulkhead waiter cancelled while queued leaves the queue and never runs its
  call.
- **Six package pages on jsr.io now show their README.** `cli`, `feature-flags-plugin`,
  `multi-tenancy-plugin`, `openapi-plugin`, `queue-plugin`, and `storage-plugin` rendered a one-line
  blurb instead in `0.1.0-alpha.2`. Not a packaging fault — `/README.md` was in every published
  tarball. JSR's `readmeSource` defaults to `jsdoc` and falls back to README.md only when the
  entrypoint's module doc has no description; deno_doc drops prose that _follows_ a tag, so a block
  opening with `@module` has no description and the README renders, while one whose description
  comes first and ends with `@module` replaces the whole page. Those six were the only
  description-first entrypoints. `deno task release:verify` now enforces `@module`-first, because
  nothing else sees this: the README ships in the tarball, so every gate and
  `deno publish
  --dry-run` stay green and the loss shows up only on jsr.io.

### Deprecated

- **`MessagingNotSupportedError`** — no broker throws it now that Kafka implements request-reply.
  The export is retained so `instanceof` checks written against `alpha.1`/`alpha.2` keep compiling,
  and will be removed in the next major. Nothing replaces it; delete the branch.

### Notes

One real-time limitation remains, documented rather than silently approximated: `Room.size` /
`SseChannel.size` report **local** membership. A cluster-wide count is inherently asynchronous — it
needs a scatter-gather across replicas — so it cannot satisfy the synchronous committed `size`
getter and wants a separate async method. That is a later milestone.

`RoomBroadcastOptions.except` **is** honored cluster-wide: connection IDs come from `runtime.uuid()`
and are globally unique, so the frame carries the excluded ID and every replica skips it.

A call that ignores its `AbortSignal` still runs to completion; cancellation is cooperative, and the
widened JSDoc says so.

**FCM push has not been exercised against live FCM.** The HTTP v1 rewrite is asserted field by field
— request URL, headers, and body shape — and its RS256 assertion is signed and verified with real
Web Crypto, but no test reaches Google: CI holds no Firebase project. The endpoint and auth scheme
follow Google's documented HTTP v1 contract, and the previous `serverKey` path was provably dead, so
this is strictly an improvement — but if you depend on push, verify it against your own project
before you rely on it, and please report what you find.

All 38 packages are live on JSR at `0.1.0-alpha.3`.

Verified after publishing by querying every package on the registry, then installing `kernel` and
`runtime` from JSR into a throwaway directory — not the workspace, whose import map resolves locally
and would mask a broken published dependency — and serving a request (`200 {"ok":true}`). `common`
resolved transitively at `0.1.0-alpha.3`, which is the only real evidence that the cross-package
specifier bump landed inside the published tarballs: a dry run resolves those from the workspace and
so cannot show it.

The six package pages that shipped `0.1.0-alpha.2` without a visible README were re-checked and now
render theirs. The same check run against their `0.1.0-alpha.2` pages still finds no README content,
so it distinguishes the two rather than passing vacuously.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.3
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.3/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.2] — 2026-07-28

**Adds the CLI.** `@hono-enterprise/cli` publishes for the first time, bringing the total to **36
packages**. Every other package is version-bumped so the scope stays on one version — the CLI needs
this, because `honoe new` stamps generated projects with its OWN version as the range for `kernel`,
`runtime`, `common`, and every template plugin. A CLI at `alpha.2` alongside a framework at
`alpha.1` would scaffold projects pinning versions that do not exist.

### Added

- **`@hono-enterprise/cli`** — the `honoe` command: project scaffolding (`honoe new`, with
  `--template rest|microservice` and `--runtime deno|node|bun|cloudflare-workers`), 13 plugin-aware
  code-generation schematics, custom schematics, and dispatch of plugin-registered commands
  (`honoe commands`, `honoe db:migrate`).

### Fixed

- **Package READMEs linked `PUBLIC_API.md` relatively** (`../../PUBLIC_API.md`). JSR resolves a
  README's relative links against `jsr.io/@hono-enterprise/`, so every such link 400'd with
  _"package name must contain only lowercase ascii alphanumeric characters and hyphens"_. All 44
  relative links across 28 package READMEs now use absolute GitHub URLs.
- **`ICliApi`'s JSDoc** described a contract with no consumer; the CLI now reads it.

All 36 packages are live on JSR at `0.1.0-alpha.2`.

Verified after publishing by installing `honoe` from JSR into a clean directory — not the workspace,
whose import map resolves locally — scaffolding a `rest` project with it, generating a controller,
type-checking the result against the published packages, then starting it and serving `/` (`200`),
`/health` (`status: up`), and `/metrics`.

### The release pipeline, which had never worked

This was the first release published by CI. `0.1.0-alpha.1` went out by hand from a terminal,
because the tag-triggered workflow failed on every attempt. Three separate causes, each only visible
by running it:

1. **The publish step lacked `--allow-env`.** `publish-packages.ts` reads `JSR_TOKEN` at startup
   (left unset in CI so the runner's OIDC identity authenticates instead) and died before touching a
   package. The root cause was duplication: `deno.json`'s `release:publish` task always carried the
   right permissions, but the workflow inlined its own `deno run` and that copy drifted. The
   workflow now calls the task.
2. **It also lacked `--allow-net`.** The already-published check that makes a resumed release
   idempotent fetches jsr.io — and it is skipped under `--dry-run`, so a passing dry run proves
   nothing about a real run.
3. **No package was linked to the GitHub repository.** JSR accepts a GitHub Actions OIDC identity
   only for a package it knows belongs to the repo; without the link, `deno publish` uploads and
   then fails with `actorNotAuthorized`. Token-based publishing does not need the link, which is why
   `0.1.0-alpha.1` never surfaced it. `deno task release:link-repos` now does all 36 through the
   API.

None of the three published anything, so the tag stayed re-runnable throughout.

### Installing

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.2
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.2/main
```

Within 24 hours of a release, Deno's minimum-dependency-age policy refuses the version unless you
pass `--min-dep-age 0`.

## [0.1.0-alpha.1] — 2026-07-26

**First public prerelease.** The framework's kernel, runtime layer, and 30 plugins are implemented
and tested; they publish to [JSR](https://jsr.io) under the `@hono-enterprise` scope.

This is an **alpha**. The public API is not frozen, and breaking changes may land in any subsequent
prerelease without a major-version bump. Do not use it in production.

All 35 packages are live on JSR at `0.1.0-alpha.1`.

Verified after publishing by installing `kernel`, `runtime`, `metrics-plugin`, and
`telemetry-plugin` from JSR into a clean project — not the workspace, whose import map resolves
locally — starting an application, serving a request (`200`), and scraping the `/metrics` endpoint.

The release took two attempts. A JSR scope may create only 20 new packages per rolling 7-day window
by default; the first run created 20 and stopped. JSR raised the quota to 40 on request, and the
remaining 15 followed. Both halves carry the same version, and the publish order guarantees `common`
and `kernel` land before anything that depends on them, so the intermediate state was never
inconsistent.

### Installing a prerelease

JSR does not tag a prerelease as `latest`, so **every specifier must be version-pinned**:

```bash
deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.1
```

A bare `deno add jsr:@hono-enterprise/kernel` fails with _"has only pre-release versions
available"_. Within 24 hours of a release, Deno's minimum-dependency-age policy additionally refuses
the version unless you pass `--min-dep-age 0`.

### All packages in this release

35 packages, all at `0.1.0-alpha.1`:

**Core** — `common`, `kernel`, `runtime`, `exceptions`, `testing`

**Request path** — `logger-plugin`, `config-plugin`, `validation-plugin`, `http-security-plugin`,
`auth-plugin`

**Data** — `database-plugin`, `cache-plugin`, `storage-plugin`, `multi-tenancy-plugin`

**Messaging & work** — `events-plugin`, `cqrs-plugin`, `messaging-plugin`, `queue-plugin`,
`scheduler-plugin`, `worker-pool-plugin`

**Real-time** — `sse-plugin`, `websocket-plugin`, `react-router-plugin`

**Operations** — `metrics-plugin`, `health-plugin`, `telemetry-plugin`, `audit-plugin`,
`resilience-plugin`, `secrets-plugin`

**Delivery** — `mail-plugin`, `notification-plugin`, `feature-flags-plugin`

**Optional ergonomics** — `di-plugin`, `decorator-plugin`, `openapi-plugin`

### Deliberately excluded

`@hono-enterprise/cli`, `@hono-enterprise/sdk`, and the three starter bundles (`rest-starter`,
`microservice-starter`, `full-stack-starter`) are **not part of this release**. They are stubs that
export nothing; publishing them would put empty pages on JSR, where versions are immutable. They
ship when their milestones land (the CLI is Milestone 34).

### Runtime support

Node.js, Deno, Bun, and Cloudflare Workers, via Hono's `fetch` entry point and the runtime's HTTP
adapters. Individual plugins document their own constraints — SMTP needs raw sockets, worker pools
need real threads, and neither exists on Workers.

Optional heavy dependencies (Prisma, ioredis, amqplib, kafkajs, nodemailer, the OTel SDK, `ws`, …)
are never hard dependencies. Each is injected through plugin options or imported lazily via an
`npm:` specifier, so an application only pays for what it configures.

### Known limitations

> Five entries in this list have since been closed; each is annotated in place rather than deleted,
> because this section records what was true of **this** release. See **[0.1.0-alpha.3]** for the
> work that closed them.

- **`notification-plugin` FCM push is non-functional.** It implements the legacy FCM `serverKey`
  API, which Google decommissioned in 2024. FCM HTTP v1 with service-account JWT signing is a
  follow-up. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where the provider moves to HTTP v1 and push delivery works.)_
- **LaunchDarkly is unsupported** in `feature-flags-plugin`. The LaunchDarkly Node server SDK's
  `variation`/`allFlagsState` are async and cannot satisfy the synchronous committed `isEnabled`
  contract. Use the provider's `'custom'` arm as a bridge. _(True of this release. Superseded — see
  [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds a `'launchdarkly'` provider and an optional
  `isEnabledAsync`.)_
- **`KafkaBroker` does not support request-reply.** Kafka's consumer-group and auto-commit model
  does not fit the pattern; `request()`/`respond()` throw `MessagingNotSupportedError`. _(True of
  this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), where Kafka becomes
  reply-capable; the limitation was in the shared request-reply core, not in Kafka.)_
- **Rooms and channels are in-process.** `websocket-plugin` rooms and `sse-plugin` channels are not
  shared across replicas; cross-instance fan-out is a later milestone. _(True of this release.
  Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30), which adds `realtime-backplane-plugin`.
  `Room.size` / `SseChannel.size` remain local-only.)_
- **`resilience-plugin` timeouts do not cancel.** `timeout` races the promise; the wrapped function
  keeps running. _(True of this release. Superseded — see [0.1.0-alpha.3](#010-alpha3--2026-07-30),
  where `wrap` hands the protected call an `AbortSignal` and the timeout aborts it.)_
- **Node and Bun compatibility suites have not run.** They consume the packages through JSR's npm
  compatibility layer and were therefore blocked on this publish — they are unblocked by it, and
  will run before the first stable release. Milestone 40 owns that verification, alongside
  benchmarks and the security audit.

### Milestones in this release

Milestones 0–33 and 41–46. See [ROADMAP.md](ROADMAP.md) for scope per milestone and
[PUBLIC_API.md](PUBLIC_API.md) for the full exported surface.

[0.1.0-alpha.1]: https://github.com/dkpaul91/hono-enterprise/releases/tag/v0.1.0-alpha.1
