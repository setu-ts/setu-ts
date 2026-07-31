# Milestone 50 — Service Discovery (`@hono-enterprise/service-discovery-plugin`)

> **Status:** Planning. Branch: `feat/m50-service-discovery`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework can be _found_ by an orchestrator but cannot _find_ anything: `packages/kernel`'s
`ServiceRegistry` is an in-process capability registry (same word, unrelated concern),
`health-plugin` produces readiness probes a discovery system consumes without ever registering
anywhere, and `packages/sdk` takes a fixed `baseUrl`. The only inter-service path that works today
is brokered messaging (M14/M14c/M14d), which needs no discovery by construction because callers
address a topic. Direct service-to-service HTTP — the path M49's gRPC plugin is about to open on the
server side — has no way to turn a logical service name into an address. This milestone adds that: a
`ServiceDiscoveryPlugin` registering an `IServiceDiscovery` under a new
`CAPABILITIES.SERVICE_DISCOVERY = 'service-discovery'` token, backed by a pluggable
`DiscoveryProvider` port with three built-in providers plus a `'custom'` arm, a read-through TTL
cache, and three load-balancing strategies.

Every built-in provider talks over web-standard `fetch` behind one injectable seam, so the package
has **zero npm dependencies** and every provider except the Kubernetes service-account-token file
read is Workers-portable. That is a deliberate boundary, not an omission: DNS-SRV discovery is the
one mechanism that cannot be expressed over `fetch`, and it is deferred with its cost named in §9.

- **In scope:** the `IServiceDiscovery` contract + `SERVICE_DISCOVERY` token in `common` (a flagged
  `common` widening); `ServiceDiscoveryPlugin`; the `DiscoveryProvider` port; `StaticProvider`,
  `ConsulProvider`, `KubernetesProvider`, and a `'custom'` arm; Consul self-registration and
  deregistration driven from the kernel lifecycle; a monotonic-clock read-through cache with
  per-service in-flight coalescing and stale-on-failure; `round-robin` / `random` /
  `weighted-random` balancing; a `service-discovery` health indicator; the doc deliverables in §2.
- **NOT this milestone:** DNS-SRV discovery (M50b — see §9); per-instance failure ejection and
  `watch()` change streams (M50c — see §9); wiring discovery into `packages/sdk` or M49's gRPC
  client (M49 owns the gRPC client story, M35 owns the SDK; §9); Docker/Kubernetes manifests that
  would exercise this in a cluster (M39); the ARCHITECTURE package-diagram backlog (M38 — see C1).

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                       | `packages/common/src/tokens.ts:38-127`                                                       | 42 tokens, ending at `METADATA_STORE: 'metadata-store'`. There is **no** discovery token — `SERVICE_DISCOVERY` is new surface, not a token committed in M1 waiting for a reader.                                                                                                              |
| `createCapabilityToken` grammar      | `packages/common/src/tokens.ts:52-64`                                                        | `TOKEN_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'`, segments dot-joined. `'service-discovery'` matches. Colons are illegal (the M10 `database:primary` trap).                                                                                                                                  |
| `IServiceRegistry`                   | `packages/common/src/registry.ts:66-118`                                                     | `register<T extends object>(token, service, options?)`, `registerFactory`, `get<T>`, `getAll<T>`, `has`, `unregister`. The plugin uses `register` + `get`; no `multi` registration is needed (one discovery provider per app).                                                                |
| `IPluginContext`                     | `packages/common/src/plugin.ts:430-468`                                                      | `services`, `middleware`, `router`, `environment`, `health`, `metrics`, `openapi`, `decorators`, `cli`, `lifecycle`, `runtime`, optional `config`/`logger`/`metadata`/`container`, `options`, `app`. `runtime` is non-optional, so `randomBytes`/`hrtime`/`env` are always available.         |
| `ILifecycleApi`                      | `packages/common/src/plugin.ts:301-350`                                                      | `onRegister`, `onInit`, `onBootstrap`, `onRequest`, `onResponse`, `onError`, `onShutdown`, `onClose`. There is **no post-`listen` and no pre-drain hook** — the constraint that drives §3.6 and §3.7.                                                                                         |
| Kernel start order                   | `packages/kernel/src/application/application.ts:293-335`                                     | `register()` (awaited) → env validation → `onInit` → pipeline compile → **`onBootstrap` (step 7)** → `setHandler` (8) → **`listen` (9)**. Bootstrap runs BEFORE the socket binds. Also confirms `await plugin.register(ctx)`, so an async `register()` is genuinely awaited.                  |
| Kernel stop order                    | `packages/kernel/src/application/application.ts:357-379`                                     | `#stopping = true` → `#drainRequests()` → `adapter.close()` → **`onShutdown`** → `onClose`. Deregistration therefore lands after the socket is already closed (§3.7).                                                                                                                         |
| `IHealthApi.register`                | `packages/common/src/plugin.ts:185-192`                                                      | `register(name: string, indicator: HealthIndicatorFn): void`.                                                                                                                                                                                                                                 |
| `HealthCheckResult` / `HealthStatus` | `packages/common/src/services/health.ts:13-18`, `types.ts:62`                                | `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`; `HealthStatus = 'up' \| 'down' \| 'degraded'`.                                                                                                                                                                          |
| `IRuntimeServices`                   | `packages/common/src/runtime.ts:178-278`                                                     | `platform`, `version`, `hostname()`, `uuid()`, `randomBytes(n)`, `subtle`, `now()`, `hrtime()`, `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`, `env`, `exit`, optional `fs?: IFileSystem`, optional `workers?`. **No DNS service and no injected `fetch`.**                       |
| `IFileSystem`                        | `packages/common/src/runtime.ts:50-104`                                                      | `readFile(path): Promise<Uint8Array>`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`. `readFile` is the Kubernetes service-account-token read in §3.5; it is `Uint8Array`, so the token needs `TextDecoder`.                                                                                  |
| `assertUniqueNames` / provider index | `packages/kernel/src/registry/plugin-resolver.ts:107-140`                                    | Duplicate plugin `name` throws; a capability listed in two plugins' `provides` throws. One `ServiceDiscoveryPlugin` per app, claiming the bare `service-discovery` token — no multi-instance naming scheme is needed.                                                                         |
| `IResilienceService`                 | `packages/common/src/services/resilience.ts:37,51` + `wrap`                                  | `wrap<T>(fn: ResilientCall<T>, options?): HardenedCall<T>` where `ResilientCall<T> = (signal: AbortSignal) => Promise<T>`. This is the composition recipe in §3.8 — retry re-enters the caller's `fn`, so a re-`pick()` inside `fn` advances the round-robin cursor.                          |
| `INotificationHttp` default seam     | `packages/notification-plugin/src/http/default-http.ts:16-34`                                | `createDefaultNotificationHttp(fetchImpl: typeof fetch = fetch)` returning `{ post(url, body, headers) }`. The precedent `IDiscoveryHttp` copies (§3.3) — a zero-dep, Workers-portable, injectable `fetch` wrapper.                                                                           |
| Per-package test permissions         | `packages/websocket-plugin/deno.json:6-10`                                                   | `"test": { "permissions": { "net": true } }` — how M46 ran a real-socket e2e even though the root `test` task grants no `--allow-net`. The M50 e2e (§6) uses the same mechanism.                                                                                                              |
| Root `test` task permissions         | `deno.json:49`                                                                               | `deno test -P --allow-read --allow-import --allow-env --allow-sys=hostname packages` — no `--allow-net`, confirming the per-package grant above is required, not optional.                                                                                                                    |
| Workspace + release lists            | `deno.json:3-44`, `scripts/release-packages.ts:33-64,86`                                     | 42 workspace members; 42 entries in `PUBLISHED_PACKAGES` (Tier 4 is the alphabetized plugin list); `UNPUBLISHED_PACKAGES` is empty. M50 makes both 43.                                                                                                                                        |
| Consul health read                   | `developer.hashicorp.com/consul/api-docs/health` (fetched)                                   | `GET /v1/health/service/:service`; `?passing=true` returns only nodes with all checks passing. Response entries carry `Node.Address`, `Service.ID`, `Service.Service`, `Service.Address`, `Service.Port`, `Service.Tags`, `Service.Meta`, `Service.Weights`.                                  |
| Consul agent register/deregister     | `developer.hashicorp.com/consul/api-docs/agent/service` (fetched)                            | `PUT /v1/agent/service/register` with body fields `ID`, `Name`, `Address`, `Port`, `Tags`, `Meta`, `Check`; HTTP check fields `Interval` and `DeregisterCriticalServiceAfter`. `PUT /v1/agent/service/deregister/:service_id`.                                                                |
| Consul auth header + prefix          | `developer.hashicorp.com/consul/api-docs/api-structure` (fetched)                            | All endpoints are prefixed `/v1/`; the ACL token header is `X-Consul-Token`.                                                                                                                                                                                                                  |
| Kubernetes EndpointSlice             | `kubernetes.io/docs/reference/kubernetes-api/service-resources/endpoint-slice-v1/` (fetched) | `discovery.k8s.io/v1`; `GET /apis/discovery.k8s.io/v1/namespaces/{namespace}/endpointslices`; fields `endpoints[]`, `endpoints[].addresses[]`, `endpoints[].conditions.ready` (**nil means true**), `ports[]` with `port`/`name`/`protocol`. Association label: `kubernetes.io/service-name`. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                   | Doc deliverable (same PR)                                                                                                                                                                                                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:960-1077` "Package Overview" graphs 32 nodes; the workspace has 42 members (`deno.json:3-44`). Missing: `exceptions`, `sse-plugin`, `websocket-plugin`, `worker-pool-plugin`, `realtime-backplane-plugin`, `react-router-plugin`, `session-plugin`, and the three starters.                                                       | This PR adds only the `service-discovery-plugin` node and its `common -->` edge. The 10-member backlog is **named, not absorbed** — it is doc debt from seven prior milestones and belongs to the documentation milestone, which owns a full pass rather than an incremental patch.                                                                                                        | `ARCHITECTURE.md`: add `service-discovery[service-discovery-plugin]` to the Infrastructure Plugins subgraph plus `common --> service-discovery`. `ROADMAP.md` M38: add "reconcile the §8 Package Overview diagram with the workspace member list (10 members missing as of M50)" to its deliverables. |
| C2 | `README.md` states four mutually inconsistent counts: line 22 "all 38 packages are live", line 24 "31 plugins", line 212 "All 36 packages are published", line 314 "41 workspace members — 38 published, 3 stubs", line 320 "30 capability plugins". Ground truth today is 42 members, 42 in `PUBLISHED_PACKAGES`, 32 `*-plugin` dirs, zero stubs. | Correct all five to the post-M50 truth in one edit, and drop the "3 stubs" clause (M36 made the starters real published libraries; `UNPUBLISHED_PACKAGES` is empty at `scripts/release-packages.ts:86`). Line 22's "38 live on JSR" is a statement about the shipped `alpha.3` release and stays accurate — it is re-worded to say so explicitly rather than reading as a workspace count. | `README.md`: 43 workspace members, 33 capability plugins, `PUBLISHED_PACKAGES` at 43, the alpha.3 sentence scoped to "published in `v0.1.0-alpha.3`", and a `service-discovery-plugin` row in the plugin table.                                                                                       |
| C3 | `PUBLIC_API.md:8-49` TOC has no discovery entry and `ARCHITECTURE.md` never mentions service discovery, while `ROADMAP.md` M39 puts Kubernetes `Services` in scope — implying discovery is the platform's job, which is true for k8s DNS and false for Consul and for the `pick()`/weighting behavior this milestone owns.                         | Discovery is a framework capability with a platform-delegating default (`StaticProvider` reading whatever the platform injected as env), not a platform-only concern. M39 keeps owning the manifests; M50 owns the in-process resolution and balancing.                                                                                                                                    | `PUBLIC_API.md`: new "Service Discovery" section + TOC entry, and `IServiceDiscovery`/`ServiceInstance`/`PickOptions`/`LoadBalanceStrategy`/`SERVICE_DISCOVERY` rows in the `@hono-enterprise/common` API reference. `ROADMAP.md` M39: one sentence noting M50 owns app-side resolution.              |

## 3. Design decisions

### 3.1 The port: `IServiceDiscovery` is read-only, and lives in `common`

- **Decision:** `common` gains `packages/common/src/services/service-discovery.ts` exporting
  `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, and `IServiceDiscovery` with exactly
  three methods: `resolve(serviceName): Promise<readonly ServiceInstance[]>`,
  `pick(serviceName, options?): Promise<ServiceInstance | null>`, and
  `resolveUrl(serviceName, path?, options?): Promise<string | null>`. Registration and
  deregistration of _this_ instance are **not** on the contract; they are plugin-internal lifecycle
  behavior (§3.6, §3.7). `CAPABILITIES.SERVICE_DISCOVERY = 'service-discovery'` is added alongside.
- **Why:** the contract's consumers are callers that need an address. A `register()`/`deregister()`
  pair on the port would be surface no application code path reads — the plugin drives its own
  lifecycle hooks — which is the dead-surface defect this repo has shipped before. Keeping it in
  `common` (not the plugin) is required because a consumer resolving
  `CAPABILITIES.SERVICE_DISCOVERY` must type it as the token's documented interface without
  importing the plugin (AI_GUIDELINES §2.2).
- **Test home:** `test/integration/plugin-registration.test.ts` resolves the token and calls all
  three methods through the `IServiceDiscovery` type.

### 3.2 `pick` and `resolveUrl` funnel through one implementation

- **Decision:** `ServiceDiscoveryService.resolveUrl` calls its own `pick()` and formats the result
  via the internal `instanceUrl()`; it does not re-resolve, re-balance, or apply its own defaults.
  `pick(name, { strategy })` overrides the plugin-configured strategy for that call only.
- **Why:** two entry points to one behavior is exactly the split that shipped green before (a
  `validateBody(...)` helper ignoring the plugin's configured `errorFormat`). One implementation,
  one configuration read.
- **Test home:** `test/unit/service-discovery-service.test.ts` — a test configures the plugin with
  the non-default `strategy: 'weighted-random'` and a stubbed `randomBytes`, then asserts `pick()`
  and `resolveUrl()` select the **same** instance; a second test passes `{ strategy: 'random' }` per
  call and asserts both entry points honor the override identically.

### 3.3 Transport: one injectable `fetch` seam, zero npm dependencies

- **Decision:** `IDiscoveryHttp` exposes `request(url, init): Promise<DiscoveryHttpResponse>` where
  `DiscoveryHttpResponse = { ok, status, text }`, and
  `createDefaultDiscoveryHttp(fetchImpl = fetch)` is the default. `ConsulProvider` and
  `KubernetesProvider` take an `IDiscoveryHttp` through their constructor; the `http` plugin option
  overrides the default.
- **Why:** the M30 `INotificationHttp` precedent, verified at
  `packages/notification-plugin/src/http/default-http.ts:16-34`. Consul and the Kubernetes API
  server are both plain HTTP JSON — there is no client library worth a `npm:` import, so the §12.2
  inject-or-lazy pattern collapses to "inject only", and the package ships with an empty dependency
  graph. A single `request` method (rather than M30's `post`) is needed because discovery reads are
  `GET` and Consul registration is `PUT`.
- **Test home:** `test/unit/default-http.test.ts` drives `createDefaultDiscoveryHttp` with a stub
  `fetchImpl` asserting method/headers/body pass-through; `test/e2e/service-discovery-e2e.test.ts`
  drives the **default** seam over real global `fetch` against a real loopback server (§6).

### 3.4 Cache: read-through TTL on the monotonic clock, coalesced, stale-on-failure

- **Decision:** `ServiceDiscoveryService` holds `Map<string, { instances, stampMs }>` and
  `Map<string, Promise<readonly ServiceInstance[]>>` for in-flight reads. A `resolve()` returns the
  cached entry when `runtime.hrtime() - stampMs < cacheTtlMs`; otherwise it starts (or joins) one
  in-flight provider call per service name. `cacheTtlMs` defaults to `30_000`; `0` disables caching
  entirely. On a provider failure with a stale entry present, the stale entry is returned and an
  internal `#degraded` flag is set; with no entry present, a `DiscoveryUnavailableError` is thrown
  with the provider error as `cause`. There is **no background refresh timer.**
- **Why:** `pick()` sits on a request path and cannot afford a Consul round trip per call. The
  monotonic clock is mandatory here — mixing `Date.now()` with `hrtime()` is a documented repo
  defect class. Coalescing is the M47 LaunchDarkly-provider precedent: without it a burst of
  concurrent `pick()`s for one cold service issues N identical Consul reads. No timer means no timer
  handle to leak and no `onClose` cleanup obligation; stale-on-failure is the M31 `DatabaseProvider`
  precedent (keep the last good snapshot and report it).
- **Test home:** `test/unit/service-discovery-service.test.ts` — a fake provider counting calls
  proves (a) a second `resolve()` inside the TTL does not call the provider, (b) `cacheTtlMs: 0`
  calls it every time, (c) ten concurrent `resolve()`s of a cold name produce exactly one provider
  call, (d) a provider that rejects after a successful read returns the stale list and flips the
  health indicator to `'degraded'`, (e) a provider that rejects with nothing cached throws
  `DiscoveryUnavailableError` carrying the original as `cause`.

### 3.5 Kubernetes credentials: explicit token, or a memoized service-account file read

- **Decision:** `KubernetesProvider` resolves its bearer token per API request from one of two
  sources, in order: the `token` option when present (used verbatim, no file access), otherwise
  `runtime.fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token')` decoded as UTF-8 and
  memoized for 60 s against `runtime.hrtime()`. With no `token` option **and** no `runtime.fs`, the
  plugin throws during `register()` naming both remedies. The API server base URL defaults to
  `https://${runtime.env.KUBERNETES_SERVICE_HOST}:${runtime.env.KUBERNETES_SERVICE_PORT}` and the
  `apiServer` option overrides it; a missing host env with no `apiServer` throws during
  `register()`.
- **Why:** Kubernetes rotates projected service-account tokens roughly hourly, so a token read once
  at registration stops working while the pod is still healthy — a failure that appears hours after
  a green deploy. Re-reading per request with a 60 s memo bounds the file I/O (at most one read per
  minute) and is the M30b FCM token-cache pattern. Failing at `register()` rather than at first
  `resolve()` is the M30 `email`-without-`mail` precedent: a misconfiguration is a startup error.
- **Test home:** `test/unit/kubernetes-provider.test.ts` — an injected fake `IFileSystem` proves the
  file path, the UTF-8 decode, exactly one read across two calls inside the memo window, a second
  read after the fake clock advances past 60 s, and the `Authorization: Bearer <token>` header; two
  further tests assert the two `register()`-time throws.
  `test/integration/plugin-registration.test.ts` covers the throw through a real kernel app.

### 3.6 Self-registration runs in `onBootstrap`, and the health check is what makes that safe

- **Decision:** when `selfRegistration` is configured, the plugin registers a
  `ctx.lifecycle.onBootstrap` hook that calls `provider.registerSelf(...)`. `SelfRegistration.check`
  is **not optional**: it defaults to
  `{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }` and cannot be disabled.
  `ConsulProvider.resolve` always sends `?passing=true`.
- **Why:** verified at `packages/kernel/src/application/application.ts:293-335`, `onBootstrap`
  (step 7) runs **before** `listen()` (step 9), and `ILifecycleApi` has no post-listen hook
  (`packages/common/src/plugin.ts:301-350`). Registering at bootstrap therefore advertises the
  instance before its socket is bound. That window is harmless **only** because Consul marks a newly
  registered service critical until its first check passes and every consumer filters on
  `passing=true` — so the mandatory check is load-bearing, not a convenience default. Making the
  check disable-able would reintroduce the race silently. The alternative — widening `ILifecycleApi`
  with an `onListen` hook — is a `common` + kernel change with blast radius across every plugin,
  rejected for a problem the health check already solves.
- **Test home:** `test/unit/consul-provider.test.ts` asserts the registration body carries the
  default `Check` object and that `resolve()` always sends `passing=true`;
  `test/integration/self-registration.test.ts` starts a real kernel app with a fake `IDiscoveryHttp`
  and asserts the `PUT /v1/agent/service/register` fired during `start()`.

### 3.7 Deregistration runs in `onShutdown`, and the residual window is documented

- **Decision:** deregistration is a `ctx.lifecycle.onShutdown` hook calling
  `provider.deregisterSelf(...)`. Failures are logged through `ctx.logger` (when present) and
  swallowed, never rethrown. There is no `onClose` hook — the cache holds no timers and no sockets.
- **Why:** verified at `packages/kernel/src/application/application.ts:357-379`, `stop()` drains
  in-flight requests and closes the server socket **before** `onShutdown` runs, and there is no
  pre-drain hook to use instead. So between "socket closed" and "deregister lands" Consul still
  lists the instance, and callers see connection failures bounded by the check interval and by
  `DeregisterCriticalServiceAfter`. Rethrowing from a shutdown hook would turn a best-effort cleanup
  into a failed `stop()`. This is stated in the README rather than hidden, and the pre-drain hook is
  named as the fix in §9.
- **Test home:** `test/integration/self-registration.test.ts` asserts
  `PUT /v1/agent/service/deregister/<id>` fires during `app.stop()`, and a second case asserts a
  rejecting deregistration still lets `stop()` resolve.

### 3.8 No ejection, no `report()` — failover is composed with `resilience-plugin`

- **Decision:** `IServiceDiscovery` has no outcome-feedback method and the service does no
  per-instance failure tracking. A dead instance stops being returned when the provider's own health
  signal says so (Consul `passing=true`, Kubernetes `conditions.ready`); `StaticProvider` has no
  health signal and is documented as such. The README ships the composition recipe: wrap the call in
  `IResilienceService.wrap` and re-`pick()` **inside** the wrapped function.
- **Why:** `wrap<T>(fn: ResilientCall<T>, …)` re-enters `fn` on each retry attempt
  (`packages/common/src/services/resilience.ts:37`), so a `pick()` inside `fn` advances the
  round-robin cursor and the retry lands on a different instance — real failover with zero new
  surface. Building a second circuit breaker inside this plugin would duplicate M27's, and a plugin
  may not import another plugin to reuse it (AI_GUIDELINES §3.3).
- **Test home:** `test/unit/load-balancer.test.ts` asserts consecutive `pick()`s advance the cursor
  across the instance list (the property the recipe depends on). The recipe itself is a README
  example, not a test — it composes two plugins and belongs to neither package's suite.

### 3.9 Load balancing: three literal strategies, randomness from `runtime.randomBytes`

- **Decision:** `LoadBalanceStrategy = 'round-robin' | 'random' | 'weighted-random'`, defaulting to
  `'round-robin'`. No function form is accepted. `round-robin` keeps a `Map<string, number>` cursor
  taken modulo the current instance count. `random` and `weighted-random` derive a float from
  `runtime.randomBytes(4)` read as a big-endian uint32 divided by `2 ** 32`; `weighted-random` uses
  `instance.weight ?? 1` and treats a non-positive weight as `0` (never selected unless every weight
  is non-positive, in which case it falls back to uniform selection over the list).
- **Why:** `Math.random()` and `Date.now()` are the two clock/randomness smells the gates do not
  catch; `runtime.randomBytes` is on the mandatory `IRuntimeServices`
  (`packages/common/src/runtime.ts:210`), so tests fake it through the runtime they already build
  and every selection becomes deterministic without a new seam. Rejecting a function form keeps
  `strategy` from becoming surface whose only reader is its own test — a custom selection policy is
  reachable today by writing a `DiscoveryProvider` that returns a one-element list.
- **Test home:** `test/unit/load-balancer.test.ts` — cursor wrap-around, cursor behavior when the
  instance count shrinks between picks, uniform selection at both ends of the `randomBytes` range,
  weighted selection landing in each bucket, the all-non-positive-weight fallback, and `null` for an
  empty list.

### 3.10 Instance-to-URL formatting is one shared pure function

- **Decision:** `instanceUrl(instance, path?)` (internal, `src/url/instance-url.ts`) produces
  `${instance.secure ? 'https' : 'http'}://${host}:${port}${joinedPath}`, bracketing `host` as
  `[host]` when it contains a `:` (an IPv6 literal), and joining `path` with exactly one `/`
  regardless of whether the caller's `path` is prefixed. It is the single formatter — `resolveUrl`
  is its only caller.
- **Why:** Kubernetes `endpoints[].addresses[]` are canonical IP strings that are IPv6 in a
  dual-stack or IPv6-only cluster, and an unbracketed IPv6 host produces a URL that `fetch` rejects.
  Slash-joining bugs are the classic duplicated-logic defect; one function, one test file.
- **Test home:** `test/unit/instance-url.test.ts` asserts IPv4, IPv6-bracketed, `secure` on/off, no
  path, `/`-prefixed path, and un-prefixed path — with expected strings written literally.

### 3.11 Provider selection is a discriminated union with per-arm construction

- **Decision:** `ServiceDiscoveryPluginOptions` is a union discriminated on `provider`:
  `'static' | 'consul' | 'kubernetes' | 'custom'`. `createProvider` is overloaded per arm so a
  missing per-arm credential is a **compile** error, not a startup throw. `StaticProvider` and
  `KubernetesProvider` do not implement `registerSelf`/`deregisterSelf`; configuring
  `selfRegistration` alongside them throws `SelfRegistrationNotSupportedError` during `register()`.
- **Why:** the M30 `ChannelConfig` precedent — pushing credential requirements into the type system
  beats a runtime throw. Static is a literal list with nothing to register against, and in
  Kubernetes the control plane owns Endpoint membership, so honoring `selfRegistration` there would
  be a silent no-op; a startup throw names the mistake.
- **Test home:** `test/unit/provider-factory.test.ts` builds each arm and asserts the concrete
  class; `test/integration/plugin-registration.test.ts` asserts the
  `SelfRegistrationNotSupportedError` for the `'static'` and `'kubernetes'` arms through a real
  kernel app.

### 3.12 Consul and Kubernetes response mapping — the two field traps

- **Decision:** `ConsulProvider.resolve` maps each entry to
  `{ id: Service.ID, serviceName: Service.Service, host: Service.Address || Node.Address, port: Service.Port, secure: options.secure ?? false, weight: Service.Weights?.Passing, tags: Service.Tags, metadata: Service.Meta }`
  — the `Service.Address`-empty-string fallback to `Node.Address` is mandatory, not defensive.
  `KubernetesProvider.resolve` reads every EndpointSlice matching
  `labelSelector=kubernetes.io/service-name=<name>`, and for each `endpoints[]` entry treats
  `conditions.ready === undefined` as **ready** and `conditions.ready === false` as not ready,
  emitting one `ServiceInstance` per address in `addresses[]`, with the port taken from the
  `ports[]` entry whose `name` matches the `portName` option (defaulting to the single entry when
  `portName` is unset and exactly one port exists; throwing a `DiscoveryUnavailableError` naming the
  available port names when `portName` is unset and several exist).
- **Why:** both are verified upstream facts, not inference. Consul returns `Service.Address` as an
  empty string for a service registered without an explicit address — the node address is the real
  one, and omitting the fallback yields `http://:8080`. The Kubernetes reference states
  `conditions.ready` nil means true, so treating `undefined` as not-ready would silently discard
  every endpoint in a slice that omits the field. The multi-port throw prevents picking an arbitrary
  port.
- **Test home:** `test/unit/consul-provider.test.ts` (empty `Service.Address` falls back to
  `Node.Address`; a populated one wins) and `test/unit/kubernetes-provider.test.ts`
  (`ready: undefined` included, `ready: false` excluded, one instance per address, named-port match,
  single-port default, multi-port throw).

### 3.13 Health indicator

- **Decision:** `ctx.health.register('service-discovery', …)` reports
  `{ status, data: { provider, cachedServices, degraded } }` where `status` is `'degraded'` when the
  service is serving a stale snapshot after a failed refresh (§3.4) and `'up'` otherwise. It never
  reports `'down'` and never issues a provider call of its own.
- **Why:** a health indicator that probes on every scrape turns a liveness check into load against
  Consul. Reporting the cache's own observed state is free and is what an operator needs. `'down'`
  is unreachable by construction: with nothing cached and a failing provider, no `resolve()` has
  succeeded and the caller already received a `DiscoveryUnavailableError`.
- **Test home:** `test/integration/plugin-registration.test.ts` asserts `'up'` after a successful
  resolve and `'degraded'` after a provider failure with a warm cache.

## 4. Exported surface — every symbol names its consumer

New in `@hono-enterprise/common` (flagged widening):

| Exported symbol                  | Kind      | Consumer / real code path that READS it                                                                                                         |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `IServiceDiscovery`              | interface | Implemented by the plugin's internal `ServiceDiscoveryService`; the type every consumer resolves the token as (integration + e2e tests, README) |
| `ServiceInstance`                | interface | Returned by all three providers and by `resolve`/`pick`; read by `instanceUrl` and by the balancer's `weight`                                   |
| `PickOptions`                    | interface | Second argument of `pick`/third of `resolveUrl`; its `strategy` is read by `ServiceDiscoveryService.pick` (§3.2)                                |
| `LoadBalanceStrategy`            | type      | Field of `PickOptions` and of `ServiceDiscoveryPluginOptions`; switched on by `createLoadBalancer`                                              |
| `CAPABILITIES.SERVICE_DISCOVERY` | token     | Registered by the plugin, resolved by consumers; asserted in the integration test                                                               |

New in `@hono-enterprise/service-discovery-plugin` (`src/index.ts`):

| Exported symbol                     | Kind      | Consumer / real code path that READS it                                                                                                     |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceDiscoveryPlugin`            | function  | The application's `plugins: [...]` array; integration, self-registration, and e2e tests                                                     |
| `ServiceDiscoveryPluginOptions`     | type      | The union the app's option literal is checked against; narrowed by `createProvider`                                                         |
| `StaticDiscoveryOptions`            | interface | The `'static'` arm; read by `createProvider` and `StaticProvider`'s constructor                                                             |
| `ConsulDiscoveryOptions`            | interface | The `'consul'` arm; read by `createProvider` and `ConsulProvider`'s constructor                                                             |
| `KubernetesDiscoveryOptions`        | interface | The `'kubernetes'` arm; read by `createProvider` and `KubernetesProvider`'s constructor                                                     |
| `CustomDiscoveryOptions`            | interface | The `'custom'` arm; its `provider` field is returned directly by `createProvider`                                                           |
| `StaticServiceDefinition`           | interface | Element type of `StaticDiscoveryOptions.services[name]`; read by `StaticProvider` when synthesizing `id`                                    |
| `SelfRegistration`                  | interface | Read by the `onBootstrap`/`onShutdown` hooks and by `ConsulProvider.registerSelf` when building the `PUT` body                              |
| `SelfRegistrationCheck`             | interface | Field of `SelfRegistration`; read by `ConsulProvider.registerSelf` to build the `Check` object (§3.6)                                       |
| `DiscoveryProvider`                 | interface | Implemented by all three built-in providers; the `'custom'` arm's contract; the service's only dependency                                   |
| `StaticProvider`                    | class     | Constructed by `createProvider`'s `'static'` overload; asserted in `provider-factory.test.ts`                                               |
| `ConsulProvider`                    | class     | Constructed by `createProvider`'s `'consul'` overload; drives the e2e loopback round trip                                                   |
| `KubernetesProvider`                | class     | Constructed by `createProvider`'s `'kubernetes'` overload                                                                                   |
| `IDiscoveryHttp`                    | interface | Constructor parameter of `ConsulProvider`/`KubernetesProvider`; the `http` option's type                                                    |
| `DiscoveryHttpResponse`             | interface | Return type of `IDiscoveryHttp.request`; destructured by both HTTP providers                                                                |
| `createDefaultDiscoveryHttp`        | function  | The default when `http` is omitted (`createProvider`); exercised over real `fetch` in the e2e                                               |
| `DiscoveryUnavailableError`         | class     | Thrown by the service on a cold provider failure (§3.4) and by the Kubernetes multi-port branch (§3.12); caught by name in tests and README |
| `SelfRegistrationNotSupportedError` | class     | Thrown during `register()` for the `'static'`/`'kubernetes'` arms with `selfRegistration` set (§3.11)                                       |

`ServiceDiscoveryService` is deliberately **not** exported: consumers resolve the capability token
and type it as `IServiceDiscovery` (§3.1), so exporting the class would publish an implementation
detail in violation of AI_GUIDELINES §1.6.

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                             | Behavior (per implementation)                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`                        | `createProvider`                                     | Discriminant; selects the arm. No default — always explicit.                                                                                                                                                                                           |
| `cacheTtlMs`                      | `ServiceDiscoveryService.resolve`                    | Default `30_000`; `0` disables caching so every `resolve` hits the provider. Applies to all four arms.                                                                                                                                                 |
| `strategy`                        | `createLoadBalancer`, `ServiceDiscoveryService.pick` | Default `'round-robin'`. Applies to all four arms; overridable per call via `PickOptions.strategy`.                                                                                                                                                    |
| `selfRegistration`                | `onBootstrap`/`onShutdown` hooks                     | Consul: `PUT /v1/agent/service/register` at bootstrap, deregister at shutdown. Static and Kubernetes: `SelfRegistrationNotSupportedError` at `register()`. Custom: passed to the provider when it implements `registerSelf`, otherwise the same throw. |
| `selfRegistration.check`          | `ConsulProvider.registerSelf`                        | Defaults to `{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }`; not disable-able (§3.6). Becomes Consul's `Check.HTTP`/`Interval`/`DeregisterCriticalServiceAfter`.                                                            |
| `services` (static arm)           | `StaticProvider.resolve`                             | `Record<string, readonly StaticServiceDefinition[]>`. An unknown name resolves to `[]`, never a throw.                                                                                                                                                 |
| `address` (consul arm)            | `ConsulProvider`                                     | Base URL of the agent, e.g. `http://127.0.0.1:8500`. Required by the type.                                                                                                                                                                             |
| `token` (consul arm)              | `ConsulProvider`                                     | Sent as `X-Consul-Token` when present; omitted entirely otherwise (`exactOptionalPropertyTypes` — omit, never assign `undefined`).                                                                                                                     |
| `datacenter` (consul arm)         | `ConsulProvider.resolve`                             | Appended as `?dc=` alongside `passing=true` when present.                                                                                                                                                                                              |
| `secure` (consul arm)             | `ConsulProvider.resolve`                             | Default `false`; sets `ServiceInstance.secure`, which `instanceUrl` turns into the `https` scheme. Consul carries no scheme information, so this is app-supplied.                                                                                      |
| `namespace` (kubernetes arm)      | `KubernetesProvider.resolve`                         | Path segment of the EndpointSlice list URL. Required by the type.                                                                                                                                                                                      |
| `apiServer` (kubernetes arm)      | `KubernetesProvider`                                 | Overrides the `KUBERNETES_SERVICE_HOST`/`_PORT` default; absent both, `register()` throws (§3.5).                                                                                                                                                      |
| `token` (kubernetes arm)          | `KubernetesProvider`                                 | Used verbatim as the bearer token, skipping the file read entirely — the Workers-portable path (§3.5).                                                                                                                                                 |
| `portName` (kubernetes arm)       | `KubernetesProvider.resolve`                         | Selects the `ports[]` entry by `name`; unset with one port uses it, unset with several throws (§3.12).                                                                                                                                                 |
| `secure` (kubernetes arm)         | `KubernetesProvider.resolve`                         | Default `false`; sets `ServiceInstance.secure` as above.                                                                                                                                                                                               |
| `http` (consul + kubernetes arms) | `createProvider`                                     | Overrides `createDefaultDiscoveryHttp()`. The seam every provider unit test drives.                                                                                                                                                                    |
| `provider` object (custom arm)    | `createProvider`                                     | Returned as-is; the app's own `DiscoveryProvider`.                                                                                                                                                                                                     |

## 5. Implementation files

| File                                                                                       | Purpose                                                                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/service-discovery.ts`                                        | `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `IServiceDiscovery` (flagged `common` widening, §3.1)                         |
| `packages/common/src/tokens.ts`                                                            | Edit: add `SERVICE_DISCOVERY: 'service-discovery'` to `CAPABILITIES`                                                                   |
| `packages/common/src/index.ts`                                                             | Edit: re-export the four new types                                                                                                     |
| `packages/service-discovery-plugin/deno.json`                                              | Manifest at `0.1.0-alpha.3`; `exports: './src/index.ts'`; `test.permissions.net: true` for the e2e (§6)                                |
| `packages/service-discovery-plugin/README.md`                                              | Package README, incl. the resilience composition recipe (§3.8), the shutdown window (§3.7), and the k8s CA note (§8)                   |
| `src/index.ts`                                                                             | Barrel exports (§4)                                                                                                                    |
| `src/options.ts`                                                                           | The option union and its arms; `resolveOptions` applying the `cacheTtlMs`/`strategy`/`check` defaults                                  |
| `src/errors.ts`                                                                            | `DiscoveryUnavailableError`, `SelfRegistrationNotSupportedError`                                                                       |
| `src/interfaces/index.ts`                                                                  | `DiscoveryProvider`, `IDiscoveryHttp`, `DiscoveryHttpResponse`, `SelfRegistration`, `SelfRegistrationCheck`, `StaticServiceDefinition` |
| `src/http/default-http.ts`                                                                 | `createDefaultDiscoveryHttp` (§3.3)                                                                                                    |
| `src/plugin/service-discovery-plugin.ts`                                                   | `ServiceDiscoveryPlugin` — async `register()`, token registration, health indicator, bootstrap/shutdown hooks                          |
| `src/services/service-discovery-service.ts`                                                | `ServiceDiscoveryService` — cache, coalescing, stale-on-failure, `resolve`/`pick`/`resolveUrl`, degraded flag (§3.2, §3.4)             |
| `src/balancer/load-balancer.ts`                                                            | `createLoadBalancer` — the three strategies over `runtime.randomBytes` (§3.9)                                                          |
| `src/url/instance-url.ts`                                                                  | `instanceUrl` — scheme, IPv6 bracketing, path join (§3.10)                                                                             |
| `src/providers/provider-factory.ts`                                                        | `createProvider`, overloaded per arm (§3.11)                                                                                           |
| `src/providers/static-provider.ts`                                                         | `StaticProvider`                                                                                                                       |
| `src/providers/consul-provider.ts`                                                         | `ConsulProvider` — `resolve`, `registerSelf`, `deregisterSelf`, response mapping (§3.12)                                               |
| `src/providers/kubernetes-provider.ts`                                                     | `KubernetesProvider` — token resolution (§3.5), EndpointSlice mapping (§3.12)                                                          |
| `deno.json` (root)                                                                         | Edit: add the workspace member                                                                                                         |
| `scripts/release-packages.ts`                                                              | Edit: add `'packages/service-discovery-plugin'` to Tier 4 (alphabetical, after `secrets-plugin`)                                       |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, `CHANGELOG.md`, `CLAUDE.md` | The C1–C3 deliverables, the M50 ROADMAP section + Progress Tracking row 50, and the status flip                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

`src/interfaces/index.ts` is type-only (no executable statements) and is the one file with no
dedicated test; every symbol in it is type-checked by the files that implement it. There is **no
guarded real-import test** because the package has no npm dependency at all (§3.3) — the equivalent
"exercise the real path once" obligation is discharged by the e2e's real-`fetch` loopback round
trip.

| Test file                                      | src covered                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/options.test.ts`                    | `src/options.ts`                                         | `resolveOptions` applies `cacheTtlMs: 30_000` / `strategy: 'round-robin'` / the default `check`; an explicit `cacheTtlMs: 0` survives (not coerced by `??`); an explicit `check` is used verbatim.                                                                                                                                                                                                                                                                              |
| `test/unit/errors.test.ts`                     | `src/errors.ts`                                          | Both errors are `instanceof Error`, carry their `name`, and `DiscoveryUnavailableError` preserves `cause`.                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/default-http.test.ts`               | `src/http/default-http.ts`                               | `createDefaultDiscoveryHttp(stub).request(url, init)` passes method/headers/body through and maps `{ ok, status, text }`; a non-2xx response maps `ok: false` without throwing.                                                                                                                                                                                                                                                                                                 |
| `test/unit/instance-url.test.ts`               | `src/url/instance-url.ts`                                | Six literal input→output pairs (§3.10), expected strings written out in full.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/load-balancer.test.ts`              | `src/balancer/load-balancer.ts`                          | Cursor advance + wrap; cursor when the list shrinks between picks; `random` at both `randomBytes` extremes; `weighted-random` landing in each bucket; all-non-positive-weight uniform fallback; `null` on an empty list. Drives `createLoadBalancer(strategy, runtime)` with a fake `IRuntimeServices`.                                                                                                                                                                         |
| `test/unit/service-discovery-service.test.ts`  | `src/services/service-discovery-service.ts`              | The five cache cases in §3.4 (a–e); the two dual-entry-point cases in §3.2 under a non-default strategy; `pick` on an empty list returns `null` and `resolveUrl` returns `null`. Calls `pick(name, { strategy })` against `IServiceDiscovery` as declared in §3.1.                                                                                                                                                                                                              |
| `test/unit/static-provider.test.ts`            | `src/providers/static-provider.ts`                       | Known name returns the configured instances with `serviceName` stamped and `id` synthesized when omitted; a supplied `id` wins; unknown name returns `[]`; `registerSelf` is absent on the instance.                                                                                                                                                                                                                                                                            |
| `test/unit/consul-provider.test.ts`            | `src/providers/consul-provider.ts`                       | URL is `/v1/health/service/<name>?passing=true` (+`dc=` when set); `X-Consul-Token` present when configured and the header key absent when not; empty `Service.Address` falls back to `Node.Address` and a populated one wins; `Weights.Passing` maps to `weight`; a non-`ok` response rejects; `registerSelf` body carries `ID`/`Name`/`Address`/`Port`/`Tags`/`Meta`/`Check` with the default check values; `deregisterSelf` targets `PUT /v1/agent/service/deregister/<id>`. |
| `test/unit/kubernetes-provider.test.ts`        | `src/providers/kubernetes-provider.ts`                   | The token cases in §3.5 (fake `IFileSystem`, memo window, memo expiry, `Authorization` header, both `register()`-time throws); the mapping cases in §3.12 (`ready: undefined` in, `ready: false` out, one instance per address, named-port match, single-port default, multi-port throw); the `labelSelector` query is exact.                                                                                                                                                   |
| `test/unit/provider-factory.test.ts`           | `src/providers/provider-factory.ts`                      | Each of the four arms yields the expected concrete provider; the `http` option overrides the default seam; the `'custom'` arm returns the supplied object identically (`toBe`).                                                                                                                                                                                                                                                                                                 |
| `test/integration/plugin-registration.test.ts` | `src/plugin/service-discovery-plugin.ts`, `src/index.ts` | Through a real `createApplication` + `RuntimePlugin`: the token resolves and is typed `IServiceDiscovery`; `resolve`/`pick`/`resolveUrl` all work; the health indicator reports `'up'` then `'degraded'` (§3.13); `SelfRegistrationNotSupportedError` for the `'static'` and `'kubernetes'` arms (§3.11); the two Kubernetes `register()` throws (§3.5).                                                                                                                        |
| `test/integration/self-registration.test.ts`   | `src/plugin/service-discovery-plugin.ts`                 | With a fake `IDiscoveryHttp`: `PUT /v1/agent/service/register` fires during `start()` and carries the default `Check`; `PUT /v1/agent/service/deregister/<id>` fires during `stop()`; a rejecting deregistration still lets `stop()` resolve (§3.7).                                                                                                                                                                                                                            |
| `test/e2e/service-discovery-e2e.test.ts`       | end-to-end, real `fetch`                                 | A real kernel app listens on an ephemeral loopback port and serves `/v1/health/service/billing` as a Consul agent would; a second app registers `ServiceDiscoveryPlugin({ provider: 'consul', address })` with the **default** `createDefaultDiscoveryHttp()`, and `resolveUrl('billing', '/invoices')` returns the address the fake agent advertised. Requires `test.permissions.net: true` in the package manifest.                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m50-service-discovery, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task release:verify 0.1.0-alpha.3   # new package present in PUBLISHED_PACKAGES, @module-first entrypoint
grep -rn "new Function\|eval(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/service-discovery-plugin/src   # must be empty
```

## 8. Risks & mitigations

- **The Kubernetes API server presents a cluster-internal CA that `fetch` will reject.** In-cluster,
  Deno needs `DENO_CERT` and Node needs `NODE_EXTRA_CA_CERTS` pointed at
  `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`. No code change can fix this from inside
  the process. Mitigation: state it in the package README next to the `KubernetesProvider` example
  and in the M39 manifests' env block, and make the `http` option the documented escape hatch for a
  caller-supplied TLS-configured client.
- **`StaticProvider` has no health signal, so a dead instance stays in rotation forever.**
  Mitigation: the README says so plainly, and points at the resilience composition (§3.8) as the
  failover story for static deployments; §9 names ejection as the durable fix.
- **The e2e binds a real socket, and CI runners occasionally refuse ephemeral ports.** Mitigation:
  bind with port `0` and read the assigned port from the returned handle rather than hard-coding one
  — the M46 websocket e2e precedent.
- **Consul deregistration lands after the socket closes (§3.7), so a rolling deploy can 502 for up
  to one check interval.** Mitigation: the default `intervalSeconds: 10` bounds it, the README
  states it, and §9 names the kernel pre-drain hook as the fix.
- **`common` gains a new file and a new token — a public API change.** Mitigation: PUBLIC_API.md is
  updated in the same PR (C3), the addition is purely additive (no existing signature changes), and
  no existing implementor is affected because nothing implements `IServiceDiscovery` today.

## 9. Out of scope

- **DNS-SRV discovery** (Consul DNS, Kubernetes headless services, ECS Service Connect). It cannot
  be expressed over `fetch`: it needs `Deno.resolveDns` / `node:dns/promises`, which means a new
  optional `IRuntimeServices.dns?: IDnsResolver` widening (the M44 `fs?` / M45 `workers?`
  precedent), three runtime adapter implementations, and a documented omission on Cloudflare
  Workers. That is a milestone-sized change with a different blast radius, so it is **M50b**, and
  the `'custom'` arm is the documented bridge until then.
- **Per-instance failure ejection and `watch()` change streams.** Ejection needs an outcome-feedback
  method on the contract plus a rolling failure window that would duplicate M27's circuit breaker;
  `watch()` needs Consul blocking queries (`?index=` + `X-Consul-Index`) and Kubernetes watch
  streams, both long-lived connections with their own reconnect semantics. **M50c**, once the
  composition recipe in §3.8 has been exercised in practice.
- **A kernel pre-drain lifecycle hook** so deregistration can precede request draining (§3.7). It is
  an `ILifecycleApi` widening affecting every plugin and belongs to a kernel milestone, not this
  one.
- **Wiring discovery into `packages/sdk` or M49's gRPC client.** M35 owns the SDK's `baseUrl`
  (`packages/sdk/src/http/contracts.ts:152`) and M49 owns the gRPC client story; a discovery-aware
  client is a change to those packages, and neither may import this plugin.
- **Docker/Kubernetes manifests and a Consul agent in compose** that would exercise this against a
  real cluster. M39.
- **Reconciling the ARCHITECTURE §8 package diagram with all 10 missing workspace members.** M38
  (C1).
