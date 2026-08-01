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
server side — has no way to turn a logical service name into an address. This milestone adds the
complete capability: a `ServiceDiscoveryPlugin` registering an `IServiceDiscovery` under a new
`CAPABILITIES.SERVICE_DISCOVERY = 'service-discovery'` token, backed by a pluggable
`DiscoveryProvider` port with four built-in providers plus a `'custom'` arm, a read-through cache,
push-based change watching, outlier ejection, and three load-balancing strategies.

This milestone is deliberately **not split**. Three capabilities that a narrower plan would have
deferred are in scope here, because each one is the difference between a demo and a usable discovery
client: DNS-SRV resolution (the only mechanism that reaches Consul DNS, Kubernetes headless
services, and ECS Service Connect), `watch()` change propagation (without it every consumer is
polling on a TTL), and outlier ejection (without it a dead instance stays in rotation until the
provider's own health signal catches up, and `StaticProvider` has no such signal at all). Two of
those force changes outside the plugin: DNS needs a new optional `IRuntimeServices.dns?` with four
runtime adapters, and correct deregistration needs a kernel lifecycle hook that does not exist. Both
are flagged widenings requiring maintainer approval (AI_GUIDELINES §16.2), called out in §2.

- **In scope:** the `IServiceDiscovery` contract + `SERVICE_DISCOVERY` token in `common`;
  `ServiceDiscoveryPlugin`; the `DiscoveryProvider` port; `StaticProvider`, `ConsulProvider`,
  `KubernetesProvider`, `DnsProvider`, and a `'custom'` arm; `IRuntimeServices.dns?: IDnsResolver`
  plus its Node/Deno/Bun implementations and documented Workers omission; `ILifecycleApi.onStopping`
  in `common` + `kernel`; Consul self-registration and deregistration; a monotonic-clock
  read-through cache with per-service in-flight coalescing and stale-on-failure; `watch()` over
  Consul blocking queries and Kubernetes watch streams; outlier ejection with a panic threshold;
  `round-robin` / `random` / `weighted-random` balancing; a `service-discovery` health indicator;
  the doc deliverables in §2.
- **NOT this milestone:** wiring discovery into `packages/sdk` or M49's gRPC client — M35 owns the
  SDK's `baseUrl` and M49 owns the gRPC client story, and neither package may import this plugin
  (§9). Docker/Kubernetes/Consul manifests that would exercise this against a real cluster (M39,
  §9). Reconciling the ARCHITECTURE package diagram with all 10 already-missing workspace members
  (M38, C1). These are other milestones' ownership, not sub-milestones of this one.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAPABILITIES`                       | `packages/common/src/tokens.ts:38-127`                                                       | 42 tokens, ending at `METADATA_STORE: 'metadata-store'`. There is **no** discovery token — `SERVICE_DISCOVERY` is new surface, not a token committed in M1 waiting for a reader.                                                                                                                                                                                                                                               |
| `createCapabilityToken` grammar      | `packages/common/src/tokens.ts:52-64`                                                        | `TOKEN_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'`, segments dot-joined. `'service-discovery'` matches. Colons are illegal (the M10 `database:primary` trap).                                                                                                                                                                                                                                                                   |
| `IServiceRegistry`                   | `packages/common/src/registry.ts:66-118`                                                     | `register<T extends object>(token, service, options?)`, `registerFactory`, `get<T>`, `getAll<T>`, `has`, `unregister`. The plugin uses `register` + `get`; no `multi` registration is needed (one discovery provider per app).                                                                                                                                                                                                 |
| `IPluginContext`                     | `packages/common/src/plugin.ts:430-468`                                                      | `services`, `middleware`, `router`, `environment`, `health`, `metrics`, `openapi`, `decorators`, `cli`, `lifecycle`, `runtime`, optional `config`/`logger`/`metadata`/`container`, `options`, `app`. `runtime` is non-optional, so `randomBytes`/`hrtime`/`env` are always available.                                                                                                                                          |
| `ILifecycleApi`                      | `packages/common/src/plugin.ts:301-350`                                                      | `onRegister`, `onInit`, `onBootstrap`, `onRequest`, `onResponse`, `onError`, `onShutdown`, `onClose`. There is **no post-`listen` and no pre-drain hook** — the gap §3.16 closes.                                                                                                                                                                                                                                              |
| `LifecycleManager`                   | `packages/kernel/src/lifecycle/lifecycle-manager.ts:19-105`                                  | Private arrays per hook kind; `runShutdown` iterates **reverse** (LIFO), `runBootstrap`/`runClose` iterate forward. `runStopping` (§3.16) mirrors `runShutdown`'s LIFO.                                                                                                                                                                                                                                                        |
| Kernel start order                   | `packages/kernel/src/application/application.ts:293-335`                                     | `register()` (awaited) → env validation → `onInit` → pipeline compile → **`onBootstrap` (step 7)** → `setHandler` (8) → **`listen` (9)**. Bootstrap runs BEFORE the socket binds. Also confirms `await plugin.register(ctx)`, so an async `register()` is genuinely awaited.                                                                                                                                                   |
| Kernel stop order                    | `packages/kernel/src/application/application.ts:357-379`                                     | `#stopping = true` (set synchronously, before the first `await`, so in-flight arrivals get a 503) → `#drainRequests()` → `adapter.close()` → `onShutdown` → `onClose`. The insertion point for `onStopping` (§3.16).                                                                                                                                                                                                           |
| `IHealthApi.register`                | `packages/common/src/plugin.ts:185-192`                                                      | `register(name: string, indicator: HealthIndicatorFn): void`.                                                                                                                                                                                                                                                                                                                                                                  |
| `HealthCheckResult` / `HealthStatus` | `packages/common/src/services/health.ts:13-18`, `types.ts:62`                                | `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`; `HealthStatus = 'up' \| 'down' \| 'degraded'`.                                                                                                                                                                                                                                                                                                           |
| `IRuntimeServices`                   | `packages/common/src/runtime.ts:178-278`                                                     | `platform`, `version`, `hostname()`, `uuid()`, `randomBytes(n)`, `subtle`, `now()`, `hrtime()`, `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`, `env`, `exit`, optional `fs?`, optional `workers?`. **No DNS service** — the gap §3.9 fills.                                                                                                                                                                        |
| `IFileSystem`                        | `packages/common/src/runtime.ts:50-104`                                                      | `readFile(path): Promise<Uint8Array>`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`. `readFile` is the Kubernetes service-account-token read in §3.5; it returns `Uint8Array`, so the token needs `TextDecoder`.                                                                                                                                                                                                              |
| `mergeRuntimeServices`               | `packages/runtime/src/services/cross-runtime.ts:73-91`                                       | `Pick<IRuntimeServices, 'platform'\|'version'\|'hostname'\|'env'\|'exit'\|'fs'\|'workers'>` merged over the cross-runtime defaults. Widening to include `'dns'` is the single edit that threads the new service through all four adapters.                                                                                                                                                                                     |
| Workers adapter omission pattern     | `packages/runtime/src/adapters/workers/cf-runtime.ts:46-56`                                  | Supplies only `platform`/`version`/`hostname`/`env`/`exit` — optional keys are **omitted entirely**, never assigned `undefined` (`exactOptionalPropertyTypes`). `dns` follows the same pattern (§3.9).                                                                                                                                                                                                                         |
| Deno adapter host seam               | `packages/runtime/src/adapters/deno/deno-runtime.ts:20-27,95-100`                            | `DenoHost` is an injectable structural interface (`version`, `hostname()`, `env.toObject()`, `exit`). `resolveDns` is added to it, so `DenoDnsResolver` is unit-testable without real DNS.                                                                                                                                                                                                                                     |
| Bun adapter reuses Node builtins     | `packages/runtime/src/adapters/bun/bun-runtime.ts:29-31,212`                                 | Already statically imports `node:os` and `node:process` and threads Node `fs` functions in. The Node DNS resolver is therefore shared by the Node and Bun adapters rather than duplicated (§3.9).                                                                                                                                                                                                                              |
| `node:dns/promises` record shapes    | type-probed with `deno check` (scratch file, not committed)                                  | `resolveSrv(name)` resolves `{ name: string; port: number; priority: number; weight: number }[]`; `resolve4`/`resolve6` resolve `string[]`.                                                                                                                                                                                                                                                                                    |
| `Deno.resolveDns` record shapes      | type-probed with `deno check` (scratch file, not committed)                                  | `Deno.resolveDns(q, 'SRV')` resolves `{ target: string; port: number; priority: number; weight: number }[]` — the field is **`target`**, not `name`; `'A'`/`'AAAA'` resolve `string[]`. It is an overload set, not generic. The `target`/`name` divergence is why §3.10 exists.                                                                                                                                                |
| `assertUniqueNames` / provider index | `packages/kernel/src/registry/plugin-resolver.ts:107-140`                                    | Duplicate plugin `name` throws; a capability listed in two plugins' `provides` throws. One `ServiceDiscoveryPlugin` per app claiming the bare `service-discovery` token — no multi-instance naming scheme needed.                                                                                                                                                                                                              |
| `IResilienceService`                 | `packages/common/src/services/resilience.ts:37,51` + `wrap`                                  | `wrap<T>(fn: ResilientCall<T>, options?): HardenedCall<T>` where `ResilientCall<T> = (signal: AbortSignal) => Promise<T>`. Re-enters `fn` per attempt — the property the failover recipe in §3.14 depends on, and the reason ejection is a **different** mechanism, not a duplicate.                                                                                                                                           |
| `INotificationHttp` default seam     | `packages/notification-plugin/src/http/default-http.ts:16-34`                                | `createDefaultNotificationHttp(fetchImpl: typeof fetch = fetch)` returning `{ post(url, body, headers) }`. The precedent `IDiscoveryHttp` extends (§3.3) — zero-dep, Workers-portable, injectable `fetch`.                                                                                                                                                                                                                     |
| Per-package test permissions         | `packages/websocket-plugin/deno.json:6-10`                                                   | `"test": { "permissions": { "net": true } }` — how M46 ran a real-socket e2e even though the root `test` task grants no `--allow-net`. The M50 e2e (§6) uses the same mechanism.                                                                                                                                                                                                                                               |
| Root `test` task permissions         | `deno.json:49`                                                                               | `deno test -P --allow-read --allow-import --allow-env --allow-sys=hostname packages` — no `--allow-net`, confirming the per-package grant above is required, not optional.                                                                                                                                                                                                                                                     |
| Workspace + release lists            | `deno.json:3-44`, `scripts/release-packages.ts:33-64,86`                                     | 42 workspace members; 42 entries in `PUBLISHED_PACKAGES` (Tier 4 is the alphabetized plugin list); `UNPUBLISHED_PACKAGES` is empty. M50 makes both 43.                                                                                                                                                                                                                                                                         |
| Consul health read                   | `developer.hashicorp.com/consul/api-docs/health` (fetched)                                   | `GET /v1/health/service/:service`; `?passing=true` returns only nodes with all checks passing. Entries carry `Node.Address`, `Service.ID`, `Service.Service`, `Service.Address`, `Service.Port`, `Service.Tags`, `Service.Meta`, `Service.Weights`.                                                                                                                                                                            |
| Consul agent register/deregister     | `developer.hashicorp.com/consul/api-docs/agent/service` (fetched)                            | `PUT /v1/agent/service/register` with body fields `ID`, `Name`, `Address`, `Port`, `Tags`, `Meta`, `Check`; HTTP check fields `Interval` and `DeregisterCriticalServiceAfter`. `PUT /v1/agent/service/deregister/:service_id`.                                                                                                                                                                                                 |
| Consul auth header + prefix          | `developer.hashicorp.com/consul/api-docs/api-structure` (fetched)                            | All endpoints are prefixed `/v1/`; the ACL token header is `X-Consul-Token`.                                                                                                                                                                                                                                                                                                                                                   |
| Consul blocking queries              | `developer.hashicorp.com/consul/api-docs/features/blocking` (fetched)                        | Response header `X-Consul-Index`; request params `index` and `wait` (`'10s'`/`'5m'` form); default wait 5 min, **max 10 min**; server adds up to `wait/16` jitter. A returned index **lower** than the previous one requires resetting to `0` and restarting; an index of `0` must be treated as invalid to avoid a busy loop. Both are §3.12 requirements, not defensive extras.                                              |
| Kubernetes EndpointSlice             | `kubernetes.io/docs/reference/kubernetes-api/service-resources/endpoint-slice-v1/` (fetched) | `discovery.k8s.io/v1`; `GET /apis/discovery.k8s.io/v1/namespaces/{namespace}/endpointslices`; fields `endpoints[]`, `endpoints[].addresses[]`, `endpoints[].conditions.ready` (**nil means true**), `ports[]` with `port`/`name`/`protocol`. Association label `kubernetes.io/service-name`.                                                                                                                                   |
| Kubernetes watch API                 | `kubernetes.io/docs/reference/using-api/api-concepts/` (fetched)                             | `?watch=true&resourceVersion=<v>&allowWatchBookmarks=true`; chunked `application/json` streaming one JSON object per line, shaped `{ type, object }` with `type` in `ADDED`/`MODIFIED`/`DELETED`/`BOOKMARK`/`ERROR`; initial version from the list response's `metadata.resourceVersion`; an expired version returns **`410 Gone`**, and the client must discard the watch, re-LIST, and restart from the new version (§3.13). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                                                                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md:960-1077` "Package Overview" graphs 32 nodes; the workspace has 42 members (`deno.json:3-44`). Missing: `exceptions`, `sse-plugin`, `websocket-plugin`, `worker-pool-plugin`, `realtime-backplane-plugin`, `react-router-plugin`, `session-plugin`, and the three starters.                                                       | This PR adds only the `service-discovery-plugin` node and its `common -->` edge. The 10-member backlog is **named, not absorbed** — it is doc debt from seven prior milestones and belongs to the documentation milestone, which owns a full pass rather than an incremental patch.                                                             | `ARCHITECTURE.md`: add `service-discovery[service-discovery-plugin]` to the Infrastructure Plugins subgraph plus `common --> service-discovery`. `ROADMAP.md` M38: add "reconcile the §8 Package Overview diagram with the workspace member list (10 members missing as of M50)" to its deliverables. |
| C2 | `README.md` states five mutually inconsistent counts: line 22 "all 38 packages are live", line 24 "31 plugins", line 212 "All 36 packages are published", line 314 "41 workspace members — 38 published, 3 stubs", line 320 "30 capability plugins". Ground truth today is 42 members, 42 in `PUBLISHED_PACKAGES`, 32 `*-plugin` dirs, zero stubs. | Correct all five to the post-M50 truth in one edit and drop the "3 stubs" clause (M36 made the starters real published libraries; `UNPUBLISHED_PACKAGES` is empty at `scripts/release-packages.ts:86`). Line 22's "38 live on JSR" describes the shipped `alpha.3` release and is re-worded to say so rather than reading as a workspace count. | `README.md`: 43 workspace members, 33 capability plugins, `PUBLISHED_PACKAGES` at 43, the alpha.3 sentence scoped to "published in `v0.1.0-alpha.3`", and a `service-discovery-plugin` row in the plugin table.                                                                                       |
| C3 | `PUBLIC_API.md:8-49` TOC has no discovery entry and `ARCHITECTURE.md` never mentions service discovery, while `ROADMAP.md` M39 puts Kubernetes `Services` in scope — implying discovery is the platform's job, which is true for k8s DNS and false for Consul, for `pick()` weighting, and for ejection.                                           | Discovery is a framework capability with a platform-delegating default, not a platform-only concern. M39 keeps owning the manifests; M50 owns app-side resolution, balancing, watching, and ejection.                                                                                                                                           | `PUBLIC_API.md`: new "Service Discovery" section + TOC entry, plus `IServiceDiscovery`/`ServiceInstance`/`PickOptions`/`LoadBalanceStrategy`/`ServiceOutcome`/`SERVICE_DISCOVERY` rows in the `common` API reference. `ROADMAP.md` M39: one sentence noting M50 owns app-side resolution.             |
| C4 | **Flagged widening, requires approval (AI_GUIDELINES §16.2).** `IRuntimeServices` gains an optional `dns?: IDnsResolver`, and `ARCHITECTURE.md:814-841` ("IRuntimeServices") plus `PUBLIC_API.md:234-292` ("Available Runtime Services") both enumerate the service list and would go stale.                                                       | Ship the widening. It is purely additive and follows the committed M44 `fs?` / M45 `workers?` precedent for a capability absent on one runtime. Cloudflare Workers omits the key; `DnsProvider` throws at `register()` there with both remedies named.                                                                                          | `PUBLIC_API.md` "Available Runtime Services": add the `dns` row marked optional with its per-runtime availability. `ARCHITECTURE.md` §7: add `dns` to the `IRuntimeServices` listing and one sentence on the Workers omission.                                                                        |
| C5 | **Flagged widening, requires approval (AI_GUIDELINES §16.2/§16.3).** `ILifecycleApi` gains `onStopping`, changing the observable semantics of `IApplication.stop()`: hooks now run **before** the application begins refusing new requests. `ARCHITECTURE.md:644-658` ("Lifecycle Hooks") and `PUBLIC_API.md` enumerate the hook set.              | Ship it. With no `onStopping` hooks registered, `runStopping()` resolves immediately and `stop()` is byte-for-byte unchanged for every existing application — the compatibility argument is that the new window has zero width unless something opts in. The alternative is shipping §3.16's known-broken deregistration window.                | `ARCHITECTURE.md` §5 "Lifecycle Hooks": add `onStopping` with its position and its "still serving traffic" semantics. `PUBLIC_API.md`: add `onStopping` to the `ILifecycleApi` reference. `CHANGELOG.md`: note the `stop()` semantic addition under Added, not Changed (no existing behavior moves).  |

## 3. Design decisions

### 3.1 The port: `IServiceDiscovery` in `common`, five methods

- **Decision:** `common` gains `packages/common/src/services/service-discovery.ts` exporting
  `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`, and `IServiceDiscovery`
  with exactly five methods: `resolve(serviceName): Promise<readonly ServiceInstance[]>`,
  `pick(serviceName, options?): Promise<ServiceInstance | null>`,
  `resolveUrl(serviceName, path?, options?): Promise<string | null>`,
  `report(instance, outcome: ServiceOutcome): void`, and
  `watch(serviceName, listener): Promise<Unsubscribe>`. Registration and deregistration of _this_
  instance are **not** on the contract; they are plugin-internal lifecycle behavior (§3.15, §3.16).
  `CAPABILITIES.SERVICE_DISCOVERY = 'service-discovery'` is added alongside.
- **Why:** the contract's consumers are callers that need an address, a way to tell discovery how
  the call went, and a way to learn about changes without polling. A
  `registerSelf()`/`deregisterSelf()` pair on the port would be surface no application code path
  reads — the plugin drives its own lifecycle hooks — which is the dead-surface defect this repo has
  shipped before. `Unsubscribe` is reused from `common/services/events.ts` rather than redeclared.
  Keeping the contract in `common` (not the plugin) is required because a consumer resolving
  `CAPABILITIES.SERVICE_DISCOVERY` must type it as the token's documented interface without
  importing the plugin (AI_GUIDELINES §2.2).
- **Test home:** `test/integration/plugin-registration.test.ts` resolves the token and exercises all
  five methods through the `IServiceDiscovery` type.

### 3.2 `pick` and `resolveUrl` funnel through one implementation

- **Decision:** `ServiceDiscoveryService.resolveUrl` calls its own `pick()` and formats the result
  via the internal `instanceUrl()`; it does not re-resolve, re-balance, re-filter ejections, or
  apply its own defaults. `pick(name, { strategy })` overrides the plugin-configured strategy for
  that call only.
- **Why:** two entry points to one behavior is exactly the split that shipped green before (a
  `validateBody(...)` helper ignoring the plugin's configured `errorFormat`). One implementation,
  one configuration read, one ejection filter.
- **Test home:** `test/unit/service-discovery-service.test.ts` — a test configures the non-default
  `strategy: 'weighted-random'` with a stubbed `randomBytes` and asserts `pick()` and `resolveUrl()`
  select the **same** instance; a second passes `{ strategy: 'random' }` per call and asserts both
  entry points honor the override identically; a third ejects an instance and asserts both entry
  points skip it.

### 3.3 Transport: one injectable seam with a buffered and a streaming method, zero npm dependencies

- **Decision:** `IDiscoveryHttp` exposes `request(url, init): Promise<DiscoveryHttpResponse>` where
  `DiscoveryHttpResponse = { ok, status, headers: Headers, text: string }`, and
  `stream(url, init): Promise<DiscoveryHttpStream>` where
  `DiscoveryHttpStream = { ok, status, headers: Headers, body: ReadableStream<Uint8Array> | null }`.
  `createDefaultDiscoveryHttp(fetchImpl = fetch)` implements both over one `fetch`. Providers take
  an `IDiscoveryHttp` through their constructor; the `http` plugin option overrides the default.
- **Why:** the M30 `INotificationHttp` precedent, verified at
  `packages/notification-plugin/src/http/default-http.ts:16-34`. Consul and the Kubernetes API
  server are plain HTTP JSON with no client library worth an `npm:` import, so §12.2's
  inject-or-lazy pattern collapses to inject-only and the package ships an empty dependency graph.
  `headers` is on the buffered response because Consul's blocking-query protocol lives entirely in
  `X-Consul-Index` (§3.12); `stream` exists because a Kubernetes watch is a chunked response that
  `text()` would never resolve (§3.13). One seam with two methods beats two seams: both providers
  need both.
- **Test home:** `test/unit/default-http.test.ts` drives both methods with a stub `fetchImpl`,
  asserting method/header/body pass-through, `headers` exposure, and `body: null` on a bodiless
  response; `test/e2e/service-discovery-e2e.test.ts` drives the **default** seam over real global
  `fetch` against a real loopback server (§6).

### 3.4 Cache: read-through TTL on the monotonic clock, coalesced, stale-on-failure, watch-invalidated

- **Decision:** `ServiceDiscoveryService` holds `Map<string, { instances, stampMs }>` and
  `Map<string, Promise<readonly ServiceInstance[]>>` for in-flight reads. `resolve()` returns the
  cached entry when `runtime.hrtime() - stampMs < cacheTtlMs`; otherwise it starts (or joins) one
  in-flight provider call per service name. `cacheTtlMs` defaults to `30_000`; `0` disables caching.
  A watch event for a service name (§3.11) **invalidates that name's entry immediately**, so a
  watched service is never served stale beyond the propagation delay. On a provider failure with a
  stale entry present, the stale entry is returned and an internal `#degraded` flag is set; with no
  entry present, a `DiscoveryUnavailableError` is thrown with the provider error as `cause`. There
  is no background refresh timer.
- **Why:** `pick()` sits on a request path and cannot afford a Consul round trip per call. The
  monotonic clock is mandatory — mixing `Date.now()` with `hrtime()` is a documented repo defect
  class. Coalescing is the M47 LaunchDarkly-provider precedent: without it a burst of concurrent
  `pick()`s for one cold service issues N identical reads. Watch-invalidation is what makes the TTL
  a safety net rather than the primary freshness mechanism. Stale-on-failure is the M31
  `DatabaseProvider` precedent.
- **Test home:** `test/unit/service-discovery-service.test.ts` — a call-counting fake provider
  proves (a) a second `resolve()` inside the TTL does not call the provider, (b) `cacheTtlMs: 0`
  calls it every time, (c) ten concurrent `resolve()`s of a cold name produce exactly one provider
  call, (d) a watch event invalidates that name and only that name, (e) a provider that rejects
  after a successful read returns the stale list and flips the health indicator to `'degraded'`, (f)
  a provider that rejects with nothing cached throws `DiscoveryUnavailableError` carrying the
  original as `cause`.

### 3.5 Kubernetes credentials: explicit token, or a memoized service-account file read

- **Decision:** `KubernetesProvider` resolves its bearer token per API request from the `token`
  option when present (used verbatim, no file access), otherwise from
  `runtime.fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token')` decoded as UTF-8 and
  memoized for 60 s against `runtime.hrtime()`. With no `token` option **and** no `runtime.fs`, the
  plugin throws during `register()` naming both remedies. The API server base URL defaults to
  `https://${runtime.env.KUBERNETES_SERVICE_HOST}:${runtime.env.KUBERNETES_SERVICE_PORT}`; the
  `apiServer` option overrides it, and a missing host env with no `apiServer` throws during
  `register()`.
- **Why:** Kubernetes rotates projected service-account tokens roughly hourly, so a token read once
  at registration stops working while the pod is still healthy — a failure that appears hours after
  a green deploy. Re-reading per request with a 60 s memo bounds the file I/O to at most one read
  per minute and is the M30b FCM token-cache pattern. Failing at `register()` rather than at first
  `resolve()` is the M30 `email`-without-`mail` precedent: a misconfiguration is a startup error.
- **Test home:** `test/unit/kubernetes-provider.test.ts` — an injected fake `IFileSystem` proves the
  file path, the UTF-8 decode, exactly one read across two calls inside the memo window, a second
  read after the fake clock advances past 60 s, and the `Authorization: Bearer <token>` header; two
  further tests assert the two `register()`-time throws.
  `test/integration/plugin-registration.test.ts` covers the throws through a real kernel app.

### 3.6 Load balancing: three literal strategies, randomness from `runtime.randomBytes`

- **Decision:** `LoadBalanceStrategy = 'round-robin' | 'random' | 'weighted-random'`, defaulting to
  `'round-robin'`. No function form is accepted. `round-robin` keeps a `Map<string, number>` cursor
  taken modulo the current instance count. `random` and `weighted-random` derive a float from
  `runtime.randomBytes(4)` read as a big-endian uint32 divided by `2 ** 32`; `weighted-random` uses
  `instance.weight ?? 1` and treats a non-positive weight as `0` (never selected, unless every
  weight is non-positive, in which case selection falls back to uniform over the list).
- **Why:** `Math.random()` and `Date.now()` are the two clock/randomness smells the gates do not
  catch; `runtime.randomBytes` is on the mandatory `IRuntimeServices`
  (`packages/common/src/runtime.ts:210`), so tests fake it through the runtime they already build
  and every selection becomes deterministic without a new seam. Rejecting a function form keeps
  `strategy` from becoming surface whose only reader is its own test — a custom selection policy is
  reachable by writing a `DiscoveryProvider`.
- **Test home:** `test/unit/load-balancer.test.ts` — cursor advance and wrap; cursor behavior when
  the instance count shrinks between picks; uniform selection at both ends of the `randomBytes`
  range; weighted selection landing in each bucket; the all-non-positive-weight fallback; `null` on
  an empty list.

### 3.7 Instance-to-URL formatting is one shared pure function

- **Decision:** `instanceUrl(instance, path?)` (internal, `src/url/instance-url.ts`) produces
  `${instance.secure ? 'https' : 'http'}://${host}:${port}${joinedPath}`, bracketing `host` as
  `[host]` when it contains a `:` (an IPv6 literal), and joining `path` with exactly one `/`
  regardless of whether the caller's `path` is prefixed. `resolveUrl` is its only caller.
- **Why:** Kubernetes `endpoints[].addresses[]` are canonical IP strings that are IPv6 in a
  dual-stack or IPv6-only cluster, and an unbracketed IPv6 host produces a URL `fetch` rejects. DNS
  `AAAA` results have the same property. Slash-joining bugs are the classic duplicated-logic defect.
- **Test home:** `test/unit/instance-url.test.ts` asserts IPv4, IPv6-bracketed, `secure` on and off,
  no path, `/`-prefixed path, and un-prefixed path — expected strings written literally.

### 3.8 Provider selection is a discriminated union with per-arm construction

- **Decision:** `ServiceDiscoveryPluginOptions` is a union discriminated on `provider`:
  `'static' | 'consul' | 'kubernetes' | 'dns' | 'custom'`. `createProvider` is overloaded per arm so
  a missing per-arm credential is a **compile** error, not a startup throw. Only `ConsulProvider`
  implements `registerSelf`/`deregisterSelf`; configuring `selfRegistration` alongside any other arm
  throws `SelfRegistrationNotSupportedError` during `register()`.
- **Why:** the M30 `ChannelConfig` precedent — pushing credential requirements into the type system
  beats a runtime throw. Static is a literal list with nothing to register against; in Kubernetes
  the control plane owns Endpoint membership; DNS records are zone data. Honoring `selfRegistration`
  on any of them would be a silent no-op, so a startup throw names the mistake.
- **Test home:** `test/unit/provider-factory.test.ts` builds each arm and asserts the concrete
  class; `test/integration/plugin-registration.test.ts` asserts the
  `SelfRegistrationNotSupportedError` for the `'static'`, `'kubernetes'`, and `'dns'` arms through a
  real kernel app.

### 3.9 DNS: a new optional `IRuntimeServices.dns?`, implemented on three runtimes and omitted on Workers

- **Decision:** `common` gains
  `SrvRecord = { readonly host: string; readonly port: number; readonly priority: number; readonly weight: number }`
  and `IDnsResolver` with `resolveSrv(hostname): Promise<readonly SrvRecord[]>` and
  `resolveHost(hostname): Promise<readonly string[]>`, exposed as
  `IRuntimeServices.dns?: IDnsResolver`. `packages/runtime` gains `createNodeDnsResolver()` (shared
  by the Node and Bun adapters, over static `node:dns/promises` imports) and
  `createDenoDnsResolver(host)` (over `DenoHost.resolveDns`); `mergeRuntimeServices`'s `Pick` is
  widened with `'dns'`; the Cloudflare adapter omits the key entirely. `resolveHost` concatenates
  `A` and `AAAA` results, tolerating a rejection from one family when the other succeeds and
  rejecting only when both fail.
- **Why:** DNS-SRV is the one discovery mechanism that cannot be expressed over `fetch`, and it is
  how Consul DNS, Kubernetes headless services, and ECS Service Connect are actually consumed —
  omitting it would leave the milestone unable to talk to the most common deployment shapes. The
  optional-key shape follows the committed M44 `fs?` and M45 `workers?` precedents for a capability
  one runtime lacks, and the Workers omission pattern is verified at
  `packages/runtime/src/adapters/workers/cf-runtime.ts:46-56`. Static `node:` imports are mandatory
  here — a smuggled `require` is banned, and Deno, Node, and Bun all support them. The A/AAAA
  tolerance matters because an IPv4-only host has no `AAAA` record and the resolver rejects rather
  than returning an empty list.
- **Test home:** `packages/runtime/test/unit/node-dns-resolver.test.ts` and
  `deno-dns-resolver.test.ts` drive both resolvers against injected fakes (record normalization, the
  one-family-fails case, the both-fail rejection); `packages/runtime/test/unit/cf-runtime.test.ts`
  gains an assertion that `dns` is **absent** from the Workers services object
  (`'dns' in services === false`, not `services.dns === undefined`).

### 3.10 SRV record normalization: `target` on Deno, `name` on Node

- **Decision:** `IDnsResolver.resolveSrv` returns records with a `host` field.
  `createDenoDnsResolver` maps `target → host`; `createNodeDnsResolver` maps `name → host`. Neither
  runtime's raw shape escapes `packages/runtime`.
- **Why:** type-probed with `deno check` (§1): `Deno.resolveDns(q, 'SRV')` yields
  `{ target, port, priority, weight }` while `node:dns/promises` `resolveSrv` yields
  `{ name, port, priority, weight }`. A port that passed both shapes through unchanged would make
  `DnsProvider` correct on one runtime and produce `undefined` hostnames on the other — a defect
  that type-checks on both, since neither field is read by `common`. Naming the normalized field
  `host` rather than reusing one runtime's name keeps the bug from hiding behind a familiar
  spelling.
- **Test home:** the two resolver tests in §3.9 each assert the mapped `host` value against a fake
  returning that runtime's native field name.

### 3.11 `DnsProvider`: SRV priority tiers, and an A-record mode that needs an explicit port

- **Decision:** `DnsProvider` takes `mode: 'srv' | 'a'`. In `'srv'` mode it queries
  `domainTemplate.replace('{service}', name)` (default `'{service}.service.consul'`), keeps **only
  the records at the numerically lowest `priority`**, and maps each to a `ServiceInstance` with
  `weight: record.weight`, `host: record.host` (trailing dot stripped), `port: record.port`, and
  `id: '<host>:<port>'`. In `'a'` mode it calls `resolveHost` and requires an explicit `port` option
  (the type makes it mandatory on that arm), emitting one instance per address. Both modes throw
  `DiscoveryUnavailableError` at `register()` when `runtime.dns` is absent, naming Cloudflare
  Workers and the `'static'`/`'consul'`/`'kubernetes'` arms as the alternatives. `watch()` on this
  provider is interval polling at `watchIntervalMs` (default `30_000`).
- **Why:** RFC 2782 says a client contacts the lowest-priority tier first and distributes across it
  by weight; ignoring `priority` would spread traffic across a primary and its designated fallback
  simultaneously, which is the opposite of what the record author asked for. Mapping SRV `weight`
  onto `ServiceInstance.weight` makes `'weighted-random'` honor the zone's intent with no extra
  surface. A-record mode cannot infer a port — DNS carries none — so requiring it in the type beats
  defaulting to 80. Polling is the honest `watch()` implementation: DNS has no push channel, and
  pretending otherwise by never firing would be worse than a documented interval.
- **Test home:** `test/unit/dns-provider.test.ts` with a fake `IDnsResolver` — lowest-priority tier
  selection with a mixed-priority record set, weight pass-through, trailing-dot stripping, the
  domain-template substitution, `'a'` mode emitting one instance per address at the configured port,
  the missing-`runtime.dns` throw, and `watch()` firing on a changed record set and staying silent
  on an unchanged one.

### 3.12 `ConsulProvider.watch`: a blocking-query loop, with both documented index hazards handled

- **Decision:** `watch()` runs an async loop issuing
  `GET /v1/health/service/<name>?passing=true&index=<i>&wait=30s`, reading `X-Consul-Index` from the
  response headers. The loop starts at `index=0`; after each response it (a) parses the header as an
  integer, (b) treats a value `<= 0` as `1`, (c) resets its stored index to `0` when the new value
  is **less than** the stored one, and (d) otherwise adopts it. Every completed response fires the
  listener with the freshly parsed instance list. A rejected request backs off (250 ms, doubling to
  a 5 s ceiling) and retries; the loop exits only when the returned `Unsubscribe` is called, which
  also aborts the in-flight request via an `AbortSignal` threaded into `IDiscoveryHttp.request`.
- **Why:** both index hazards are documented upstream requirements, not defensive extras
  (`developer.hashicorp.com/consul/api-docs/features/blocking`, §1): an index that moves backwards
  after a server restart makes the client "miss future updates for an unbounded time" if not reset,
  and an index of `0` "can cause busy loops on certain older Consul versions" — a busy loop against
  Consul is the kind of production incident no test would surface. `wait=30s` sits far below the 10
  min maximum on purpose: the server adds up to `wait/16` jitter, so a short wait keeps unsubscribe
  latency bounded without meaningfully increasing request volume.
- **Test home:** `test/unit/consul-watch.test.ts` with a scripted fake `IDiscoveryHttp` — the first
  request carries `index=0`; a response's `X-Consul-Index` is used on the next request; a header of
  `0` becomes `1`; a header **lower** than the stored index resets to `0`; a rejected request backs
  off and retries rather than exiting; `Unsubscribe` stops the loop and aborts the in-flight
  request.

### 3.13 `KubernetesProvider.watch`: a real watch stream used as a change signal, not a delta log

- **Decision:** `watch()` LISTs once to obtain `metadata.resourceVersion`, then opens
  `?watch=true&resourceVersion=<v>&allowWatchBookmarks=true&labelSelector=kubernetes.io/service-name=<name>`
  through `IDiscoveryHttp.stream`, reading the chunked body as newline-delimited JSON. On any event
  of type `ADDED`/`MODIFIED`/`DELETED` it **re-LISTs and fires the listener with the full instance
  list**; `BOOKMARK` events only advance the stored `resourceVersion`; an `ERROR` event, a
  `410 Gone` status, or a closed stream restarts the whole sequence from a fresh LIST. `Unsubscribe`
  aborts the stream and stops the restart loop.
- **Why:** using the watch as a change _signal_ rather than a delta log removes the need to maintain
  a slice-by-name map and merge partial EndpointSlice updates — a stateful reconciliation that is
  where hand-rolled Kubernetes clients most often go wrong. The cost is one extra LIST per change,
  which is bounded by the rate of endpoint churn, not by time. `410 Gone` handling is a documented
  requirement (§1): the client must discard the watch, re-LIST, and restart from the new version. A
  polling fallback was rejected because it would put a constant floor on API-server load in every
  cluster regardless of churn.
- **Test home:** `test/unit/kubernetes-watch.test.ts` with a fake `IDiscoveryHttp.stream` feeding a
  scripted `ReadableStream` — a `MODIFIED` event triggers exactly one re-LIST and one listener call;
  a `BOOKMARK` triggers none but advances the version used on the next stream; a `410` status
  restarts from a fresh LIST; a stream that closes without an error restarts; `Unsubscribe` aborts
  and stops the restarts. `test/unit/ndjson.test.ts` covers the line reader independently (a JSON
  object split across two chunks, several objects in one chunk, a trailing partial line at
  end-of-stream).

### 3.14 Outlier ejection: a pool-membership filter, deliberately not a second circuit breaker

- **Decision:** `report(instance, outcome)` feeds an internal `EjectionTracker` keyed by
  `serviceName + '\0' + id`. `failureThreshold` (default `5`) failures inside a `windowMs` (default
  `30_000`) monotonic rolling window eject the instance for `durationMs` (default `30_000`); a
  `'success'` report clears that instance's window and un-ejects it immediately. `pick()` filters
  ejected instances; `resolve()` does **not** (it reports what discovery knows, `pick` reports what
  is usable). `maxEjectionPercent` (default `50`) caps the share of a service's known instances that
  may be ejected at once — an ejection that would exceed the cap does not happen. When every
  instance is nonetheless ejected, `pick()` falls back to the unfiltered list rather than returning
  `null`. `ejection: false` disables the whole mechanism.
- **Why:** this is a different mechanism from M27's circuit breaker, not a duplicate of it, and the
  distinction is the reason it belongs here. `IResilienceService.wrap` breaks a **call site** —
  after N failures it stops calling `fn` at all, which for a multi-instance service means refusing
  to talk to healthy instances because unhealthy ones failed. Ejection removes a **pool member**
  while the call site stays open, so traffic keeps flowing to the survivors. The two compose: wrap
  the call, re-`pick()` inside it. The panic-threshold cap and the all-ejected fallback are Envoy's
  outlier detection semantics and exist because ejecting an entire pool converts a partial outage
  into a total one — a correlated failure (a bad deploy, a shared dependency) makes every instance
  report failures at once, and the naive implementation then serves nothing. Ejection state is
  per-process and documented as such; a cluster-wide view would need the realtime backplane and is
  not attempted.
- **Test home:** `test/unit/ejection-tracker.test.ts` — threshold reached inside the window ejects;
  failures spread wider than the window do not; a success clears the window; ejection expires after
  `durationMs` on the fake monotonic clock; `maxEjectionPercent` refuses the ejection that would
  exceed the cap; `ejection: false` never ejects. `test/unit/service-discovery-service.test.ts`
  asserts `pick` filters while `resolve` does not, and the all-ejected fallback.
  `test/e2e/service-discovery-e2e.test.ts` drives the full loop over real sockets: pick, fail,
  `report`, pick again, and assert a different instance.

### 3.15 Self-registration runs in `onBootstrap`, and the health check is what makes that safe

- **Decision:** when `selfRegistration` is configured, the plugin registers a
  `ctx.lifecycle.onBootstrap` hook calling `provider.registerSelf(...)`. `SelfRegistration.check` is
  **not optional**: it defaults to
  `{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }` and cannot be disabled.
  `ConsulProvider.resolve` and its watch loop always send `passing=true`.
- **Why:** verified at `packages/kernel/src/application/application.ts:293-335`, `onBootstrap`
  (step 7) runs **before** `listen()` (step 9), and `ILifecycleApi` has no post-listen hook.
  Registering at bootstrap therefore advertises the instance before its socket is bound. That window
  is harmless **only** because Consul marks a newly registered service critical until its first
  check passes and every consumer filters on `passing=true` — so the mandatory check is
  load-bearing, not a convenience default, and making it disable-able would silently reintroduce the
  race. Adding a post-listen lifecycle hook was considered and rejected: §3.16 already adds one hook
  to `ILifecycleApi`, and a second one for a problem the health check fully solves is surface
  without a reader.
- **Test home:** `test/unit/consul-provider.test.ts` asserts the registration body carries the
  default `Check` and that reads always send `passing=true`;
  `test/integration/self-registration.test.ts` asserts `PUT /v1/agent/service/register` fires during
  `start()`.

### 3.16 `ILifecycleApi.onStopping` — a new kernel hook so deregistration precedes draining

- **Decision:** `common` gains `ILifecycleApi.onStopping(fn: () => void | Promise<void>): void`;
  `LifecycleManager` gains a `#stopping` hook array and a `runStopping()` that iterates **LIFO**,
  mirroring `runShutdown`; `Application.#doStop()` awaits `runStopping()` as its **first**
  statement, **before** `this.#stopping = true`. The plugin's deregistration moves from `onShutdown`
  to `onStopping`, and `selfRegistration.drainDelayMs` (default `0`) makes the hook await that many
  milliseconds via `runtime.setTimeout` after deregistering. Deregistration failures are logged
  through `ctx.logger` when present and swallowed, never rethrown.
- **Why:** verified at `packages/kernel/src/application/application.ts:357-379`, `stop()` sets
  `#stopping = true` synchronously, drains in-flight requests, and closes the socket — all
  **before** `onShutdown` runs. Deregistering there means Consul still routes to a closed port for
  up to a check interval on every rolling deploy. Running the hook before `#stopping = true` is what
  makes it correct rather than merely earlier: the application is still serving normally while the
  deregistration propagates, which is exactly the drain window a zero-downtime deploy needs, and
  `drainDelayMs` makes that window explicit and opt-in. The compatibility argument is that
  `runStopping()` over an empty array resolves immediately, so `stop()` is unchanged for every
  application that registers no hook — the new window has zero width unless something opts in. The
  kernel comment at `application.ts:358-359` explaining why `#stopping` is set before the first
  `await` must be updated in the same change to say what now precedes it. Rethrowing from the hook
  would turn a best-effort cleanup into a failed `stop()`.
- **Test home:** `packages/kernel/test/unit/lifecycle-manager.test.ts` asserts LIFO ordering and
  that `runStopping()` over an empty array resolves;
  `packages/kernel/test/integration/application-stop.test.ts` asserts an `onStopping` hook runs
  before a concurrently-arriving request receives its 503 (proving the hook precedes
  `#stopping = true`) and that `stop()` with no hooks behaves exactly as before.
  `test/integration/self-registration.test.ts` asserts `PUT /v1/agent/service/deregister/<id>` fires
  during `app.stop()`, that `drainDelayMs` is awaited after it, and that a rejecting deregistration
  still lets `stop()` resolve.

### 3.17 Consul and Kubernetes response mapping — the two field traps

- **Decision:** `ConsulProvider` maps each entry to
  `{ id: Service.ID, serviceName: Service.Service, host: Service.Address || Node.Address, port: Service.Port, secure: options.secure ?? false, weight: Service.Weights?.Passing, tags: Service.Tags, metadata: Service.Meta }`
  — the `Service.Address`-empty-string fallback to `Node.Address` is mandatory, not defensive.
  `KubernetesProvider` reads every EndpointSlice matching
  `labelSelector=kubernetes.io/service-name=<name>`, treats `conditions.ready === undefined` as
  **ready** and `false` as not ready, emits one `ServiceInstance` per address in `addresses[]`, and
  takes the port from the `ports[]` entry whose `name` matches the `portName` option — defaulting to
  the single entry when `portName` is unset and exactly one exists, and throwing a
  `DiscoveryUnavailableError` naming the available port names when several exist.
- **Why:** both are verified upstream facts (§1), not inference. Consul returns `Service.Address` as
  an empty string for a service registered without an explicit address; the node address is the real
  one, and omitting the fallback yields `http://:8080`. The Kubernetes reference states
  `conditions.ready` nil means true, so treating `undefined` as not-ready would silently discard
  every endpoint in a slice that omits the field. The multi-port throw prevents silently picking an
  arbitrary port.
- **Test home:** `test/unit/consul-provider.test.ts` (empty `Service.Address` falls back to
  `Node.Address`; a populated one wins) and `test/unit/kubernetes-provider.test.ts`
  (`ready: undefined` included, `ready: false` excluded, one instance per address, named-port match,
  single-port default, multi-port throw).

### 3.18 Health indicator and `onClose`

- **Decision:** `ctx.health.register('service-discovery', …)` reports
  `{ status, data: { provider, cachedServices, watchedServices, ejectedInstances, degraded } }`,
  where `status` is `'degraded'` when the service is serving a stale snapshot after a failed refresh
  (§3.4) and `'up'` otherwise. It never issues a provider call of its own. The plugin registers an
  `onClose` hook that unsubscribes every active watch and clears the ejection tracker.
- **Why:** a health indicator that probes on every scrape turns a liveness check into load against
  Consul; reporting the cache's own observed state is free and is what an operator needs. `'down'`
  is unreachable by construction: with nothing cached and a failing provider, no `resolve()` has
  succeeded and the caller already received a `DiscoveryUnavailableError`. `onClose` is now required
  — §3.4's decision not to run a background timer no longer covers the watch loops and the DNS poll
  interval, and AI_GUIDELINES §14.5 makes timer and listener cleanup mandatory.
- **Test home:** `test/integration/plugin-registration.test.ts` asserts `'up'` after a successful
  resolve, `'degraded'` after a provider failure with a warm cache, and that a watch registered
  before `stop()` is unsubscribed by `onClose` (the fake provider records the unsubscribe).

## 4. Exported surface — every symbol names its consumer

New in `@hono-enterprise/common` (flagged widenings — C3, C4, C5):

| Exported symbol                  | Kind      | Consumer / real code path that READS it                                                                                                         |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `IServiceDiscovery`              | interface | Implemented by the plugin's internal `ServiceDiscoveryService`; the type every consumer resolves the token as (integration + e2e tests, README) |
| `ServiceInstance`                | interface | Returned by all four providers and by `resolve`/`pick`; read by `instanceUrl`, the balancer's `weight`, and the ejection tracker's key          |
| `PickOptions`                    | interface | Second argument of `pick`, third of `resolveUrl`; its `strategy` is read by `ServiceDiscoveryService.pick` (§3.2)                               |
| `LoadBalanceStrategy`            | type      | Field of `PickOptions` and of the plugin options; switched on by `createLoadBalancer`                                                           |
| `ServiceOutcome`                 | type      | Second argument of `report`; switched on by `EjectionTracker.record` (§3.14)                                                                    |
| `CAPABILITIES.SERVICE_DISCOVERY` | token     | Registered by the plugin, resolved by consumers; asserted in the integration test                                                               |
| `IDnsResolver`                   | interface | Type of `IRuntimeServices.dns?`; implemented by both runtime resolvers; consumed by `DnsProvider` (§3.9)                                        |
| `SrvRecord`                      | interface | Return element of `resolveSrv`; its `host`/`priority`/`weight` are read by `DnsProvider`'s tier filter and weight mapping (§3.10, §3.11)        |
| `IRuntimeServices.dns?`          | field     | Read by `DnsProvider` at `register()` and per `resolve()`; supplied by three runtime adapters, omitted by the Workers adapter                   |
| `ILifecycleApi.onStopping`       | method    | Called by the plugin's deregistration hook; invoked by `Application.#doStop()` via `LifecycleManager.runStopping()` (§3.16)                     |

New in `@hono-enterprise/runtime`:

| Exported symbol         | Kind     | Consumer / real code path that READS it                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `createNodeDnsResolver` | function | Wired into the Node and Bun runtime adapters' `mergeRuntimeServices` call; unit-tested directly |
| `createDenoDnsResolver` | function | Wired into the Deno runtime adapter over the `DenoHost` seam; unit-tested directly              |

New in `@hono-enterprise/service-discovery-plugin` (`src/index.ts`):

| Exported symbol                     | Kind      | Consumer / real code path that READS it                                                                                          |
| ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceDiscoveryPlugin`            | function  | The application's `plugins: [...]` array; integration, self-registration, and e2e tests                                          |
| `ServiceDiscoveryPluginOptions`     | type      | The union the app's option literal is checked against; narrowed by `createProvider`                                              |
| `StaticDiscoveryOptions`            | interface | The `'static'` arm; read by `createProvider` and `StaticProvider`'s constructor                                                  |
| `ConsulDiscoveryOptions`            | interface | The `'consul'` arm; read by `createProvider` and `ConsulProvider`'s constructor                                                  |
| `KubernetesDiscoveryOptions`        | interface | The `'kubernetes'` arm; read by `createProvider` and `KubernetesProvider`'s constructor                                          |
| `DnsDiscoveryOptions`               | interface | The `'dns'` arm; read by `createProvider` and `DnsProvider`'s constructor                                                        |
| `CustomDiscoveryOptions`            | interface | The `'custom'` arm; its `provider` field is returned directly by `createProvider`                                                |
| `StaticServiceDefinition`           | interface | Element type of `StaticDiscoveryOptions.services[name]`; read by `StaticProvider` when synthesizing `id`                         |
| `EjectionOptions`                   | interface | Read by `EjectionTracker`'s constructor; every field drives a branch in §3.14                                                    |
| `SelfRegistration`                  | interface | Read by the `onBootstrap`/`onStopping` hooks and by `ConsulProvider.registerSelf` when building the `PUT` body                   |
| `SelfRegistrationCheck`             | interface | Field of `SelfRegistration`; read by `ConsulProvider.registerSelf` to build the `Check` object (§3.15)                           |
| `DiscoveryProvider`                 | interface | Implemented by all four built-in providers; the `'custom'` arm's contract; the service's only dependency                         |
| `StaticProvider`                    | class     | Constructed by `createProvider`'s `'static'` overload; asserted in `provider-factory.test.ts`                                    |
| `ConsulProvider`                    | class     | Constructed by `createProvider`'s `'consul'` overload; drives the e2e loopback round trip                                        |
| `KubernetesProvider`                | class     | Constructed by `createProvider`'s `'kubernetes'` overload                                                                        |
| `DnsProvider`                       | class     | Constructed by `createProvider`'s `'dns'` overload                                                                               |
| `IDiscoveryHttp`                    | interface | Constructor parameter of the Consul and Kubernetes providers; the `http` option's type                                           |
| `DiscoveryHttpResponse`             | interface | Return type of `IDiscoveryHttp.request`; its `headers` is read by the Consul blocking loop (§3.12)                               |
| `DiscoveryHttpStream`               | interface | Return type of `IDiscoveryHttp.stream`; its `body` is read by the Kubernetes watch reader (§3.13)                                |
| `createDefaultDiscoveryHttp`        | function  | The default when `http` is omitted (`createProvider`); exercised over real `fetch` in the e2e                                    |
| `DiscoveryUnavailableError`         | class     | Thrown on a cold provider failure (§3.4), the Kubernetes multi-port branch (§3.17), and the missing-`runtime.dns` branch (§3.11) |
| `SelfRegistrationNotSupportedError` | class     | Thrown during `register()` for every arm except `'consul'` when `selfRegistration` is set (§3.8)                                 |

`ServiceDiscoveryService`, `EjectionTracker`, `createLoadBalancer`, `instanceUrl`, and the two watch
loops are deliberately **not** exported: consumers resolve the capability token and type it as
`IServiceDiscovery` (§3.1), so exporting the implementations would publish internals in violation of
AI_GUIDELINES §1.6.

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                             | Behavior (per implementation)                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`                        | `createProvider`                                     | Discriminant; selects the arm. No default — always explicit.                                                                                                                                                                               |
| `cacheTtlMs`                      | `ServiceDiscoveryService.resolve`                    | Default `30_000`; `0` disables caching so every `resolve` hits the provider. All five arms.                                                                                                                                                |
| `strategy`                        | `createLoadBalancer`, `ServiceDiscoveryService.pick` | Default `'round-robin'`. All five arms; overridable per call via `PickOptions.strategy`.                                                                                                                                                   |
| `ejection`                        | `EjectionTracker`                                    | Default `{ failureThreshold: 5, windowMs: 30_000, durationMs: 30_000, maxEjectionPercent: 50 }`; `false` disables (§3.14). All five arms — it operates on `report()` calls, not on provider data.                                          |
| `watchIntervalMs`                 | `DnsProvider.watch`, `StaticProvider.watch`          | Default `30_000`. Read **only** by the two providers with no push channel; the Consul and Kubernetes arms ignore it because their watches are push-based, and the option is absent from their arms' types rather than silently unread.     |
| `selfRegistration`                | `onBootstrap`/`onStopping` hooks                     | Consul: register at bootstrap, deregister at stopping. Every other arm: `SelfRegistrationNotSupportedError` at `register()`. Custom: passed to the provider when it implements `registerSelf`, otherwise the same throw.                   |
| `selfRegistration.check`          | `ConsulProvider.registerSelf`                        | Defaults to `{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }`; not disable-able (§3.15). Becomes Consul's `Check.HTTP`/`Interval`/`DeregisterCriticalServiceAfter`.                                               |
| `selfRegistration.drainDelayMs`   | the `onStopping` hook                                | Default `0`. Awaited after a successful deregistration, while the app is still serving, so propagation completes before draining begins (§3.16).                                                                                           |
| `services` (static arm)           | `StaticProvider.resolve`                             | `Record<string, readonly StaticServiceDefinition[]>`. An unknown name resolves to `[]`, never a throw. `watch()` fires once with the literal list and never again — the list is immutable by construction, stated in JSDoc and the README. |
| `address` (consul arm)            | `ConsulProvider`                                     | Base URL of the agent, e.g. `http://127.0.0.1:8500`. Required by the type.                                                                                                                                                                 |
| `token` (consul arm)              | `ConsulProvider`                                     | Sent as `X-Consul-Token` when present; the header key is omitted entirely otherwise (`exactOptionalPropertyTypes` — omit, never assign `undefined`).                                                                                       |
| `datacenter` (consul arm)         | `ConsulProvider.resolve`, the watch loop             | Appended as `?dc=` alongside `passing=true` when present.                                                                                                                                                                                  |
| `waitSeconds` (consul arm)        | `ConsulProvider.watch`                               | Default `30`. The blocking query's `wait` parameter; bounded to `600` by the type's documentation and clamped in code, since Consul's maximum is 10 minutes (§1).                                                                          |
| `secure` (consul arm)             | `ConsulProvider`                                     | Default `false`; sets `ServiceInstance.secure`, which `instanceUrl` turns into the `https` scheme. Consul carries no scheme information, so this is app-supplied.                                                                          |
| `namespace` (kubernetes arm)      | `KubernetesProvider`                                 | Path segment of the EndpointSlice list and watch URLs. Required by the type.                                                                                                                                                               |
| `apiServer` (kubernetes arm)      | `KubernetesProvider`                                 | Overrides the `KUBERNETES_SERVICE_HOST`/`_PORT` default; absent both, `register()` throws (§3.5).                                                                                                                                          |
| `token` (kubernetes arm)          | `KubernetesProvider`                                 | Used verbatim as the bearer token, skipping the file read entirely — the Workers-portable path (§3.5).                                                                                                                                     |
| `portName` (kubernetes arm)       | `KubernetesProvider.resolve`                         | Selects the `ports[]` entry by `name`; unset with one port uses it, unset with several throws (§3.17).                                                                                                                                     |
| `secure` (kubernetes arm)         | `KubernetesProvider.resolve`                         | Default `false`; sets `ServiceInstance.secure` as above.                                                                                                                                                                                   |
| `mode` (dns arm)                  | `DnsProvider.resolve`                                | `'srv'` uses `resolveSrv` with priority-tier filtering; `'a'` uses `resolveHost` (§3.11).                                                                                                                                                  |
| `domainTemplate` (dns arm)        | `DnsProvider.resolve`                                | Default `'{service}.service.consul'`; `{service}` is substituted with the requested name.                                                                                                                                                  |
| `port` (dns arm, `'a'` mode only) | `DnsProvider.resolve`                                | Mandatory on the `'a'` arm and absent from the `'srv'` arm — DNS A records carry no port, and SRV records supply their own (§3.11).                                                                                                        |
| `secure` (dns arm)                | `DnsProvider.resolve`                                | Default `false`; sets `ServiceInstance.secure` as above.                                                                                                                                                                                   |
| `http` (consul + kubernetes arms) | `createProvider`                                     | Overrides `createDefaultDiscoveryHttp()`. The seam every HTTP provider unit test drives.                                                                                                                                                   |
| `provider` object (custom arm)    | `createProvider`                                     | Returned as-is; the app's own `DiscoveryProvider`.                                                                                                                                                                                         |

## 5. Implementation files

| File                                                                                       | Purpose                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/service-discovery.ts`                                        | `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`, `IServiceDiscovery` (C3)                                                                              |
| `packages/common/src/runtime.ts`                                                           | Edit: `SrvRecord`, `IDnsResolver`, `IRuntimeServices.dns?` (C4)                                                                                                                  |
| `packages/common/src/plugin.ts`                                                            | Edit: `ILifecycleApi.onStopping` (C5)                                                                                                                                            |
| `packages/common/src/tokens.ts`                                                            | Edit: `SERVICE_DISCOVERY: 'service-discovery'`                                                                                                                                   |
| `packages/common/src/index.ts`                                                             | Edit: re-export the new types                                                                                                                                                    |
| `packages/kernel/src/lifecycle/lifecycle-manager.ts`                                       | Edit: `#stopping` array, `onStopping`, LIFO `runStopping()`                                                                                                                      |
| `packages/kernel/src/application/application.ts`                                           | Edit: `await this.#lifecycle.runStopping()` as `#doStop`'s first statement, plus the comment correction (§3.16)                                                                  |
| `packages/runtime/src/adapters/shared/node-dns-resolver.ts`                                | `createNodeDnsResolver` over static `node:dns/promises` imports (§3.9, §3.10)                                                                                                    |
| `packages/runtime/src/adapters/deno/deno-dns-resolver.ts`                                  | `createDenoDnsResolver` over the `DenoHost` seam (§3.9, §3.10)                                                                                                                   |
| `packages/runtime/src/services/cross-runtime.ts`                                           | Edit: widen the `Pick` with `'dns'`                                                                                                                                              |
| `packages/runtime/src/adapters/{node,bun,deno}/*-runtime.ts`                               | Edit ×3: supply `dns`; the Deno adapter also adds `resolveDns` to `DenoHost`                                                                                                     |
| `packages/runtime/src/index.ts`                                                            | Edit: export both resolver factories                                                                                                                                             |
| `packages/service-discovery-plugin/deno.json`                                              | Manifest at `0.1.0-alpha.3`; `exports: './src/index.ts'`; `test.permissions.net: true` for the e2e (§6)                                                                          |
| `packages/service-discovery-plugin/README.md`                                              | Package README: the resilience composition recipe (§3.14), the k8s CA note (§8), per-provider `watch` semantics                                                                  |
| `src/index.ts`                                                                             | Barrel exports (§4)                                                                                                                                                              |
| `src/options.ts`                                                                           | The option union and its arms; `resolveOptions` applying every default in §4.1                                                                                                   |
| `src/errors.ts`                                                                            | `DiscoveryUnavailableError`, `SelfRegistrationNotSupportedError`                                                                                                                 |
| `src/interfaces/index.ts`                                                                  | `DiscoveryProvider`, `IDiscoveryHttp`, `DiscoveryHttpResponse`, `DiscoveryHttpStream`, `SelfRegistration`, `SelfRegistrationCheck`, `StaticServiceDefinition`, `EjectionOptions` |
| `src/http/default-http.ts`                                                                 | `createDefaultDiscoveryHttp` — both `request` and `stream` (§3.3)                                                                                                                |
| `src/http/ndjson.ts`                                                                       | `readJsonLines(stream, signal)` async generator — the chunk-boundary-safe line reader (§3.13)                                                                                    |
| `src/plugin/service-discovery-plugin.ts`                                                   | `ServiceDiscoveryPlugin` — async `register()`, token registration, health indicator, bootstrap/stopping/close hooks                                                              |
| `src/services/service-discovery-service.ts`                                                | `ServiceDiscoveryService` — cache, coalescing, stale-on-failure, `resolve`/`pick`/`resolveUrl`/`report`/`watch` (§3.2, §3.4)                                                     |
| `src/services/ejection-tracker.ts`                                                         | `EjectionTracker` — rolling window, panic cap, expiry (§3.14)                                                                                                                    |
| `src/balancer/load-balancer.ts`                                                            | `createLoadBalancer` — three strategies over `runtime.randomBytes` (§3.6)                                                                                                        |
| `src/url/instance-url.ts`                                                                  | `instanceUrl` — scheme, IPv6 bracketing, path join (§3.7)                                                                                                                        |
| `src/providers/provider-factory.ts`                                                        | `createProvider`, overloaded per arm (§3.8)                                                                                                                                      |
| `src/providers/static-provider.ts`                                                         | `StaticProvider`                                                                                                                                                                 |
| `src/providers/consul-provider.ts`                                                         | `ConsulProvider` — `resolve`, `registerSelf`, `deregisterSelf`, response mapping (§3.17)                                                                                         |
| `src/providers/consul-watch.ts`                                                            | The blocking-query loop with both index hazards handled (§3.12)                                                                                                                  |
| `src/providers/kubernetes-provider.ts`                                                     | `KubernetesProvider` — token resolution (§3.5), EndpointSlice mapping (§3.17)                                                                                                    |
| `src/providers/kubernetes-watch.ts`                                                        | The watch stream, bookmark handling, and `410 Gone` resync (§3.13)                                                                                                               |
| `src/providers/dns-provider.ts`                                                            | `DnsProvider` — SRV tiers, A mode, poll-based `watch` (§3.11)                                                                                                                    |
| `deno.json` (root)                                                                         | Edit: add the workspace member                                                                                                                                                   |
| `scripts/release-packages.ts`                                                              | Edit: add `'packages/service-discovery-plugin'` to Tier 4 (alphabetical, after `secrets-plugin`)                                                                                 |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, `CHANGELOG.md`, `CLAUDE.md` | The C1–C5 deliverables, the M50 ROADMAP section + Progress Tracking row 50, and the status flip                                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

`src/interfaces/index.ts` is type-only (no executable statements) and is the one file with no
dedicated test; every symbol in it is type-checked by the files that implement it. There is **no
guarded real-import test** because the package has no npm dependency at all (§3.3) — the equivalent
"exercise the real path once" obligation is discharged by the e2e's real-`fetch` loopback round
trips over both the buffered and the streaming seam.

| Test file                                                    | src covered                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/options.test.ts`                                  | `src/options.ts`                                         | Every default in §4.1 is applied; an explicit `cacheTtlMs: 0` survives (not coerced by `??`); `ejection: false` survives; an explicit `check` is used verbatim; `waitSeconds` above 600 is clamped.                                                                                                                                                                                                                                                                |
| `test/unit/errors.test.ts`                                   | `src/errors.ts`                                          | Both errors are `instanceof Error`, carry their `name`, and `DiscoveryUnavailableError` preserves `cause`.                                                                                                                                                                                                                                                                                                                                                         |
| `test/unit/default-http.test.ts`                             | `src/http/default-http.ts`                               | `request` passes method/headers/body through and maps `{ ok, status, headers, text }`; a non-2xx maps `ok: false` without throwing; `stream` exposes `body` and yields `null` for a bodiless response; an `AbortSignal` reaches `fetchImpl`.                                                                                                                                                                                                                       |
| `test/unit/ndjson.test.ts`                                   | `src/http/ndjson.ts`                                     | One object split across two chunks; several objects in one chunk; a trailing partial line at end-of-stream is discarded; an aborted signal ends the generator.                                                                                                                                                                                                                                                                                                     |
| `test/unit/instance-url.test.ts`                             | `src/url/instance-url.ts`                                | Six literal input→output pairs (§3.7), expected strings written out in full.                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/load-balancer.test.ts`                            | `src/balancer/load-balancer.ts`                          | Cursor advance and wrap; cursor when the list shrinks between picks; `random` at both `randomBytes` extremes; `weighted-random` in each bucket; all-non-positive-weight fallback; `null` on empty. Drives `createLoadBalancer(strategy, runtime)` with a fake `IRuntimeServices`.                                                                                                                                                                                  |
| `test/unit/ejection-tracker.test.ts`                         | `src/services/ejection-tracker.ts`                       | The six cases in §3.14, all on a fake monotonic clock.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/service-discovery-service.test.ts`                | `src/services/service-discovery-service.ts`              | The six cache cases in §3.4 (a–f); the three dual-entry-point cases in §3.2; `pick` filters ejected while `resolve` does not; the all-ejected fallback; `pick` on an empty list returns `null` and `resolveUrl` returns `null`; `watch` forwards the provider's unsubscribe.                                                                                                                                                                                       |
| `test/unit/static-provider.test.ts`                          | `src/providers/static-provider.ts`                       | Known name returns the configured instances with `serviceName` stamped and `id` synthesized when omitted; a supplied `id` wins; unknown name returns `[]`; `watch` fires once and never again; `registerSelf` is absent on the instance.                                                                                                                                                                                                                           |
| `test/unit/consul-provider.test.ts`                          | `src/providers/consul-provider.ts`                       | URL is `/v1/health/service/<name>?passing=true` (+`dc=` when set); `X-Consul-Token` present when configured and the header key absent when not; the empty-`Service.Address` fallback and the populated-wins case; `Weights.Passing` maps to `weight`; a non-`ok` response rejects; `registerSelf` body carries `ID`/`Name`/`Address`/`Port`/`Tags`/`Meta`/`Check` with the default check values; `deregisterSelf` targets `PUT /v1/agent/service/deregister/<id>`. |
| `test/unit/consul-watch.test.ts`                             | `src/providers/consul-watch.ts`                          | The six blocking-query cases in §3.12, against a scripted fake `IDiscoveryHttp`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/kubernetes-provider.test.ts`                      | `src/providers/kubernetes-provider.ts`                   | The token cases in §3.5 and the mapping cases in §3.17; the `labelSelector` query string is asserted exactly.                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/kubernetes-watch.test.ts`                         | `src/providers/kubernetes-watch.ts`                      | The five watch-stream cases in §3.13, against a fake `stream` feeding a scripted `ReadableStream`.                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/dns-provider.test.ts`                             | `src/providers/dns-provider.ts`                          | The seven cases in §3.11, against a fake `IDnsResolver`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/provider-factory.test.ts`                         | `src/providers/provider-factory.ts`                      | Each of the five arms yields the expected concrete provider; the `http` option overrides the default seam; the `'custom'` arm returns the supplied object identically (`toBe`).                                                                                                                                                                                                                                                                                    |
| `test/integration/plugin-registration.test.ts`               | `src/plugin/service-discovery-plugin.ts`, `src/index.ts` | Through a real `createApplication` + `RuntimePlugin`: the token resolves and is typed `IServiceDiscovery`; all five methods work; the health indicator reports `'up'` then `'degraded'`; `onClose` unsubscribes an active watch; `SelfRegistrationNotSupportedError` for the non-Consul arms; the two Kubernetes `register()` throws; the missing-`runtime.dns` throw.                                                                                             |
| `test/integration/self-registration.test.ts`                 | `src/plugin/service-discovery-plugin.ts`                 | With a fake `IDiscoveryHttp`: register fires during `start()` with the default `Check`; deregister fires during `stop()`; `drainDelayMs` is awaited after it; a rejecting deregistration still lets `stop()` resolve (§3.16).                                                                                                                                                                                                                                      |
| `test/e2e/service-discovery-e2e.test.ts`                     | end-to-end, real `fetch`                                 | A real kernel app on an ephemeral loopback port serves `/v1/health/service/billing` as a Consul agent would; a second app registers the plugin with the **default** `createDefaultDiscoveryHttp()`, and `resolveUrl('billing', '/invoices')` returns the advertised address. A second case runs the full ejection loop over real sockets (§3.14). Requires `test.permissions.net: true`.                                                                           |
| `packages/runtime/test/unit/node-dns-resolver.test.ts`       | `src/adapters/shared/node-dns-resolver.ts`               | `name → host` normalization; A/AAAA concatenation; one-family-fails tolerance; both-fail rejection (§3.9, §3.10).                                                                                                                                                                                                                                                                                                                                                  |
| `packages/runtime/test/unit/deno-dns-resolver.test.ts`       | `src/adapters/deno/deno-dns-resolver.ts`                 | `target → host` normalization and the same three cases, against a fake `DenoHost.resolveDns`.                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/runtime/test/unit/cf-runtime.test.ts` (edit)       | `src/adapters/workers/cf-runtime.ts`                     | Adds `expect('dns' in services).toBe(false)` — asserting **absence of the key**, not an `undefined` value (§3.9).                                                                                                                                                                                                                                                                                                                                                  |
| `packages/kernel/test/unit/lifecycle-manager.test.ts` (edit) | `src/lifecycle/lifecycle-manager.ts`                     | `onStopping` hooks run LIFO; `runStopping()` over an empty array resolves.                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/test/integration/application-stop.test.ts`  | `src/application/application.ts`                         | An `onStopping` hook runs **before** a concurrently-arriving request receives its 503 (proving the hook precedes `#stopping = true`); `stop()` with no hooks behaves exactly as before; a hook that rejects surfaces from `stop()` (§3.16).                                                                                                                                                                                                                        |

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

Coverage is re-read per file for `packages/kernel` and `packages/runtime` as well, not just the new
package — §3.9 and §3.16 add branches to both, and an aggregate green run hides a regression in an
untouched file.

## 8. Risks & mitigations

- **This milestone touches four packages** (`common`, `kernel`, `runtime`, and the new plugin),
  which strains AI_GUIDELINES §8.4's one-package-per-milestone rule. Mitigation: the precedent
  exists (M42 spanned `common`/`kernel`/`runtime`/`cache-plugin`; M47 spanned `common`, two plugins,
  and a new package), the two out-of-package changes are each a single additive seam with its own
  tests, and both are flagged for approval as C4 and C5 rather than slipped in.
- **`onStopping` changes when `stop()` starts refusing requests.** A hook that hangs delays the
  entire shutdown, and one that rejects now surfaces from `stop()`. Mitigation: `runStopping()` over
  an empty array is a no-op, so no existing application changes behavior; the plugin's own hook
  swallows deregistration failures (§3.16); the kernel integration test pins both the new ordering
  and the unchanged no-hook path.
- **The Kubernetes API server presents a cluster-internal CA that `fetch` will reject.** In-cluster,
  Deno needs `DENO_CERT` and Node needs `NODE_EXTRA_CA_CERTS` pointed at
  `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`. No code change fixes this from inside the
  process. Mitigation: state it in the package README beside the `KubernetesProvider` example and in
  M39's manifest env block; the `http` option is the documented escape hatch for a caller-supplied
  TLS-configured client.
- **A watch loop that reconnects tightly against a failing server becomes a request flood.**
  Mitigation: the Consul loop's exponential backoff to a 5 s ceiling (§3.12) and the Kubernetes
  restart path's reuse of the same backoff are both asserted by tests that script consecutive
  failures.
- **Ejection can amplify a correlated failure into a total outage.** Mitigation:
  `maxEjectionPercent` caps concurrent ejections and the all-ejected fallback serves the unfiltered
  list (§3.14); both have dedicated tests, because this is the failure mode that only appears under
  real correlated load.
- **`StaticProvider` has no health signal.** Mitigation: ejection (§3.14) now covers it — a static
  deployment gets failover from `report()` calls, which is precisely why ejection was folded into
  this milestone rather than deferred. The README says so and shows the loop.
- **The e2e binds real sockets, and CI runners occasionally refuse ephemeral ports.** Mitigation:
  bind with port `0` and read the assigned port from the returned handle rather than hard-coding one
  — the M46 websocket e2e precedent.
- **`common` gains a new file, a new token, and two widenings — a public API change.** Mitigation:
  PUBLIC_API.md is updated in the same PR (C3–C5); every addition is purely additive with no
  existing signature changed; nothing implements `IServiceDiscovery` or `IDnsResolver` today, and
  the only in-repo implementor of `ILifecycleApi` is the kernel's own `LifecycleManager`.

## 9. Out of scope

- **Wiring discovery into `packages/sdk` or M49's gRPC client.** M35 owns the SDK's `baseUrl`
  (`packages/sdk/src/http/contracts.ts:152`) and M49 owns the gRPC client story; a discovery-aware
  client is a change to those packages, and neither may import this plugin (AI_GUIDELINES §3.3).
  This is milestone ownership, not a deferred piece of this capability — the composition recipe in
  the README works today via `resolveUrl`.
- **Cluster-wide ejection state.** Ejection is per-process (§3.14). Sharing it would run over
  `CAPABILITIES.REALTIME_BACKPLANE` (M47) and is a distributed-consensus problem, not a discovery
  one.
- **Docker/Kubernetes/Consul manifests and a compose stack** that would exercise this against a real
  cluster. M39.
- **Reconciling the ARCHITECTURE §8 package diagram with all 10 missing workspace members.** M38
  (C1).
