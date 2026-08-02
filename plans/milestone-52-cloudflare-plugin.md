# Milestone 52 — Cloudflare Workers Plugin (`@hono-enterprise/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m52-cloudflare-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Cloudflare Workers has been a _serving_ target since M23 — the fetch adapter, the WebSocket
upgrader, and the RPC interceptor all work there — but the framework cannot reach a single
Cloudflare **platform binding**.
`grep -rn "waitUntil\|KVNamespace\|D1Database\|R2Bucket\|
DurableObject\|cloudflare:workers" packages/*/src docs/*.md`
returns **nothing**, and the Workers runtime adapter hands back an empty `env` (`cf-runtime.ts:44`),
so on Workers `ConfigPlugin` reads no variables, `SecretsPlugin`'s `EnvProvider` resolves nothing,
and every stateful capability (cache, storage, sessions) has no backend that exists on the edge. M52
closes the access gap: it adds a `CloudflarePlugin` that publishes the Worker's bindings as a
first-class capability, wires the two bindings whose committed `common` ports it can satisfy today
(KV → `ICacheStore`, R2 → `IStorage`), ships a KV `ISessionStore` for `SessionPlugin`, exposes
`waitUntil` for post-response work, and repairs the runtime adapter so `runtime.env` is populated
(and holds only strings) on Workers.

- **In scope:** a new `packages/cloudflare-plugin` (`CloudflarePlugin`, `ICloudflareBindings` under
  a new `CAPABILITIES.CLOUDFLARE` token, zero-dependency structural binding facades, `KvCacheStore`,
  `R2Storage`, `KvSessionStore`, `waitUntil` seam, a `cloudflare` health indicator); a
  `packages/runtime` `env` passthrough plus a string-filtering fix in the Workers adapter; a
  `packages/common` token addition; a `packages/cli` Workers-template correction; and the doc /
  release-registration deliverables in §2 and §5.2.
- **NOT this milestone:** D1, Queues, Cron Triggers, Durable Objects, the Cache API response cache,
  Hyperdrive, Vectorize, Workers AI, and Analytics Engine — all owned by **M52b**, registered in the
  ROADMAP by this PR (see §9 for the per-item reason each is deferred rather than squeezed in).

## 1. Contracts verified from SOURCE (not names)

### 1.1 In-repo contracts

| Reference                                | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ICacheStore`                            | `packages/common/src/services/cache.ts:19`                                                              | `get<T>`, `set<T>(key, value, ttlSeconds?)`, `delete`, `has`, `clear` — exactly five methods, all async, `ttlSeconds` unbounded below                                                                                                     |
| `IStorage`                               | `packages/common/src/services/storage.ts:29`                                                            | `put(path, Uint8Array)`, `get(path): Promise<Uint8Array>`, `delete`, `exists`, `getSignedUrl(path, options)`; `getStream?` is **optional** at `:82`                                                                                       |
| `SignedUrlOptions`                       | `packages/common/src/services/storage.ts:13`                                                            | The options bag `getSignedUrl` takes; there is no "unsupported" return value, so a provider that cannot presign must throw                                                                                                                |
| `ISessionStore`                          | `packages/common/src/services/session.ts:152`                                                           | `read(id)`, `write(id, data, ttlMs)` — TTL in **milliseconds** — `destroy(id)`, optional reachability probe at `:176`                                                                                                                     |
| `SessionPluginOptions.store`             | `packages/session-plugin/src/options.ts:103`                                                            | `'memory' \| 'cache' \| ISessionStore` — a custom store is accepted, so a KV store needs **no** session-plugin change                                                                                                                     |
| `IRuntimeServices`                       | `packages/common/src/runtime.ts:233`                                                                    | `platform/version/hostname/uuid/randomBytes/subtle/now/hrtime/timers/env/fs?/workers?/dns?`                                                                                                                                               |
| `IRuntimeServices.env`                   | `packages/common/src/runtime.ts:320`                                                                    | Typed `Readonly<Record<string, string \| undefined>>`; the JSDoc at `:315` claims the Workers adapter "materializes" it                                                                                                                   |
| `createCloudflareRuntimeServices`        | `packages/runtime/src/adapters/workers/cf-runtime.ts:44,52`                                             | Defaults `envSource` to `{}` and casts it to the string record with a comment conceding bindings are objects — so today `runtime.env` on Workers is **empty**, and any injected env would smuggle objects through a string-typed contract |
| `createRuntimeServices`                  | `packages/runtime/src/adapters/shared/runtime-services-factory.ts:102`                                  | `(options?: { platform?, adapters? })` — has **no** `env` parameter, and calls `factory()` with no arguments at `:112`, which is why the CF factory's own `env` option is unreachable through the plugin                                  |
| `RuntimePlugin`                          | `packages/runtime/src/plugin/runtime-plugin.ts`                                                         | `register()` builds services through `createRuntimeServices({ platform })`; `RuntimeOptions` carries `platform`/`adapters`/`httpAdapters` and no `env`                                                                                    |
| `IHttpAdapter`                           | `packages/common/src/runtime.ts:357`                                                                    | `setHandler`, `fetch(request)`, `listen`, `close`, optional `setUpgradeRouter?`/`setRpcHandler?`                                                                                                                                          |
| `IApplication.fetch`                     | `packages/common/src/plugin.ts:447`                                                                     | `fetch(request: Request): Promise<Response>` — **one** parameter, so the Workers `(request, env, ctx)` triple cannot reach the app through it                                                                                             |
| `CloudflareWorkersHttpAdapter`           | `packages/runtime/src/adapters/workers/cf-http-adapter.ts:163`                                          | `listen` throws by design; `fetch` works without `start({port})`                                                                                                                                                                          |
| `IOrmAdapter`                            | `packages/common/src/services/database.ts:33`                                                           | Lifecycle only: `connect`/`disconnect`/`isReady`/`beginTransaction`. No query surface                                                                                                                                                     |
| `IDatabaseAdapter`                       | `packages/database-plugin/src/adapters/adapter.ts:51`                                                   | The actual data-access seam, declared **inside database-plugin** and not exported from `common` — a D1 adapter in a separate package would have to import another plugin (forbidden by AI_GUIDELINES §2.2/§3.3)                           |
| `IQueue`                                 | `packages/common/src/services/queue.ts:79`                                                              | `add`, `process(name, processor, options)` — a **pull/registration** model — and `addRecurring`                                                                                                                                           |
| `CAPABILITIES` / `createCapabilityToken` | `packages/common/src/tokens.ts`                                                                         | No `CLOUDFLARE` token exists; grammar is lowercase kebab-case segments joined by dots, colons illegal — `'cloudflare'` is valid                                                                                                           |
| Duplicate-provider behaviour             | `packages/kernel/src/registry/plugin-resolver.ts:127`                                                   | A plugin implicitly provides its own name plus every `provides` token; the index rejects a second provider of the same token at startup                                                                                                   |
| Named-instance precedent                 | `packages/cache-plugin/src/plugin/cache-plugin.ts:67`                                                   | Derives `cache.<name>` through `createCapabilityToken` when the instance is not `'default'`                                                                                                                                               |
| `IHealthApi.register`                    | `packages/common/src/plugin.ts:192`                                                                     | `register(name, indicator)`                                                                                                                                                                                                               |
| `PLUGIN_PRIORITY`                        | `packages/common/src/types.ts:80`                                                                       | `HIGHEST 0`, `HIGH 100`, `NORMAL 500`, `OPENAPI 700`, `LOW 900`, `LOWEST 1000`                                                                                                                                                            |
| CLI Workers scaffold                     | `packages/cli/src/commands/new.ts:550`                                                                  | Emits `wrangler.toml` with `compatibility_date = "2024-09-23"` and `src/index.ts` from `workersEntry()`; no binding stanza, no `env` wiring                                                                                               |
| Optional-member widening precedent       | `common` `fs?` (M44), `workers?` (M45), `setUpgradeRouter?` (M46), `setRpcHandler?` (M49), `dns?` (M50) | The established shape for a capability one runtime has and another does not                                                                                                                                                               |

### 1.2 Cloudflare platform facts (checked against current docs, not memory)

| Fact                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                               | Consequence for this design                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { env } from 'cloudflare:workers'` gives module-scope access to bindings                                                                                                                                                                                                                                                             | [Workers bindings docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/)                            | The app can hand `env` to plugin factories at composition time; no `IApplication.fetch` widening is needed to reach bindings                                                     |
| Top-level scope may **hold** bindings but may not perform I/O with them — "KV store calls, Durable Object method calls, and service-to-service calls will NOT work" outside a request                                                                                                                                                        | same                                                                                                                 | The plugin may capture binding objects at `register()`; every store method must be called only from within a request. §3.6 pins this                                             |
| `import { waitUntil } from 'cloudflare:workers'` exists, shipped **2025-08-08**                                                                                                                                                                                                                                                              | [changelog 2025-08-08](https://developers.cloudflare.com/changelog/post/2025-08-08-add-waituntil-cloudflare-workers) | Post-response work needs no `ExecutionContext` threading; but it postdates the CLI's scaffolded compatibility date (conflict C3)                                                 |
| `ctx.waitUntil` extends the invocation up to **30 s** after it ends, shared across all calls in one request                                                                                                                                                                                                                                  | [Context (ctx)](https://developers.cloudflare.com/workers/runtime-apis/context/)                                     | Documented as a budget in the `waitUntil` JSDoc; the plugin does not police it                                                                                                   |
| KV `put(key, value, { expiration?, expirationTtl?, metadata? })`; **minimum `expirationTtl` is 60 seconds**; key ≤ 512 B, value ≤ 25 MiB, metadata ≤ 1024 B                                                                                                                                                                                  | [KV write](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)                                          | `ICacheStore.set` accepts any TTL, so sub-60 s TTLs cannot be expressed physically. §3.4 resolves this with a logical-expiry envelope                                            |
| KV `list({ prefix?, limit?, cursor? })` → `{ keys, list_complete, cursor }`; limit default **and maximum** 1000                                                                                                                                                                                                                              | [KV list](https://developers.cloudflare.com/kv/api/list-keys/)                                                       | `ICacheStore.clear()` is a paginated list-then-delete sweep, one `delete` per key — no bulk delete exists on the binding                                                         |
| R2: `head`, `get(key, opts) → R2ObjectBody \| R2Object \| null`, `put`, `delete(key \| key[])` (≤1000 keys), `list() → { objects, truncated, cursor, delimitedPrefixes }`; `R2ObjectBody` exposes `body: ReadableStream` plus `arrayBuffer/text/json/blob`; `R2Object` carries `key/size/etag/httpEtag/uploaded/httpMetadata/customMetadata` | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)                            | `IStorage.get` maps to `arrayBuffer()`, `getStream` maps to `body`, `exists` maps to `head`. **No presigned-URL capability exists on the binding**, so `getSignedUrl` must throw |
| D1 exposes `prepare/bind/run/all/first/raw` and `batch`; no explicit `BEGIN`/`COMMIT` on the binding                                                                                                                                                                                                                                         | [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)                       | Combined with the internal `IDatabaseAdapter` finding above, D1 is deferred to M52b as a **contract** decision, not an implementation gap                                        |
| Queues: producer `send(body, { contentType?, delaySeconds? })` / `sendBatch`; a consumer **must export a `queue(batch, env, ctx)` handler** and there is no pull/poll API                                                                                                                                                                    | [Queues JS APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)                            | `IQueue.process()` is a registration/pull model that cannot be satisfied without a new module-level export contract → M52b                                                       |
| Cron: `scheduled(controller, env, ctx)`; schedules are declared in wrangler config only, with no runtime registration                                                                                                                                                                                                                        | [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)                      | `IScheduler` registers jobs at runtime, so a Workers scheduler needs the same module-export bridge as Queues → M52b                                                              |
| Cache API: `caches.default` / `caches.open(name)`, `match/put/delete`; refuses `Set-Cookie`, `206`, `Vary: *`, non-GET; per-datacenter, and does not work in the dashboard editor or Playground                                                                                                                                              | [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)                                           | A response cache has enough of its own rules to be its own deliverable → M52b                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                           | Doc deliverable (same PR)                                                                                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `IRuntimeServices.env` is typed `Record<string, string \| undefined>` (`runtime.ts:320`), while `cf-runtime.ts:52` casts a binding-bearing record into it and says so in a comment. A KV namespace reaching `ConfigPlugin` stringifies to `[object Object]` | The contract wins. The Workers adapter **filters to string values**; non-string bindings are reachable only through `ICloudflareBindings`          | Correct the `cf-runtime.ts` JSDoc/comment, and add the filtering note to the PUBLIC_API runtime `env` row                                         |
| C2 | `runtime.ts:315` claims "the Workers adapter materializes" env, and `runtime-services-factory.ts:89` documents `loadConfig(createRuntimeServices())` as the config-driven-composition path — which on Workers reads an empty record today                   | Add `env` to `CreateRuntimeServicesOptions` and `RuntimeOptions` and thread it to the CF factory; the claim becomes true when the app passes `env` | PUBLIC_API `createRuntimeServices`/`RuntimePlugin` rows gain the `env` option; the ROADMAP config-driven-composition example gains a Workers line |
| C3 | The CLI scaffolds `compatibility_date = "2024-09-23"` (`new.ts:550`), which predates the `waitUntil` export (2025-08-08), so a freshly scaffolded project cannot import it                                                                                  | Bump the scaffolded `compatibility_date` to `2025-09-01`                                                                                           | CLI template change plus a note in the cloudflare-plugin README stating the minimum date and why                                                  |
| C4 | Post-M50 counts in README and the ARCHITECTURE package diagram (43 members / 33 plugins) do not include this package; M51 is in flight on its own branch and moves the same numbers                                                                         | This PR increments whatever the counts read at merge time and re-reads them rather than hard-coding a number computed today                        | README count sentence + ARCHITECTURE package-diagram node for `cloudflare-plugin`                                                                 |
| C5 | Milestone numbering: `ROADMAP.md` on `main` has no M51 rows; M51/M51b live on `feat/m51-graphql-plugin`                                                                                                                                                     | This milestone takes **52**, and its ROADMAP edits append rather than renumber, so a merge after M51 leaves 51/51b intact                          | ROADMAP: new "Milestone 52" and "Milestone 52b" sections plus two Progress-Tracking rows                                                          |

## 3. Design decisions

### 3.1 How the Worker's `env` reaches the framework

- **Decision:** the application imports `env` from `cloudflare:workers` and passes it explicitly —
  `RuntimePlugin({ env })` for string variables, `CloudflarePlugin({ env })` for bindings. No file
  under `packages/` imports `cloudflare:workers`, statically nor dynamically.
- **Why:** `cloudflare:workers` is not a specifier Deno can resolve, so a literal static import
  breaks `deno check` for every other runtime, and a dynamic import through a non-literal specifier
  is the smuggled-loader smell CLAUDE.md bans. Injection is the same call the platform docs
  recommend for testability, it is the M50 `IDiscoveryHttp` inject-only precedent, and it keeps the
  whole package unit-testable with a plain object.
- **Test home:** `test/unit/plugin/cloudflare-plugin.test.ts` (bindings resolved from an injected
  env) and `test/integration/runtime-env.test.ts` (`RuntimePlugin({ env })` populates
  `runtime.env`).

### 3.2 `runtime.env` on Workers, and what happens to object bindings

- **Decision:** `CreateRuntimeServicesOptions` and `RuntimeOptions` gain an optional
  `env?: Readonly<Record<string, unknown>>`; `createRuntimeServices` forwards it to the platform
  factory, and `createCloudflareRuntimeServices` runs it through a pure exported `splitWorkerEnv`
  that returns `{ vars, bindings }`, keeping only `typeof value === 'string'` entries in `vars`.
  `runtime.env` receives `vars`. The three non-Workers factories ignore `env` and keep reading their
  own platform source.
- **Why:** C1 — the committed `env` type promises strings, and `ConfigPlugin` iterates it. A KV
  namespace arriving as `[object Object]` is a silent config corruption that type-checks. Splitting
  in one pure function means the same rule is testable without a Worker.
- **Test home:** `test/unit/adapters/workers/split-worker-env.test.ts` (a record mixing strings,
  objects, numbers and `undefined`) and `test/unit/plugin/runtime-plugin.test.ts`.

### 3.3 Bindings service and its capability token

- **Decision:** a new `CAPABILITIES.CLOUDFLARE = 'cloudflare'` token carrying `ICloudflareBindings`:
  `has(name)`, `get<T>(name)`, `kv(name)`, `r2(name)`, `d1(name)`, `queue(name)`, `service(name)`,
  `durableObject(name)`, `names()`, `vars()`, and `waitUntil(promise)`. Each typed accessor returns
  the binding cast to its structural facade and throws `CloudflareBindingMissingError` (naming the
  binding and listing the names that _are_ present) when absent. Plugin priority is
  `PLUGIN_PRIORITY.HIGH`, so bindings exist before ordinary capability plugins register.
- **Why:** one token, one interface, per the token↔interface rule. The typed accessors exist so a
  consumer never re-casts `unknown`; the throw is chosen over a `null` return because a missing
  binding is a deployment error that should surface at first use with a name in the message rather
  than as a downstream `TypeError`. `d1`, `queue`, `service` and `durableObject` accessors ship in
  M52 even though M52b owns their capability adapters — they are the escape hatch that lets an
  application use those bindings directly today, and each is exercised by a named test.
- **Test home:** `test/unit/bindings/binding-registry.test.ts`.

### 3.4 KV as `ICacheStore` — reconciling an unbounded TTL with KV's 60-second floor

- **Decision:** every value is stored as a JSON envelope `{ v: <value>, e: <epoch-ms | null> }`.
  `set(key, value, ttlSeconds)` computes the logical expiry as `runtime.now() + ttlSeconds * 1000`
  and issues `put` with `expirationTtl = Math.max(60, Math.ceil(ttlSeconds))`; `get`/`has` decode
  the envelope and treat `e !== null && e <= runtime.now()` as a miss, deleting the key on the way
  out. A `set` with no TTL and no configured `defaultTtlSeconds` writes `e: null` and omits
  `expirationTtl` entirely.
- **Why:** KV rejects an `expirationTtl` under 60 (verified, §1.2), so a 5-second cache entry is
  physically inexpressible; without a logical expiry it would stay live for a minute and serve stale
  data. Splitting logical correctness (the envelope) from physical reclamation (KV's own expiry)
  makes short TTLs behave and still lets KV garbage-collect. The envelope is a pure
  `encodeEnvelope`/`decodeEnvelope` pair so both halves are unit-testable without a KV namespace. A
  malformed decode (a key written by something else) is treated as a miss, never a throw.
- **Test home:** `test/unit/stores/kv-envelope.test.ts` (round-trip, floor arithmetic, malformed
  input) and `test/unit/stores/kv-cache-store.test.ts` (a fake KV recording the exact
  `expirationTtl` passed for a 5-second TTL, and a clock advanced past logical expiry).

### 3.5 `ICacheStore.clear()` on KV

- **Decision:** `clear()` pages `list({ prefix, limit: 1000, cursor })` and deletes each returned
  key, looping while `list_complete` is false. When the store is configured with no `prefix`, the
  constructor still accepts it but `clear()` throws `CloudflareUnsupportedError` naming the option.
- **Why:** the binding offers no bulk delete, so `clear()` costs one delete per key and its runtime
  is unbounded — an unprefixed `clear()` on a shared namespace would also delete keys the store does
  not own, including session rows if the namespace is shared. Requiring a prefix makes the
  destructive case impossible to reach by accident, and the throw is the documented behaviour rather
  than silence (the `query()`-on-memory-adapter precedent from the M10 review).
- **Test home:** `test/unit/stores/kv-cache-store.test.ts` — a fake KV returning two pages asserts
  every key from both pages was deleted, plus the unprefixed throw.

### 3.6 Binding I/O never happens at registration time

- **Decision:** `register()` captures binding objects and validates their **shape** (presence, and
  that the expected methods are functions) but performs no call against them. Every network call
  lives inside a store method reached from a request handler. The `cloudflare` health indicator
  likewise performs no binding I/O.
- **Why:** the platform prohibits I/O outside a request context (§1.2), so a probe read at
  `register()` would throw on a real deployment while passing every test against a fake. A KV read
  per health probe would also bill on every liveness check.
- **Test home:** `test/unit/plugin/cloudflare-plugin.test.ts` — a fake KV whose methods throw when
  called asserts `register()` and the indicator both complete.

### 3.7 `waitUntil`

- **Decision:** `CloudflarePluginOptions.waitUntil?: WaitUntilHost` where
  `WaitUntilHost = (promise: Promise<unknown>) => void`. The service method attaches a rejection
  handler (routed to the resolved `ILogger` when one is registered) before delegating, so a
  background failure is reported rather than becoming an unhandled rejection. With no host injected,
  the method attaches the same handler and returns without delegating — on Node, Deno and Bun there
  is no request-scoped lifetime to extend, so the promise simply runs.
- **Why:** the app already imports from `cloudflare:workers` for `env` (§3.1); adding `waitUntil` to
  that import is one word. Silently swallowing a rejection is the failure mode this seam invites, so
  the handler is attached on both paths rather than only the delegating one.
- **Test home:** `test/unit/background/wait-until.test.ts` (host receives the promise; a rejecting
  promise is logged and does not escape) and `test/integration/kernel-app.test.ts` (a real kernel
  handler calls `bindings.waitUntil` and the injected host records it).

### 3.8 R2 as `IStorage`

- **Decision:** `R2Storage` implements `put` (`Uint8Array` straight through), `get` (`arrayBuffer()`
  wrapped in `Uint8Array`, throwing a `CloudflareBindingMissingError`-sibling
  `CloudflareObjectNotFoundError` on `null` because the committed `get` returns
  `Promise<Uint8Array>` with no null arm), `delete` (`head` first, so the committed
  `Promise<boolean>` is honest — R2 `delete` returns void and does not report whether anything was
  removed), `exists` (`head`), and the optional `getStream` (`R2ObjectBody.body`). `getSignedUrl`
  throws `CloudflareUnsupportedError`.
- **Why:** each mapping is forced by a verified R2 fact in §1.2. The `delete` two-step is a real
  extra round trip and is documented as such; returning a constant `true` would be the silent lie
  the docs-must-match-behaviour rule targets. Presigned URLs genuinely do not exist on the binding,
  and the `LocalStorageProvider` throw (M28) is the established precedent for that arm.
- **Test home:** `test/unit/storage/r2-storage.test.ts`.

### 3.9 KV as `ISessionStore`

- **Decision:** `KvSessionStore` is an **exported class the application constructs** and passes to
  `SessionPlugin({ store })`; the plugin never registers it. Constructor takes
  `(kv: IKvNamespace, clock: { now(): number }, options?: { prefix?: string })`.
  `write(id, data,
  ttlMs)` converts to seconds and reuses the same envelope and 60-second floor as
  §3.4; `read` filters on logical expiry; `destroy` returns whether a live entry was present.
- **Why:** `SessionPluginOptions.store` is consumed at plugin **construction**, before any
  application exists, so a registry-published store could never reach it. `IRuntimeServices`
  satisfies the structural `clock` parameter, so an app already holding
  `createRuntimeServices({ env })` (the M36c path) passes it directly.
- **Test home:** `test/unit/stores/kv-session-store.test.ts` plus one
  `test/integration/session-store.test.ts` driving a real `SessionPlugin` with this store.

### 3.10 Capability registration is opt-in and instance-named

- **Decision:** `CloudflarePlugin` registers `CAPABILITIES.CLOUDFLARE` always; it registers
  `CAPABILITIES.CACHE` only when `cache` is configured and `CAPABILITIES.STORAGE` only when
  `storage` is configured. Both arms accept `name`, deriving `cache.<name>` / `storage.<name>`
  through `createCapabilityToken` exactly as `cache-plugin.ts:67` does. `provides` is computed in
  the factory from the options, so the resolver's duplicate index sees the truth.
- **Why:** `plugin-resolver.ts:127` rejects two providers of one token at startup, so an app running
  `CachePlugin()` beside a KV-cache-configured `CloudflarePlugin()` must be a startup error and not
  a load-order coin flip. Naming makes the "KV cache alongside a memory cache" composition
  expressible instead of forbidden.
- **Test home:** `test/integration/kernel-app.test.ts` — a named instance resolves under
  `cache.edge`, and an unnamed instance beside `CachePlugin()` fails `start()`.

### 3.11 Binding facades are structural and hand-written

- **Decision:** `IKvNamespace`, `IR2Bucket`, `IR2Object`, `IR2ObjectBody`, `ID1Database`,
  `IQueueProducer`, `IServiceBinding`, `IDurableObjectNamespace` are declared in this package as
  structural interfaces covering only the members the code calls. `@cloudflare/workers-types` is
  **not** a dependency.
- **Why:** the M25/M29/M50 precedent — a structural facade keeps the published dependency graph
  empty, keeps the package checkable on Deno, and makes a fake trivially constructible. A real
  `KVNamespace` satisfies `IKvNamespace` structurally, which is asserted by a type-level fixture
  rather than assumed.
- **Test home:** `test/unit/bindings/facades.test.ts` — a compile-time assignability fixture plus
  the `isKvNamespace`-style shape guards used by §3.6's validation.

### 3.12 Health indicator

- **Decision:** one indicator named `cloudflare` reporting `healthy` with
  `{ bindings: string[], vars: number, cache: boolean, storage: boolean, waitUntil: 'injected' |
  'absent' }`.
  It reports `degraded` with a `detail` message when the plugin is running on a platform other than
  `cloudflare-workers` (read from `runtime.platform()`), because every store method will then fail
  against a binding the platform cannot honour.
- **Why:** the indicator has to say something a probe can act on without doing billable I/O (§3.6).
  The off-platform case is the one genuinely actionable signal available for free.
- **Test home:** `test/unit/health/indicator.test.ts`.

### 3.13 `requireBindings`

- **Decision:** `requireBindings?: readonly string[]` — `register()` throws
  `CloudflareBindingMissingError` naming every absent entry, before the app serves anything.
- **Why:** a missing binding otherwise surfaces as a first-request failure in production. The
  option's consumer is `register()` and one integration test asserts the startup throw.
- **Test home:** `test/unit/plugin/cloudflare-plugin.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                                                          | Kind       | Consumer / real code path that READS it                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudflarePlugin`                                                                                                                       | factory fn | Application composition; `test/integration/kernel-app.test.ts` registers it in a real kernel app                                       |
| `ICloudflareBindings`                                                                                                                    | interface  | The type under `CAPABILITIES.CLOUDFLARE`; read by `KvSessionStore` wiring in the integration test and by application handlers          |
| `CloudflarePluginOptions`                                                                                                                | type       | `CloudflarePlugin`'s parameter                                                                                                         |
| `KvCacheOptions`, `R2StorageOptions`                                                                                                     | types      | The `cache` / `storage` arms of the options; read by `createKvCacheStore` / `createR2Storage`                                          |
| `KvCacheStore`                                                                                                                           | class      | Registered under `CAPABILITIES.CACHE` by the plugin; also constructible standalone (documented in the README)                          |
| `R2Storage`                                                                                                                              | class      | Registered under `CAPABILITIES.STORAGE` by the plugin                                                                                  |
| `KvSessionStore`                                                                                                                         | class      | Constructed by the application and passed to `SessionPlugin({ store })` — `test/integration/session-store.test.ts` drives exactly that |
| `WaitUntilHost`                                                                                                                          | type       | The `waitUntil` option; the app's `import { waitUntil } from 'cloudflare:workers'` satisfies it                                        |
| `IKvNamespace`, `IR2Bucket`, `IR2Object`, `IR2ObjectBody`, `ID1Database`, `IQueueProducer`, `IServiceBinding`, `IDurableObjectNamespace` | interfaces | Return types of the `ICloudflareBindings` accessors; the injection surface every test fake implements                                  |
| `CloudflareWorkerEnv`                                                                                                                    | type       | The `env` option's type; the app passes `cloudflare:workers`' `env` as this                                                            |
| `CloudflareBindingMissingError`, `CloudflareUnsupportedError`, `CloudflareObjectNotFoundError`                                           | classes    | Thrown by the accessors, `getSignedUrl`/unprefixed `clear()`, and `R2Storage.get`; consumers `instanceof`-check them                   |
| `CAPABILITIES.CLOUDFLARE` (in `common`)                                                                                                  | token      | The plugin's `provides`; consumers resolve `ICloudflareBindings` with it                                                               |
| `splitWorkerEnv` (in `runtime`)                                                                                                          | fn         | `createCloudflareRuntimeServices` calls it; exported so the string-filter rule has a direct unit test                                  |

### 4.1 Options — every option names its consumer

| Option                              | Consumer                             | Behavior (per implementation)                                                                   |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `env` (required)                    | `BindingRegistry` constructor        | The record every accessor reads. Absent binding → `CloudflareBindingMissingError`               |
| `waitUntil`                         | `BindingRegistry.waitUntil`          | Delegates when present; attaches the rejection handler on both paths (§3.7)                     |
| `requireBindings`                   | `register()`                         | Throws naming every absent entry (§3.13)                                                        |
| `cache.binding`                     | `createKvCacheStore`                 | Name of the KV namespace backing `ICacheStore`                                                  |
| `cache.name`                        | plugin factory                       | Derives `cache.<name>`; `'default'` claims the bare `cache` token                               |
| `cache.prefix`                      | `KvCacheStore`                       | Prepended to every key; **required** for `clear()` (§3.5)                                       |
| `cache.defaultTtlSeconds`           | `KvCacheStore.set`                   | Applied when `set` omits `ttlSeconds`; omitted means no expiry                                  |
| `storage.binding`                   | `createR2Storage`                    | Name of the R2 bucket backing `IStorage`                                                        |
| `storage.name`                      | plugin factory                       | Derives `storage.<name>` on the same rule as `cache.name`                                       |
| `storage.prefix`                    | `R2Storage`                          | Prepended to every object key                                                                   |
| `RuntimeOptions.env` (in `runtime`) | `createRuntimeServices` → CF factory | Populates `runtime.env` with string entries only (§3.2); ignored by the Deno/Node/Bun factories |

## 5. Implementation files

### 5.1 `packages/cloudflare-plugin`

| File                               | Purpose                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/index.ts`                     | Barrel; `@module`-first JSDoc (release-verify check 5)                                         |
| `src/options.ts`                   | `CloudflarePluginOptions`, `KvCacheOptions`, `R2StorageOptions`, `WaitUntilHost`               |
| `src/errors.ts`                    | The three exported error classes                                                               |
| `src/bindings/facades.ts`          | Structural binding interfaces, `CloudflareWorkerEnv`, and the shape guards §3.6 validates with |
| `src/bindings/binding-registry.ts` | `BindingRegistry implements ICloudflareBindings`                                               |
| `src/background/wait-until.ts`     | `resolveWaitUntil(host, logger)` — the one implementation both paths of §3.7 funnel through    |
| `src/stores/kv-envelope.ts`        | Pure `encodeEnvelope`/`decodeEnvelope`/`physicalTtlSeconds`                                    |
| `src/stores/kv-cache-store.ts`     | `KvCacheStore implements ICacheStore`                                                          |
| `src/stores/kv-session-store.ts`   | `KvSessionStore implements ISessionStore`                                                      |
| `src/storage/r2-storage.ts`        | `R2Storage implements IStorage`                                                                |
| `src/health/indicator.ts`          | `createCloudflareIndicator`                                                                    |
| `src/plugin/cloudflare-plugin.ts`  | The factory: computes `provides`, validates, registers                                         |
| `deno.json`, `README.md`           | Manifest at the current workspace version; README with absolute GitHub links (JSR 400 rule)    |

### 5.2 Outside the package

| File                                                               | Change                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/tokens.ts`                                    | Add `CLOUDFLARE: 'cloudflare'`                                                                                                                                                                             |
| `packages/runtime/src/adapters/shared/runtime-services-factory.ts` | `env` option; forward to the platform factory                                                                                                                                                              |
| `packages/runtime/src/adapters/workers/cf-runtime.ts`              | Consume `env`; add and call `splitWorkerEnv`; correct the JSDoc (C1)                                                                                                                                       |
| `packages/runtime/src/adapters/workers/split-worker-env.ts`        | New pure splitter                                                                                                                                                                                          |
| `packages/runtime/src/plugin/runtime-plugin.ts`                    | `RuntimeOptions.env`, threaded through                                                                                                                                                                     |
| `packages/runtime/src/index.ts`                                    | Export `splitWorkerEnv`                                                                                                                                                                                    |
| `packages/cli/src/commands/new.ts`                                 | Bump `compatibility_date` (C3); Workers entry imports `env` from `cloudflare:workers` and passes `RuntimePlugin({ env })`; `wrangler.toml` gains a commented `[[kv_namespaces]]` / `[[r2_buckets]]` stanza |
| `deno.json` (root)                                                 | Add `./packages/cloudflare-plugin` to the workspace                                                                                                                                                        |
| `scripts/release-packages.ts`                                      | Add the package (first-publish: `release:create-packages` + `release:link-repos` before the next tag)                                                                                                      |
| `PUBLIC_API.md`                                                    | New Cloudflare section; runtime `env` rows (C1, C2); the new token                                                                                                                                         |
| `ARCHITECTURE.md`                                                  | Package-diagram node (C4)                                                                                                                                                                                  |
| `ROADMAP.md`                                                       | Milestone 52 + 52b sections, two Progress rows, Workers line on the config-composition example (C2, C5)                                                                                                    |
| `README.md`                                                        | Counts and the plugin row (C4)                                                                                                                                                                             |
| `CHANGELOG.md`                                                     | The new package; the `runtime.env` behaviour change on Workers                                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                           | src covered                                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/bindings/facades.test.ts`                                | `src/bindings/facades.ts`                                            | Shape guards accept a well-formed fake and reject a record missing `get`; a type-level fixture asserts a full KV-shaped object is assignable to `IKvNamespace`                                                                                                                                            |
| `test/unit/bindings/binding-registry.test.ts`                       | `src/bindings/binding-registry.ts`                                   | Each accessor returns the binding; a missing name throws `CloudflareBindingMissingError` whose message lists the present names; `names()`/`vars()`/`has()`                                                                                                                                                |
| `test/unit/background/wait-until.test.ts`                           | `src/background/wait-until.ts`                                       | Injected host receives the promise; a rejecting promise is logged and does not escape; with no host the promise still settles and its rejection is still logged                                                                                                                                           |
| `test/unit/stores/kv-envelope.test.ts`                              | `src/stores/kv-envelope.ts`                                          | Round-trip; `physicalTtlSeconds(5) === 60`, `(120) === 120`, fractional rounds up; malformed JSON decodes to a miss                                                                                                                                                                                       |
| `test/unit/stores/kv-cache-store.test.ts`                           | `src/stores/kv-cache-store.ts`                                       | `set(k, v, 5)` records `expirationTtl: 60` on the fake **and** a logical expiry 5 s out; a clock advanced 6 s makes `get`/`has` miss and issues the delete; `clear()` walks two `list` pages and deletes every key; unprefixed `clear()` throws; `defaultTtlSeconds` applied when `ttlSeconds` is omitted |
| `test/unit/stores/kv-session-store.test.ts`                         | `src/stores/kv-session-store.ts`                                     | `write(id, data, 1000)` floors to 60 s physically while expiring logically at 1 s; `read` after expiry is `null`; `destroy` reports `true` once and `false` after                                                                                                                                         |
| `test/unit/storage/r2-storage.test.ts`                              | `src/storage/r2-storage.ts`                                          | `get` returns the bytes and throws `CloudflareObjectNotFoundError` on `null`; `getStream` returns `body`; `delete` heads first and reports `false` for an absent key; `exists`; `getSignedUrl` throws `CloudflareUnsupportedError`; `prefix` is applied on every path                                     |
| `test/unit/health/indicator.test.ts`                                | `src/health/indicator.ts`                                            | `healthy` on `cloudflare-workers` with the inventory; `degraded` with a detail off-platform; no binding method is called                                                                                                                                                                                  |
| `test/unit/plugin/cloudflare-plugin.test.ts`                        | `src/plugin/cloudflare-plugin.ts`, `src/options.ts`, `src/errors.ts` | `provides` contains `cloudflare` alone by default, and gains `cache`/`storage` when configured; `requireBindings` throws naming every absent entry; a fake whose methods throw still registers (§3.6); shape validation rejects a binding that is not KV-shaped                                           |
| `test/integration/kernel-app.test.ts`                               | plugin + registry + stores through the kernel                        | A real `createApplication` app: a handler resolves `CAPABILITIES.CLOUDFLARE`, calls `waitUntil`, writes through the cache store and **reads the value back**; a named instance resolves under `cache.edge`; an unnamed instance beside `CachePlugin()` fails `start()`                                    |
| `test/integration/session-store.test.ts`                            | `src/stores/kv-session-store.ts`                                     | A real `SessionPlugin({ store: new KvSessionStore(...) })` sets a session on one request and reads it back on the next                                                                                                                                                                                    |
| `test/unit/adapters/workers/split-worker-env.test.ts` (runtime pkg) | `packages/runtime/src/adapters/workers/split-worker-env.ts`          | A mixed record splits into string `vars` and object `bindings`; `undefined` and numeric values land in neither `vars` nor a stringified form                                                                                                                                                              |
| `test/unit/plugin/runtime-plugin.test.ts` (runtime pkg, extended)   | `runtime-plugin.ts`, `runtime-services-factory.ts`, `cf-runtime.ts`  | `RuntimePlugin({ platform: 'cloudflare-workers', env })` yields `runtime.env` holding only the string entries, and never `[object Object]`                                                                                                                                                                |
| `test/unit/commands/new.test.ts` (cli pkg, extended)                | `packages/cli/src/commands/new.ts`                                   | The Workers entry imports `env` from `cloudflare:workers` and passes it to `RuntimePlugin`; `compatibility_date` is the bumped value                                                                                                                                                                      |

No guarded real-import test is needed: the package has **no** `npm:` and no `cloudflare:` import
(§3.1, §3.11), so there is no external load path to exercise. The real-path obligation is met
instead by the two integration tests, which drive a real kernel application and a real
`SessionPlugin` and read every write back through the public surface.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m52-cloudflare-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/cloudflare-plugin/src
grep -rn "cloudflare:workers" packages/                      # must match only docs/README prose, never an import
deno task release:verify <version>                           # @module-first (check 5) on the new entrypoint
```

## 8. Risks & mitigations

- Nothing in CI runs `workerd`, so every Cloudflare API is exercised against a hand-written fake →
  each fake is built from the verified signature in §1.2 rather than from memory, the assertions pin
  the exact arguments passed to the binding (notably `expirationTtl`), and the README states plainly
  that the bindings are unverified against a live Worker, the way the M30b FCM release note did.
- `runtime.env` becomes non-empty on Workers for the first time, which changes `ConfigPlugin` and
  `SecretsPlugin` behaviour on that platform → treated as a behaviour change in `CHANGELOG.md`, not
  a silent fix; the string filter (§3.2) is what keeps it from being a regression.
- The `IStorage`/`ICacheStore` mappings could drift from what R2 and KV actually accept → the
  arguments are asserted, not the results only, so a mapping change fails a test rather than
  degrading quietly.
- M51 is in flight and touches the same ROADMAP tables, README counts and release list → this branch
  appends rather than renumbers (C5) and re-reads the counts at merge time (C4); a rebase conflict
  in those three files is expected and resolved by keeping both.
- The package publishes to JSR for the first time → `release:create-packages` and
  `release:link-repos` must run before the next tag, per the M35 `sdk` precedent.

## 9. Out of scope

Each item below is deferred to **M52b** for a stated reason, not for lack of time:

- **D1 as a database backend** — the data-access seam is `IDatabaseAdapter`, declared inside
  `packages/database-plugin` (`adapters/adapter.ts:51`) and absent from `common`, whose
  `IOrmAdapter` is lifecycle-only. Shipping D1 means promoting a port to `common`, which is a
  contract decision deserving its own milestone. D1's lack of imperative `BEGIN`/`COMMIT` also has
  to be reconciled with `ITransaction` before an adapter is honest.
- **Queues** — the producer would satisfy `IQueue.add`, but consumption requires the Worker module
  to export a `queue(batch, env, ctx)` handler and offers no pull API, while `IQueue.process` is a
  registration/pull model. Bridging that needs a new module-export contract (`createQueueHandler`)
  shared with the next item.
- **Cron Triggers** — same bridge: `scheduled(controller, env, ctx)` is a module export and
  schedules are wrangler-config-only, so `IScheduler.schedule` at runtime has no counterpart. Also
  the reason `scheduler-plugin`'s `setInterval` timers cannot work on Workers.
- **Durable Objects as a realtime backplane and distributed lock** — needs the application to export
  a DO class, which is the same module-export contract again, plus a migration stanza in wrangler
  config.
- **Cache API response caching** — `caches.default` carries its own rule set (no `Set-Cookie`, no
  `206`, no `Vary: *`, GET-only, per-datacenter, unavailable in the dashboard editor) and belongs
  beside a middleware, not inside a `ICacheStore`.
- **Hyperdrive, Vectorize, Workers AI, Analytics Engine** — each is a binding accessor away
  (`bindings.get<T>(name)` already reaches them in M52); a first-class capability port for any of
  them is speculative until an application asks for one.
- **A `cloudflare` arm on any starter** — M36-series work; the starters compose plugins and would
  need a Workers-portability review of the whole set.
- **Removing the `IApplication.fetch(request)` single-parameter shape** — the `env`/`waitUntil`
  module imports make widening it unnecessary (§3.1), so it stays as committed.
