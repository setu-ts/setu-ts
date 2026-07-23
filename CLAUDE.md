# Hono Enterprise — Session Instructions

Plugin-first enterprise backend framework. **Deno-first toolchain** (Deno 2 workspaces), published
to **JSR** under `@hono-enterprise`, consumable from Node/Bun via JSR npm compatibility.

The backend toolchain is Deno-only. The **sole exception** is an application's _frontend build_ —
the React Router SSR plugin (M44) is built with Vite on the Node/npm toolchain, outside the Deno
workspace. Vite is an app-level, build-time `devDependency`; it is never imported by a plugin and
never appears in any JSR-published package's dependency graph (see AI_GUIDELINES §12.2).

## Starting a new milestone — READ THESE FIRST (mandatory)

**Step 0 — be on the milestone's feature branch before you touch anything.** `main` is protected;
never work on it and never commit to it directly (AI_GUIDELINES §15.3). A milestone gets exactly ONE
feature branch — `feat/[milestone]-[description]` (e.g. `feat/m4-logger-plugin`) — and ALL work for
that milestone lives on it: the initial implementation AND every follow-up fix, review change, or
bug repair, right up until the branch is merged. Your FIRST action is:

```bash
git branch --show-current            # what am I on?
# If it already prints the milestone's feat/… branch (work in progress) → continue on it.
# If it prints "main":
git switch feat/[milestone]-[description]     # resume the existing branch if it exists, else:
git switch -c feat/[milestone]-[description]  # create it (only when starting the milestone fresh)
```

Do NOT open a new `fix/…` branch for defects in a milestone that is not yet merged — those fixes
belong on the milestone's own `feat/…` branch (a `fix/…` branch is only for a defect in
already-merged code on `main`). If `git branch --show-current` prints `main` at any point during a
milestone, stop and switch to the feature branch before doing anything else. The branch merges to
`main` via a single PR once the milestone is complete.

Do NOT write, edit, or scaffold any code until you have read, in this order:

1. **AI_GUIDELINES.md** — in full. Every rule is mandatory (SOLID, no `any`, no runtime-specific
   APIs outside `packages/runtime`, capability tokens from `CAPABILITIES`, composition over
   inheritance, `IXxx` interface naming). Also read the "Common pitfalls", "Self-review checklist",
   and "Before reporting a task done" sections lower in THIS file.
2. **ROADMAP.md** — the section for the milestone you are starting (its scope, file list, and
   deliverables) AND the "Progress Tracking" table. Work on **one package per milestone**; do not
   start the next until the current one is complete (compiles, tested 90%+, documented).
3. **ARCHITECTURE.md** — the sections relevant to the package you are building (e.g. §6 service
   registry, §10 middleware pipeline). It explains WHY, not just what.
4. **PUBLIC_API.md** — the sections for `@hono-enterprise/common` and any package you depend on, so
   you consume existing interfaces instead of inventing new ones.
5. **The `@hono-enterprise/common` source** for the interfaces you will implement — implement the
   committed contracts exactly; do not redefine, widen, or re-declare them.
6. **The milestone's plan under `plans/`** (write one if it does not exist) — and verify it against
   the "Writing a milestone plan" checklist below BEFORE implementing. A plan that fails a checklist
   item gets fixed as a plan first; do not "fix it during implementation".

Only after that, begin. And: any change to a package's `src/index.ts` exports requires updating
**PUBLIC_API.md** in the same change, with JSDoc on every export.

## Writing a milestone plan (`plans/*.md`) — checks the plan must survive

**Start from the template and lint it.** Copy `plans/TEMPLATE.md` to
`plans/milestone-<N>-<desc>.md`, fill every `<FILL: …>`, and run `deno task check:plan`. It
mechanically enforces the structure — required sections present (including the "Contracts verified
from SOURCE" and "Exported surface — every symbol names its consumer" tables), no unfilled
placeholders, no undecided-alternative markers left in a design decision, and only the one canonical
plan file at `plans/` root. A plan that does not lint clean is not ready to implement. The linter
checks _structure_; the prose checks below are the judgment it cannot make for you — do both.

Every item below is a miss from a real milestone plan (M10) caught only in review. A plan is not
"read these docs and list the files" — it is where these defects are cheapest to catch. Check each:

- **The principle: any claim about code you do not own in this change must be checked against that
  code before the plan relies on it — read the source, never the name and never your memory.** This
  is one rule, not a list of special cases: it covers a committed contract's surface, a capability
  token's shape, a runtime service's signature, AND any assertion that another milestone/package
  "already ships X" or that your design "builds on Y". A motivational aside is a reference too, and
  a wrong one is a lie that ships green (the M12 plan claimed M9 shipped an `@EventHandler`
  decorator; `packages/decorator-plugin/src` has none — one `grep` would have caught it). Worked
  example (contract surface): the M10 plan assumed `IOrmAdapter` (common) carried data access; it is
  lifecycle-only (`connect`/`disconnect`/`isReady`/`beginTransaction`), which left the plan's core
  seam — repository ↔ adapter — completely undefined. If a committed port lacks a surface the design
  needs, the plan must define the internal port explicitly (its methods, its file, and that it is
  NOT exported from `src/index.ts`); "the adapter handles it" is not a design.
- **The test-file table must cover every planned `src/` file.** The per-file 90% bar is decided at
  planning time: a src file with no named test file means the plan fails its own completion criteria
  (M10 planned four Prisma/Drizzle src files and zero tests for them). External-dep code
  additionally needs one guarded REAL-import test (logger-plugin pino / M9 discovery precedent),
  with the branching around the import unit-tested via an injection seam.
- **Check external-package facts against reality, not memory.** The exact npm specifier of the
  RUNTIME package (`npm:@prisma/client` — `npm:prisma` is the CLI and the plan had it wrong), and
  whether the library's API actually fits the contract being implemented (Prisma has only
  callback-style `$transaction` with a ~5s default timeout — no imperative begin/commit; bridging
  that is a design decision, not an implementation detail). A plan naming a lazy import must state
  exactly what it loads, when it can succeed, and the error when it cannot.
- **Invented tokens and names must pass the committed grammar and the kernel's constraints.** Run
  every new capability token against `createCapabilityToken` in `packages/common/src/tokens.ts`
  (lowercase kebab-case, dot namespacing — colons are ILLEGAL), and for any plugin registrable more
  than once read `packages/kernel/src/registry/plugin-resolver.ts`: duplicate plugin names AND
  duplicate capability providers throw at startup. The plan must state each instance's derived name,
  its `provides`, and which instance (if any) claims the bare token.
- **Committed-doc conflicts are resolved IN the plan, never inherited.** PUBLIC_API.md documented
  `database:primary` while the token grammar forbids colons — the M10 plan initially copied the
  illegal form. When two committed documents disagree, the plan picks a side explicitly and lists
  the doc correction as a named PR deliverable. Same for any deviation from a committed PUBLIC_API
  shape (widening a generic, dropping an option): deliberate, flagged, and shipped as a
  PUBLIC_API.md edit in the same PR — never silent.
- **A test may only assert behavior the design specifies.** M10's integration tests asserted "health
  indicator registered" and "lifecycle hooks called on close" while no design decision said the
  plugin calls `ctx.health.register(...)` or `ctx.lifecycle.onShutdown(...)`. Every behavior a
  planned test asserts needs a design-decision home; otherwise it gets improvised mid-implementation
  or quietly dropped.
- **Every option names its consumer; every interface method defines its behavior per
  implementation.** A planned option no adapter can honestly consume (`poolSize`) is cut at plan
  time, not stored. An interface method an implementation cannot support (`query()`/`migrate()` on
  the memory adapter) gets an explicit planned behavior — a documented, tested throw — not silence.
  These are the plan-time versions of the dead-option and docs-must-match-behavior rules below.

## Current status

- **Milestone 0** (monorepo foundation) — complete (PR #1)
- **Milestone 1** (`packages/common`) — complete (PR #2)
- **Milestone 2** (`packages/kernel` — plugin kernel, service registry, pipeline, router,
  application lifecycle) — complete (PR #3)
- **Milestone 3** (`packages/runtime` — runtime services for Node/Deno/Bun, detection,
  RuntimePlugin) — complete (PR #4). HTTP server adapters were deferred to Milestone 41 and are now
  implemented there via the `IResponse.snapshot()` read seam (added in M11).
- **Milestone 4** (`packages/logger-plugin` — structured logging) — complete (PR #5)
- **Milestone 5** (`packages/config-plugin` — configuration with env loading, variable expansion,
  and Zod-compatible validation) — complete (PR #7)
- **Milestone 6** (`packages/validation-plugin` — Zod-based validation) — complete (PR pending)
- **Milestone 7** (`packages/exceptions` — exception hierarchy, error handler middleware, RFC 7807
  support) — complete (PR pending)
- **Milestone 8** (`packages/di-plugin` — optional dependency injection container with
  singleton/scoped/transient lifecycles, constructor injection, circular dependency detection,
  hierarchical scopes, and auto-registration fallback to the ServiceRegistry) — complete (PR
  pending)
- **Milestone 9** (`packages/decorator-plugin` — optional decorators and reflection: `@Controller`,
  `@Get`/`@Post`/…, `@Body`/`@Query`/`@Param`/…, `@Injectable`/`@Inject`, `@Roles`/`@Permissions`/
  `@Public`/`@CurrentUser`, `@UseGuards`/`@UseInterceptors`/`@UseFilters`, `@ValidateBody`/
  `@ValidateQuery`/`@ValidateParams`, `@ApiTags`/`@ApiOperation`/`@ApiResponse`,
  `createDecorator`/`createParameterDecorator`, `MetadataStore` under `CAPABILITIES.METADATA_STORE`,
  `discoverControllers` auto-discovery, and a parameter resolver) — complete (PR pending)
- **Milestone 10** (`packages/database-plugin` — DatabasePlugin with repository pattern, Unit of
  Work, ORM adapters for Prisma/Drizzle/Memory) — complete (PR pending)
- **Milestone 11** (`packages/cache-plugin` — CachePlugin with Memory, Redis, Noop stores;
  CacheService; cacheMiddleware for transparent response caching) — complete (PR pending)
- **Milestone 12** (`packages/events-plugin` — EventsPlugin, InMemoryEventBus, DomainEvent,
  IntegrationEvent, defineDomainEvent, IEventHandler, subscribeHandler; in-memory event bus with
  publish/publishBatch/subscribe; `publishBatch` addition to `IEventBus` in `common`) — complete (PR
  pending)
- **Milestone 13** (`packages/cqrs-plugin` — CqrsPlugin, CommandBus/QueryBus, ICqrsFacade under
  `CAPABILITIES.CQRS`, internal RequestBus + composePipeline behavior pipeline,
  HandlerNotFoundError; CQRS contracts in `common/services/cqrs.ts`:
  CqrsRequest/CqrsCommand/CqrsQuery, ICommandHandler/IQueryHandler/IPipelineBehavior,
  ICommandBus/IQueryBus/ICqrsFacade) — complete (PR pending)
- **Milestone 14** (`packages/messaging-plugin` — MessagingPlugin, InMemoryBroker,
  RedisStreamsBroker, JsonSerializer/ISerializer, EventsMessagingBridge; broker contracts in
  `common/services/messaging.ts`: IMessageBroker, ISubscription, MessageHandler, MessageMetadata,
  SubscribeOptions; in-memory + Redis Streams brokers implemented; RabbitMQ/NATS/Kafka deferred to
  M14b) — complete (PR pending)
- **Milestone 14b** (`packages/messaging-plugin` — RabbitMqBroker, NatsBroker, and KafkaBroker added
  to the existing MessagingPlugin via the internal MessageBrokerAdapter seam; no `common` change, no
  new capability token; each broker follows the inject-or-lazy `npm:` client pattern with a guarded
  real-import test) — complete (PR pending)
- **Milestone 15** (`packages/queue-plugin` — QueuePlugin with MemoryQueue and RedisQueue adapters,
  QueueService for job processing with retries/backoff, recurring job scheduling via cron, job
  processor registration with concurrency control; queue contracts in `common/services/queue.ts`:
  IQueue, IJob, JobProcessor, AddJobOptions, ProcessOptions, RecurringOptions; memory + redis
  adapters implemented) — complete (PR pending)
- **Milestone 15b** (`packages/queue-plugin` — `RabbitMqQueue` adapter added to the existing
  QueuePlugin via the internal `QueueAdapter` seam; `basicGet` polling for `reserve`, per-message
  TTL with a dead-letter-exchange for delayed enqueue/requeue, per-name ready/delay/dead queues,
  in-process recurring; inject-or-lazy `npm:amqplib` client with a guarded real-import test; no
  `common` change, no new capability token) — complete (PR #32)
- **Milestone 41** (`packages/runtime` — HTTP server adapters taken out of order, before M16:
  `DenoHttpAdapter`/`NodeHttpAdapter`/`BunHttpAdapter` implementing `IHttpAdapter`, registered under
  `CAPABILITIES.HTTP_ADAPTER` via the `RuntimePlugin` `httpAdapters` map; `app.start({ port })`
  binds a real socket and throws when no adapter is registered; Bun is unit-tested via an injectable
  `BunServeHost` seam; `IResponse.snapshot()` (M11) is the response read seam — no `common` change)
  — complete (PR pending)
- **Milestone 16** (`packages/auth-plugin` — AuthPlugin registering `IJwtService` under `jwt`,
  `IAuthService` under `authentication`, and `IAuthorizationService` under `authorization`; JWT
  HS256/RS256 via Web Crypto (`runtime.subtle`, zero npm deps), passive JwtStrategy/ApiKeyStrategy
  chain + LocalStrategy for `verifyCredentials` login flows, RBAC with transitive role hierarchy and
  the `'*'` wildcard permission, short-circuiting guard factories (`requireAuth`, `requireRole`,
  `requirePermission`, `requireAnyRole`, `requireAllPermissions`, `publicRoute`), `authMiddleware`
  populating `ctx.request.user` (made writable in `common`), and an exported PBKDF2-SHA256
  `PasswordHasher`; refresh tokens + rate limiting deferred to M16b) — complete (PR #35)
- **Milestone 16b** (`packages/auth-plugin` — refresh tokens & rate limiting as pure additions, no
  `common` change, no new capability token, `AuthPlugin` options untouched: `RefreshTokenService`
  (app-instantiated; `issue`/`refresh` with jti rotation + replay rejection/`revoke`, refresh JWTs
  carry `type: 'refresh'` + `jti`) over a pluggable async `RefreshTokenStore` with
  `MemoryRefreshTokenStore`; standalone `rateLimitMiddleware` fixed-window limiter (429
  short-circuit, `Retry-After` + `RateLimit-*` delta-seconds headers) over `RateLimitStore` with
  `MemoryRateLimitStore` + `RedisRateLimitStore` (inject-or-lazy `npm:ioredis@5.x`, guarded
  real-import test)) — complete (PR pending)
- **Milestone 17** (`packages/http-security-plugin` — CORS, security headers, CSRF, request-size,
  ip-security) — complete (PR #38)
- **Milestone 18** (`packages/scheduler-plugin` — SchedulerPlugin registering an `IScheduler` under
  `CAPABILITIES.SCHEDULER`; zero-dependency 5-field UTC cron parser, fixed-interval `every` and
  one-shot `delay` jobs, retry with fixed/exponential backoff, pause/resume/remove/getNextRun, and
  distributed locking behind an `IDistributedLock` seam with a process-local `MemoryLock` default
  and a `RedisLock` (inject-or-lazy `npm:ioredis@5.x`); scheduler contracts added to
  `common/services/scheduler.ts`) — complete (PR #40)
- **Milestone 19** (`packages/metrics-plugin` — Prometheus metrics collection: MetricsPlugin
  registering `IMetricsService` under `CAPABILITIES.METRICS`; counter/gauge/histogram/summary
  instruments over a shared `MetricBase`; zero-dependency Prometheus text 0.0.4 renderer +
  `GET
  /metrics`; four built-in HTTP collectors wired as `MetricsMiddleware` at priority 20
  (outermost, so it observes all ingress and the final status; corrected the ARCHITECTURE §10
  table); `try/finally` record path so a thrown request never leaks the active-requests gauge;
  `IMetricsService` + `ICounter`/`IGauge`/`IHistogram`/`ISummary` + `MetricOptions` added to
  `common`; memory/cpu resource collectors deferred pending a runtime resource seam) — complete (PR
  #42)
- **Milestone 20** (`packages/health-plugin` — Health checks and readiness probes) — complete (PR
  #44)
- **Milestone 21** (`packages/openapi-plugin` — OpenAPI 3.1 spec generation from routes, Swagger UI
  serving, Zod-to-OpenAPI schema transformer, schema deduplication) — complete (PR #46)
- **Milestone 22** (`packages/kernel` — kernel routing on Hono: delegates `Router.match()` to
  `jsr:@hono/hono` with `LinearRouter`, preserves custom middleware pipeline, static-over-param
  precedence, and `inject()` parity) — complete (PR #47)
- **Milestone 23** (`packages/runtime` — runtime serve on Hono + Cloudflare Workers: replaces M41
  socket adapters with Hono's `fetch` entry, changes `IHttpAdapter` to
  `setHandler`/`fetch`/`listen`/`close`) — complete (PR #48)
- **Milestone 24** (`packages/telemetry-plugin` — TelemetryPlugin registering `ITelemetryService`
  under `CAPABILITIES.TELEMETRY`; `TelemetryService`/`NoopTelemetryService`; request-span middleware
  at priority 30 with W3C `traceparent` propagation; lazy OTel SDK import via `npm:` specifiers;
  `ConsoleSpanExporter` and `OTLPTraceExporter` loaders; `TELEMETRY_CONTEXT_OPAQUE` symbol exported
  from `common`; `TracerHost` injectable seam) — complete (PR #49)
- **Milestone 24b** (`packages/telemetry-plugin` — auto-instrumentation added to the M24 plugin: a
  public per-instrumentation `instrumentations` option
  (`http`/`fetch`/`ioredis`/`amqplib`/`kafkajs`, each `true | InstrumentationConfig`, NOT a bare
  `string[]`) loaded behind the M24 inject-or-lazy `TracerHost` seam via lazy
  `npm:@opentelemetry/instrumentation-*` imports; runtime-gated (Node-only) with a documented no-op
  — never a throw — on unsupported runtimes or absent packages; per-instance `setTracerProvider` (no
  global singleton); a new optional `TracerHost.otelProvider` accessor; and a
  `spanProcessor: 'simple' | 'batch'` choice via `span-processor-factory` (both processors from the
  already-pinned `npm:@opentelemetry/sdk-trace-base@^2.9.0`, zero new deps); no `common` change, no
  new capability token) — complete (PR #50)
- **Milestone 24c** (telemetry — OTel Collector **trace fan-out**: config + docs only, no code
  package. A reference OpenTelemetry Collector config
  (`docker/otel-collector/collector-config.yaml`) that receives one OTLP/HTTP trace stream from the
  plugin (`exporter: 'otlp'`) and fans it out to Datadog + New Relic + Azure Application Insights
  simultaneously — OTLP/HTTP receiver on `:4318`, `memory_limiter` + `batch`, and
  `datadog`/`otlphttp`(New Relic)/`azuremonitor` exporters on one `traces` pipeline; credentials via
  `${env:...}`; requires the `otelcol-contrib` distribution; validated with
  `otelcol-contrib
  validate`. Plus an operator guide (`docs/telemetry-collector-fanout.md`). M39
  owns compose/k8s and references this config; M38 links the guide. No `common` change, no
  capability token) — complete (PR #51)
- **Milestone 25** (`packages/secrets-plugin` — SecretsPlugin registering an `ISecretManager` under
  `CAPABILITIES.SECRETS`; `SecretsService` wrapping an internal `SecretProvider` port with a
  monotonic-clock read-through cache (`cacheTtl`, `0` disables); five providers — `EnvProvider`
  (default, reads `IRuntimeServices.env`, read-only `set`/`rotate` throw), `AwsKmsProvider` (AWS
  Secrets Manager, KMS-backed), `GcpSecretManagerProvider`, `AzureKeyVaultProvider`, and
  `HashiCorpVaultProvider` (KV v2 over `fetch`, zero-dep); cloud providers use the inject-or-lazy
  client pattern via an `adapt(module)`/`load(module)` seam (pure adapter unit-tested with a fake
  SDK module, one-line `import('npm:…')` behind a guarded real-import test); structural client
  facades `IAwsSecretsClient`/`IGcpSecretsClient`/`IAzureSecretsClient`/`IVaultHttp` exported for
  injection; no `common` change — the contract and token were committed earlier) — complete (PR #56)
- **Milestone 42** (`packages/common` — `IResponse.stream(ReadableStream<Uint8Array>)`, widened
  `snapshot()` returning a discriminated union `{ streaming: false, body: Uint8Array|string|null }`
  / `{ streaming: true, body: ReadableStream<Uint8Array> }`; `IRequest.signal?: AbortSignal` and
  `IRequestContext.signal: AbortSignal`; `packages/kernel` — `context/response.ts` streaming
  implementation, `context/request-context.ts` signal threading; `packages/runtime` —
  `adapters/shared/fetch-mapping.ts` streaming body pass-through (`mapSnapshotToWebResponse`) +
  native `Request.signal` → `IRequestContext.signal`; `packages/cache-plugin` — streaming guard in
  `cache-middleware.ts` (skip `encodePayload` when `streaming === true`, set `X-Cache: MISS`) —
  complete (PR #53)
- **Milestone 43** (`packages/sse-plugin` — Server-Sent Events plugin with frame encoding, named
  channels, heartbeat, `Last-Event-ID`) — complete (PR #55)
- **Milestone 44** (`packages/react-router-plugin` — React SSR + file-based routing by embedding
  React Router v7 framework mode as a plugin over a kernel catch-all handler; `ReactRouterPlugin`
  registering `SsrService` under `CAPABILITIES.SSR` (new `ISsrService` contract + `SSR: 'ssr'` token
  in `common`); async `register()` with an injectable `loadRequestHandler` seam (default lazily
  imports `npm:react-router@7` + the app-provided `ServerBuild`); `IRequestContext` ↔ web
  `Request`/`Response` bridge streaming through M42 `IResponse.stream()`, GET/HEAD bodies omitted;
  default `loadContext` exposing `{ services, user }`; catch-all mounted on all 7 verbs at
  `joinWildcard(basename)`; static-asset serving over `runtime.fs?.readFile` with symlink-safe
  containment via a new **optional `IFileSystem.realPath`** (`common`) implemented in the Node/Deno/
  Bun runtime adapters (degrades to lexical `..` containment when absent); a `react-router` health
  indicator and no `onClose` (stateless handler); `flatRoutes`/file-based routing supported
  transparently via the compiled build — complete (PR #57)
- **Milestone 27** (`packages/resilience-plugin` — ResiliencePlugin registering an
  `IResilienceService` under `CAPABILITIES.RESILIENCE`; a zero-dependency `ResilienceService.wrap`
  composing four pure in-process patterns — circuit breaker, retry with backoff, timeout, and
  bulkhead — around an arbitrary `() => Promise<T>`, built once per `wrap` into a state-preserving
  closure in the fixed order bulkhead → circuitBreaker → retry → timeout → fn; internal
  `CircuitBreaker` (implements the committed `ICircuitBreaker`, monotonic `hrtime()` rolling failure
  window + open→half-open cooldown), `runWithRetry`/`computeBackoffMs`, `runWithTimeout` (race with
  `finally` timer cleanup, documented non-cancellation), and `Bulkhead` (bounded FIFO queue);
  exported `TimeoutError`/`BulkheadFullError`/`CircuitOpenError` for consumer `instanceof`; per-wrap
  `default*` policy resolution where `true` consumes the matching plugin default and a `true` with
  no default throws; no health indicator, no `onClose`. Added the missing service contract to
  `common`: `IResilienceService`, `WrapOptions`, `CircuitBreakerPolicy`, `RetryPolicy`,
  `BulkheadPolicy`, `BackoffStrategy` (distinct names from the scheduler's
  `RetryOptions`/`SchedulerBackoff`), extended the barrel, and corrected the PUBLIC_API Resilience
  row + ROADMAP examples in the same PR) — complete (PR pending)
- **Next milestone** — **Milestone 28** (`packages/storage-plugin`); resumes the main plugin
  sequence (M26 audit-plugin proceeds in parallel on its own branch, M28–M40 follow) unless
  reprioritized.

## Verification (run before declaring any work done)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

All four must pass. A milestone also requires 90%+ coverage (`deno task test:coverage`).

## Common pitfalls (these fail the gates)

- `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional property — omit it.
- The `verbatim-module-syntax` lint rule requires `import type { … }` for type-only imports.
- `no-console` applies everywhere except `packages/cli` and `scripts/` (scripts use
  `// deno-lint-ignore-file no-console` with a reason).
- Unused variables fail lint — delete them; do not underscore-prefix.
- Run `deno fmt` before `deno task fmt:check`; it also reformats markdown — never hand-wrap tables.
- `scripts/coverage.ts` tolerates empty coverage only while packages are stubs. It does NOT enforce
  the per-file 90% bar: `deno task test:coverage` has exited 0 with a `src` file at 80% branch. A
  green coverage run is NOT proof — read the per-file table yourself and enforce the bar (see the
  Self-review checklist and "Before reporting a task done").
- Use web-standard APIs in contracts (`Headers`, `SubtleCrypto`); runtime-specific shapes live
  behind `IRuntimeServices` only.
- `eval` and `new Function()` are forbidden (AI_GUIDELINES §13.5). NOTE: `deno lint`'s `no-eval`
  catches `eval()` but NOT `new Function()` — the gates will not flag it, so this is on you. To load
  Node builtins in `packages/runtime`, use static `node:` imports (Deno/Node/Bun all support them),
  never a smuggled `require`.
- **Never mix clocks.** `ctx.startTime` is `runtime.hrtime()` — a MONOTONIC reading
  (`performance.now()`, ms since an arbitrary origin), NOT a wall-clock epoch. Compute a request
  duration as `runtime.hrtime() - ctx.startTime` (both monotonic). `Date.now() - ctx.startTime`
  subtracts a small monotonic value from a ~1.7e12 epoch number, yielding a garbage duration on
  EVERY request (and tripping every slow-request threshold). Also: `Date.now()` is a runtime API —
  outside `packages/runtime`, get time only via `IRuntimeServices` (`runtime.now()` /
  `runtime.hrtime()`). The gates do NOT flag `Date.now()`, so this is on you.
- **A lazily-loaded optional dep must ACTUALLY load.** Use a real `await import('npm:<pkg>')` (or a
  client/factory injected through plugin options, AI_GUIDELINES §12.2) — never a `globalThis.__x`
  hook that only tests populate. A global-hook "loader" throws in production even when the package
  IS installed, because nothing ever imports it: that is a non-functional shim, not a lazy import.
  If a real `import()` forces the construction path to be async, make it async (`register()` may
  return a `Promise`); do not fake a sync constructor with a global.

## Self-review checklist (bugs that slipped through before — check every time)

- **Per-file coverage, not aggregate — and the gate won't enforce it for you**: the 90% bar applies
  to every file under `src/` on branch, function, AND line. Read the ANSI-stripped per-file table
  from `deno task test:coverage` yourself; its exit code is NOT the check (it exits 0 with a file
  under the bar). Any file below 90% on any of the three means the task is NOT done — write more
  tests until it clears. Test fixtures belong under `test/` and are excluded from measurement.
- **A coverage drop means write more tests, not ship it.** After every change, compare each file you
  touched to its previous branch/function/line numbers. A regression (even one still "passing" the
  silent gate) means you removed, bypassed, or added an untested path — restore it to ≥90% before
  reporting done; do not lower the bar or leave it. When a genuinely-new path is hard to cover
  deterministically — an environment-gated `await import()`, a platform branch, a `??` fallback the
  real path never takes — extract the decidable logic into an INTERNAL (non-`index.ts`-exported)
  seam and unit-test that seam's branches directly, rather than leaving the branch behind a test
  that skips. (An external I/O line that only runs when an optional dep is installed may stay behind
  a guarded/skipped test, but the branching logic around it must not.)
- **"Hard to cover" is NOT an accepted reason — and a note explaining why a file is under the bar is
  itself a gate failure.** The 90% branch/function/line bar is absolute; a `src` file below it means
  the task is UNFINISHED, full stop. Do not ship under the bar with a comment, a commit-message
  caveat, or a hand-off note rationalizing it ("inherently hard to exercise", "deeply nested
  comparison branches", "would require exhaustive fakes", "only runs with a real DB"). Every one of
  those is a real, cheap fix in this codebase, and each has a prescribed technique: **duplicated
  logic** → route it through the existing shared helper (a hand-rolled filter/sort/paginate copy of
  `query-builder.ts` is a defect, not a coverage problem — deleting the copy erases the branches);
  **a fallback/default only taken when an import or env differs** → extract it to an internal seam
  (`createDefaultXxx()`) and call it from a unit test; **a not-found / error / rollback branch** →
  drive it with a fake that returns nothing or a fake whose method rejects; **an arg-translation
  branch** → call the method with that option set and assert the translated call. If you genuinely
  believe a specific line is uncoverable, the bar to skip it is high: it must be a single external
  I/O call gated on an optional dep behind a guarded test (per the bullet above), you name the exact
  file:line, and you state which of the techniques above you tried and why each failed. Anything
  short of that, the answer is "write the test", never "explain the gap".
- **Token ↔ interface binding is fixed**: a service resolved from a `CAPABILITIES` token must be
  typed as that token's documented interface. Never resolve one token and cast to another interface.
  If no token fits the need, add one to `CAPABILITIES` (that is a public API change — update
  PUBLIC_API.md).
- **Short-circuit tests are mandatory**: any chain/dispatch mechanism (global middleware, route
  middleware, guards, hooks) needs an explicit test proving that when a stage responds without
  calling `next()`, downstream stages — including the handler — do NOT run and cannot overwrite the
  response.
- **One capability, one implementation — every entry point honors the same config.** When a behavior
  is reachable two ways (a service method AND a convenience helper or free function), both must
  funnel through ONE implementation. A helper that hardcodes a default while the service honors
  configured options is a silent split that passes every gate (a `validateBody(...)` helper that
  ignored the plugin's configured `errorFormat` shipped green once). Add a test that drives BOTH
  entry points under a NON-default configuration and asserts identical output.
- **Output that implements a named spec is asserted field-by-field, forbidden fields included.** For
  any body claiming to be RFC 7807 Problem Details, a NestJS error, an OpenAPI fragment, etc., a
  test must assert the exact documented shape from PUBLIC_API.md: required fields PRESENT and fields
  that must NOT appear ABSENT (Problem Details carries `detail`, never `message`). Stray fields and
  shape drift type-check and lint clean.
- **Hoist per-request work to registration time**: parse route patterns, compile chains, and build
  lookup structures once at startup, never per request (AI_GUIDELINES §14).
- **Test doubles must honor the real contract, or they hide the bug.** A fixture that stands in for
  a real component must reproduce that component's actual behavior. If the kernel sets `startTime`
  via `runtime.hrtime()` (monotonic), a fixture that sets it via `Date.now()` (epoch) will make a
  broken duration calculation pass — the fixture, not the code, is being tested. Cross-check every
  fixture value against how the real producer sets it (grep the kernel/runtime source), and for an
  external dependency, at least ONE test must exercise the REAL load/import path (guard/skip it when
  the dep is absent) so a stubbed-out fake is never the only path the suite ever runs.
- **Docs must match behavior — a green gate does not verify a claim.** JSDoc, comments, and
  PUBLIC_API.md must describe what the code actually does. "Lazily imported via `npm:pino`" on a
  function that never imports pino, or "@throws if X cannot be loaded from npm" when it throws
  because it never tries, are lies that pass every gate. When you touch a doc claim, confirm the
  code path it describes actually executes.
- **The principle: every symbol you declare must be read on a real code path — the same rule for an
  option, a constructor parameter, a class field, an exported function, an exported type, or a
  capability token.** If a name's only references are its declaration and its assignment, it is dead
  surface: wire it into a real path or delete it, and know that its JSDoc is a lie until you do. Do
  not read this as "options and parameters only" — a marker field no code branches on (the M12
  plan's `isIntegrationEvent` boolean, read by nothing in the milestone), an exported helper only
  its own test calls, or a type parameter no caller benefits from are all the identical defect.
  Worked example (option): a `ValidationPlugin` `sanitize` option was stored on the service but
  never applied, and shipped green once. For each symbol, `grep` that its name appears somewhere
  BEYOND its declaration and assignment; if not, wire it in or cut it.

## Before reporting a task done (evidence, not vibes)

Passing gates is necessary but NOT sufficient — these misses all passed the gates:

- **A no-op change passes every gate.** A mis-quoted flag (`"--exclude='/test/'"` in an args array),
  a `@ts-ignore`, a `new Function` shim, a `globalThis.__x` "lazy import" that never imports, a test
  that asserts nothing — all green, all wrong. Prove the change does what it claims: for a
  config/flag/exclude change, show the before→after behavior difference; for a bug fix, confirm the
  test fails WITHOUT the fix and passes with it; for an integration with an external dep or another
  package, exercise the REAL path once, not just the fake.
- **A no-op IMPLEMENTATION also passes every gate — when its tests assert the no-op.** M10 shipped
  Prisma/Drizzle adapters whose `create()` echoed input without persisting and `findAll()` returned
  `[]`, at 90%+ coverage, with ROADMAP deliverables checked ✅ — because the tests asserted the stub
  behavior and nothing ever read a write back. Before checking a deliverable: demonstrate it through
  the public surface (a running kernel app), and for every write, READ IT BACK through the same API
  and show the data returns. An implementation variant that cannot run against its real backend is
  driven with an injected fake that records calls — if the calls never arrive, the deliverable is
  not delivered. Checking a ROADMAP box is a behavioral claim, not a files-exist claim.
- **Read coverage ANSI-stripped, per file, after EVERY change — including deletions.**
  `deno coverage` colorizes output; naive parsing misreads the numbers (a `[33m` prefix turned 75.9
  into a false "OK"). Pipe through `sed 's/\x1b\[[0-9;]*m//g'` and confirm every changed `src` file
  is ≥90% on branch, function, AND line. The task's exit code is NOT the check — it exits 0 with a
  file under the bar; the per-file table is. Deleting or rewriting a test can drop an UNRELATED file
  below the bar, and the aggregate will hide it — re-check per file after refactors and deletions,
  not just additions. A file that lands exactly at 90 has no margin — prefer a couple of points of
  headroom.
- **Grep for constructs the gates don't catch**:
  `grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/<pkg>/src`
  — must be empty (comments excepted). `Date.now()` outside `packages/runtime` is a runtime-API /
  clock-mixing smell; `globalThis.__` is a fake-lazy-import smell.
- **Run the end-of-task self-audit — each item maps to a class of bug that shipped green before.**
  Paste the results: (1) execute each new pure transform (sanitizer, encoder, formatter, serializer)
  on a representative input and show input→output changing as intended, with HTML entities written
  literally (`&amp;`/`&lt;`), never the raw characters — identity-replacement and entity-collapse
  bugs type-check and lint clean; (2) for each option or parameter you added, grep that it is READ
  somewhere other than its declaration and assignment; (3) diff each spec-named output (RFC 7807,
  NestJS, OpenAPI) field-by-field against its PUBLIC_API.md example; (4) if a behavior has two entry
  points, confirm one test drives BOTH under a non-default configuration.
- **Report the evidence.** When handing back, paste the ANSI-stripped per-file coverage table and
  the grep result. "Done" without that evidence is not done.
- **Flip the milestone's status IN the milestone PR, before it merges.** A completed milestone is
  not done until its ROADMAP.md "Progress Tracking" row is `✅` AND the CLAUDE.md "Current status"
  section reflects it (mark the finished milestone complete with its PR number and point "Next
  milestone" at the following one). These edits belong on the milestone's own `feat/…` branch and
  ship in the SAME PR as the code — a merged PR that left the tracking table at `⬜` is a defect. If
  you catch a merged milestone whose status was never flipped, correct it on a `fix/…` branch (it is
  a defect in already-merged `main`), never by editing `main` directly.
- **Clean up plan/scratch files before you commit — a milestone commits exactly ONE plan.** The only
  `plans/` file a milestone PR may add or keep is its single canonical plan,
  `plans/milestone-<N>-<desc>.md`. Every transient artifact — continuation prompts, `fix-round-*`
  notes, `*-verification-issues.md`, hand-off prompts for a human or a local LLM, review dumps — is
  SCRATCH: write it under the session scratchpad directory, never under `plans/`, and never
  `git add` it. M10 shipped four `plans/milestone-10-*.md` files into the tree (main plan + three
  fix/continuation prompts) because scratch was committed — do not repeat this. Before every commit
  run `git status --short` and `git diff --cached --name-only`; if a transient plan/prompt file is
  staged, `git rm --cached` (or delete) it. When the milestone is complete, in the SAME PR that
  flips the status: `git mv plans/milestone-<N>-<desc>.md plans/archive/` and confirm
  `git ls-files plans/ | grep milestone-<N>` returns ONLY the archived path — any stray
  `plans/milestone-<N>-*` still tracked at the repo's `plans/` root is a defect the PR must remove.

## Key conventions

- Plans: one committed plan per milestone (`plans/milestone-<N>-<desc>.md`), archived to
  `plans/archive/` on completion in the milestone's own PR. All other prompts/notes are scratchpad
  only and never committed (see the plan-cleanup rule in "Before reporting a task done").
- Tests: `@std/testing/bdd` (`describe`/`it`) + `@std/expect` (`expect`), in
  `test/{unit,integration,e2e}/` per package. **Write every test with `describe`/`it` from
  `@std/testing/bdd` from the very first line — NEVER start with `Deno.test(...)` and convert it
  later.** `Deno.test` is banned in this repo; a test file's first test-framework import must be
  `import { describe, it } from '@std/testing/bdd';` and assertions use `expect` from `@std/expect`.
  Do not scaffold in one style and rewrite to another — that wastes the whole edit.
- No plugin imports another plugin — communicate via `ctx.services.get<T>(CAPABILITIES.X)`.
- Heavy deps (Prisma, Redis clients, …) are never hard dependencies: injected via options or lazy
  `npm:` imports (AI_GUIDELINES §12.2).
- Branches: one `feat/[milestone]-[description]` per milestone — all of that milestone's work and
  fixes stay on it until it merges; `fix/[issue]-[description]` is only for defects in
  already-merged `main`. Commits: conventional format (`feat(scope): subject`); no direct commits to
  `main`.
- **Pushing the branch and opening the PR/MR are manual, human-only steps — do not attempt them.**
  No remote credentials are available to the assistant, so `git push`, `git remote`, or any `gh`/API
  call to create the PR will fail and waste time. Once all gates pass and the milestone is committed
  on its `feat/…` branch, STOP: hand the human the exact `git push -u origin <branch>` and
  PR-creation command to run, and await the PR number to finish the CLAUDE.md "Current status" entry
  — record the milestone as "complete (PR pending)" until that number is known.
