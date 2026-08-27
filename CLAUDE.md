# Setu-TS — Session Instructions

Plugin-first enterprise backend framework. **Deno-first toolchain** (Deno 2 workspaces), published
to **JSR** under `@setu-ts`, consumable from Node/Bun via JSR npm compatibility.

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
4. **PUBLIC_API.md** — the sections for `@setu-ts/common` and any package you depend on, so you
   consume existing interfaces instead of inventing new ones.
5. **The `@setu-ts/common` source** for the interfaces you will implement — implement the committed
   contracts exactly; do not redefine, widen, or re-declare them.
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
- **Milestone 14c** (`packages/messaging-plugin` — brokered request-reply (RPC) added to the
  existing MessagingPlugin: `request<TReq,TRes>()`/`respond<TReq,TRes>()` on the committed
  `IMessageBroker` (flagged `common` widening — `RequestOptions`/`RequestHandler` types + the two
  methods, no new capability token), correlation carried inside a message envelope over each
  broker's existing `publish`/`subscribe` via a shared internal `RequestReplyCore` (NOT transport
  headers, which the in-memory and Redis brokers do not populate); reply-capable on
  in-memory/redis-streams/rabbitmq/ nats, while `KafkaBroker.request`/`respond` throw the exported
  `MessagingNotSupportedError` (consumer-group/auto-commit model); exported
  `RequestTimeoutError`/`RemoteHandlerError`/ `MessagingNotSupportedError`; developed in parallel
  with M28 in an isolated worktree off `main`) — complete (PR #60)
- **Milestone 14d** (`packages/messaging-plugin` — reply-transport seam + Kafka RPC: restores the
  per-broker `openInbox` seam the M14c plan specified but whose implementation collapsed into a
  `publish`/`subscribe`/`uuid`/timers delegation object that all four reply-capable brokers passed
  **byte-identically** — nothing named `IReplyTransport`/`openInbox` ever existed in `packages/`.
  That generic path works only because in-memory/redis/rabbitmq/nats treat a topic as cheap and
  per-instance-addressable, which is the real reason Kafka shipped a throw — not anything about
  consumer groups being inherently unable to do RPC. `RequestReplyDeps` gains `openInbox` returning
  a `ReplyInbox` (`address` + `close`); the four existing brokers pass the shared internal
  `createTopicInbox` and are behaviour-identical, while `KafkaBroker` supplies its own — a shared
  `replyTopic` (default `'messaging.replies'`) read under a per-instance consumer group
  `rr-inbox-<uuid>`. Chosen because `IKafkaFactory` exposes only `producer()`/`consumer({groupId})`
  and **no `admin()`**, so per-instance reply-topic creation is unreachable without widening an
  option-referenced facade; the topic must therefore pre-exist, and cross-instance replies are
  dropped by the existing correlation-id lookup so no envelope change was needed. Two defects fixed:
  RPC moved to a derived `rr.req.<topic>` channel (a deliberate **breaking wire change** vs
  `0.1.0-alpha.2`, recorded in CHANGELOG) so request envelopes stop leaking into plain `subscribe()`
  consumers and a responder sharing a topic AND a queue with an ordinary subscriber no longer
  swallows that subscriber's messages (fan-out consumers were never affected — the defect was
  narrower than the raw envelope leak); and the reply inbox now claims its own queue name, since
  `KafkaBroker.subscribe` otherwise falls back to the shared `'messaging-consumers'` group and
  misroutes replies. `MessagingNotSupportedError` is **deprecated, not removed** — AI_GUIDELINES
  §9.2 governs a published export and beats the dead-surface rule, which targets newly invented
  surface. No `common` contract change (JSDoc only); developed in an isolated worktree off `main`) —
  complete (PR #94)
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
  imports `npm:react-router@8` + the app-provided `ServerBuild`); `IRequestContext` ↔ web
  `Request`/`Response` bridge streaming through M42 `IResponse.stream()`, GET/HEAD bodies omitted;
  default `loadContext` exposing `{ services, user }`; catch-all mounted on all 7 verbs at
  `joinWildcard(basename)`; static-asset serving over `runtime.fs?.readFile` with symlink-safe
  containment via a new **optional `IFileSystem.realPath`** (`common`) implemented in the Node/Deno/
  Bun runtime adapters (degrades to lexical `..` containment when absent); a `react-router` health
  indicator and no `onClose` (stateless handler); `flatRoutes`/file-based routing supported
  transparently via the compiled build — complete (PR #57)
- **Milestone 26** (`packages/audit-plugin` — AuditPlugin registering an `IAuditLogger` under
  `CAPABILITIES.AUDIT`, backed by a pluggable internal `IAuditStorage` port; `AuditService.log()`
  stamps each `AuditEntry` with an internal `id` (`runtime.uuid()`) + wall-clock `timestamp`
  (`runtime.now()`) and deep-freezes it (immutability, including nested
  `before`/`after`/`metadata`); four storage backends — `MemoryAuditStorage` (zero-dependency
  default, non-durable, every runtime incl. Workers), `LogAuditStorage` (routes to the resolved
  `ILogger`; `query()` returns `[]`), `DatabaseAuditStorage` (inject-only via a structural
  `IAuditDbClient` — never the `database` token), and `FileAuditStorage` (JSONL read-modify-write
  over `runtime.fs`, Node/Deno/Bun only); shared `orderAndLimit`/`matchAuditQuery` query transforms;
  an `audit` health indicator and an `onClose` that drains the file write-chain; no `common` change,
  no new capability token — the contract and `AUDIT: 'audit'` token were committed in M1) — complete
  (PR #58)
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
  row + ROADMAP examples in the same PR) — complete (PR #59)
- **Milestone 28** (`packages/storage-plugin` — StoragePlugin registering `IStorage` under
  `CAPABILITIES.STORAGE`; five pluggable providers — `MemoryProvider` (zero-dep default),
  `LocalStorageProvider` (over `runtime.fs`), `S3Provider`, `GcsProvider`, and `AzureBlobProvider`
  (inject-or-lazy `npm:@azure/storage-blob@^12`); `'b2'` (Backblaze B2) as a first-class provider
  type reusing `S3Provider` over B2's S3-compatible endpoint; a zero-dependency multipart parser and
  an upload middleware factory `createUploadMiddleware` that exposes parsed files via `ctx.state`
  plus `getUploadedFile()` helper; optional `IStorage.getStream?` for zero-copy streaming downloads
  wired through M42 `IResponse.stream()`; per-provider `getSignedUrl` semantics (Memory → synthetic
  URL, Local → throws, S3/GCS/Azure → real presigned/SAS URLs); `storage` health indicator;
  `onClose` disconnect; full public API doc corrections in same PR) — complete (PR #63)
- **Milestone 29** (`packages/mail-plugin` — MailPlugin registering an `IMailer` under
  `CAPABILITIES.MAIL`, backed by a pluggable internal `MailProvider` port; four backends —
  `LogProvider` (zero-dependency default, records/logs each message, every runtime incl. Workers),
  `SmtpProvider` (inject-or-lazy `npm:nodemailer` via an
  `adaptNodemailerModule`/`loadNodemailerModule` seam + injectable `ISmtpTransport`, Node/Deno/Bun
  only — raw sockets), `SesProvider` (inject-or-lazy `npm:@aws-sdk/client-sesv2` via
  `adaptSesModule`/`loadSesModule` + injectable `ISesClient`), and `SendGridProvider` (SendGrid v3
  HTTP API over an injectable `fetch`-shaped `IMailHttp`, zero-dependency, Workers-portable);
  `MailService` resolves the default `from` once (both `send` and `sendTemplate` funnel through it)
  and dispatches; a zero-dependency `TemplateEngine` renders named `{{ variable }}` bodies with
  HTML-escaping on the `html` body and a throw on a missing variable / unknown template; a `mail`
  health indicator and an `onClose` that disconnects the provider; no `common` change — the
  `IMailer`/`MailMessage` contract and `MAIL: 'mail'` token were committed in M1; corrected the
  PUBLIC_API Mail `sendTemplate` example (subject is required) in the same PR; developed out of
  order in an isolated worktree off `main`, in parallel with M28) — complete (PR #61)
- **Milestone 45** (`packages/worker-pool-plugin` — WorkerPoolPlugin registering an `IWorkerPool`
  under a new `CAPABILITIES.WORKER_POOL = 'worker-pool'` token; runs CPU-bound work on real worker
  threads off the event loop. Task handlers addressed by **module specifier** (never closure);
  inputs/outputs by structured clone. Thread primitive is a new **optional**
  `IRuntimeServices.workers?: IWorkerHost` (+ `IWorkerHandle`), a flagged `common` widening
  alongside the M44 `fs?` precedent — implemented by `createNodeWorkerHost` (`node:worker_threads`)
  and `createWebWorkerHost` (web `Worker`, Deno/Bun), and OMITTED on Cloudflare Workers (no edge
  threads → `run()` throws `WorkerPoolUnavailableError`, plugin still registers). Worker-side helper
  `defineWorkerTask` ships as a new `@setu-ts/runtime/worker` subpath (its sole export); host↔worker
  envelope protocol (`WorkerReadySignal`/`WorkerTaskRequest`/`WorkerTaskReply` + three guards) lives
  in `common` so both runtime (worker side) and plugin (host side) read it without a plugin
  importing another plugin. Internal `TaskPool` (one per specifier, lazy; spawn-on-demand to size,
  idle reuse, bounded FIFO queue): handler-error → `WorkerTaskError` + worker retained; worker crash
  → drop + re-dispatch queued work; timeout → `WorkerTaskTimeoutError` + terminate & replace; queue
  overflow → `WorkerQueueFullError`. `worker-pool` health indicator (`{ available, pools }`) +
  `onClose` terminates all. Real-thread e2e on Deno spawning fixture task modules; developed in an
  isolated worktree off `main`) — complete (PR #64)
- **Milestone 30** (`packages/notification-plugin` — NotificationPlugin registering an `INotifier`
  under `CAPABILITIES.NOTIFICATION`, backed by a two-layer channel → transport design: four channels
  own address extraction and payload shaping (`EmailChannel` reads `to.email` and delegates to the
  `IMailer` resolved from `CAPABILITIES.MAIL`, `SmsChannel` `to.phone`, `PushChannel` `to.token` +
  `subject` as title, `SlackChannel` optional `to.channel`), while three zero-dependency HTTP
  providers own transport (`TwilioProvider` form-encoded Basic-auth REST, `FcmProvider` legacy
  `serverKey` `POST /fcm/send`, `SlackProvider` incoming webhook with the compound
  HTTP-200-AND-body- `ok` check) behind one injectable `INotificationHttp` seam defaulting to
  `createDefaultNotificationHttp()` (web-standard `fetch`, so every channel is Workers-portable, no
  `npm:` import anywhere); `NotificationService.send` fans out with `Promise.allSettled` and throws
  `AggregateError` whose `errors` are coerced to `Error`, so one failing channel never aborts the
  others; `ChannelConfig` is a union discriminated on `provider` and `createProvider` is overloaded
  per arm, so a missing credential is a compile error rather than a startup throw; `email`
  configured without a `mail` capability throws during `register` (fail fast, ordered by
  `optionalDependencies: ['mail']`); a `notification` health indicator and no `onClose` (stateless
  providers); no `common` change — the `INotifier`/`NotificationMessage` contract and
  `NOTIFICATION: 'notification'` token were committed in M1; corrected the PUBLIC_API/ROADMAP
  `sendEmail`/`sendSms`/`sendSlack` examples to the committed one-method `send` surface, dropped the
  email `options` bag, fixed the Twilio registration example that omitted the required `from`, and
  added the missing Notifications Options/Exports/Notes sections in the same PR; the legacy FCM
  `serverKey` API it ships was decommissioned by Google in 2024 — **fixed in M30b**, which moves the
  provider to FCM HTTP v1) — complete (PR #65)
- **Milestone 30b** (`packages/notification-plugin` — FCM HTTP v1: M30's `FcmProvider` posted to
  `POST /fcm/send` with `Authorization: key=<serverKey>`, the API Google switched off in 2024, so
  the push channel could never succeed against a live project — a defect repair, not a feature. Now
  posts to `/v1/projects/{projectId}/messages:send` with an OAuth2 bearer token minted from a
  service account: an internal `ServiceAccountTokenSource` signs an RS256 JWT assertion with
  `runtime.subtle` (same route as M16's `JwtService`;
  `importKey('pkcs8', …,
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })`), exchanges it at
  `oauth2.googleapis.com/token` over the existing `INotificationHttp` seam, and caches both the
  imported key and the token until 60 s before expiry — so a send costs one request in the steady
  state. Zero npm dependencies, Workers-portable. `FcmProviderOptions.serverKey` is **replaced, not
  deprecated**, by `{ projectId, clientEmail, privateKey }`: §9.2's deprecate-then-remove assumes a
  working replacement path, and `serverKey` addressed a dead endpoint, so a compile error is the
  correct signal (maintainer-approved). `createProvider`'s `fcm` arm now takes `IPluginContext` and
  throws during `register` when `CAPABILITIES.RUNTIME` is absent, mirroring the `mail` arm — unless
  an exported `FcmTokenSource` is supplied, which carries its own credentials (GCP metadata server,
  key broker) and lifts the runtime requirement. `pemToDer` is a deliberate local copy:
  auth-plugin's is internal and AI_GUIDELINES §2.2/§3.3 forbid a plugin importing another plugin. A
  real-crypto test generates an RSA keypair, signs an assertion and verifies it, so the signing path
  is exercised for real rather than only behind a fake. No `common` change, no new capability token;
  developed in an isolated worktree off `main`) — complete (PR #96)
- **Milestone 46** (`packages/websocket-plugin` — WebSocketPlugin registering an `IWebSocketService`
  under a new `CAPABILITIES.WEBSOCKET = 'websocket'` token; full-duplex bidirectional messaging,
  completing the real-time story M43's SSE plugin covers one-way. The RFC 6455 handshake needs the
  **native** `Request` and answers with a 101 carrying a socket, neither of which `IRequest`/
  `IResponse` can express — and `mapWebRequestToFrameworkRequest` pre-reads the body, which
  _disturbs_ it and makes `Deno.upgradeWebSocket` fail outright. The upgrade is therefore
  intercepted inside the HTTP adapter via one new **optional**
  `IHttpAdapter.setUpgradeRouter?(router)` member (a flagged `common` widening alongside the M44
  `fs?` / M45 `workers?` precedents); the router answers accept / reject / `null`-fall-through, so
  non-WebSocket traffic is untouched. All four runtimes implemented: Deno (`Deno.upgradeWebSocket`
  on the fetch path), Cloudflare Workers (`WebSocketPair` + a 101 carrying the client half), Bun
  (`server.upgrade` inside `Bun.serve`'s fetch callback returning `undefined`, with serve-time
  `websocket` handlers routing through `ws.data.sink`), and Node (the raw `upgrade` event on the
  `node:http` server `serve()` returns, with `npm:ws@^8` inject-or-lazy via
  `adaptWsModule`/`loadWsModule` and a `NodeUpgradeCoordinator`; `@hono/node-ws` was rejected with
  cause — its shipped types require a concrete `Hono` app and it peer-deps
  `@hono/node-server@^1.19.11` against the `^2` this repo pins). Plugin ships an exact-path route
  table (kernel's matcher is internal, so no `:param` patterns and no duplicated matcher), named
  `WebSocketRoom` broadcast groups with `except` and auto-eviction of closed members, an
  application-level heartbeat + idle sweeper (`heartbeatMs`/`heartbeatPayload`/`idleTimeoutMs` —
  protocol pings are unusable since Deno and Workers expose no `ping()`), `maxConnections` (503) and
  `maxMessageBytes` (1009) admission control, single-value subprotocol echo from a configured
  allow-list, a `websocket` health indicator, and an `onClose` that closes every connection with
  `1001`. Real-socket e2e on Deno caught a bug no fake would have: the connection context was built
  lazily in `onOpen`, which fires after the handshake response is returned, by which point the
  runtime has closed the native request — it is now snapshotted in the router. Code review then
  caught that `maxConnections` could be exceeded, because connections registered only at `onOpen`
  while the capacity check ran before the handshake completed; slots are now claimed at accept time
  and released by all four adapters through `sink.onClose({ code: 1006 })` when a handshake fails
  after acceptance, so malformed upgrades cannot starve the limit. Outstanding: the root `README.md`
  WebSocket row was deferred at the maintainer's request) — complete (PR #66)
- **Milestone 31** (`packages/feature-flags-plugin` — FeatureFlagsPlugin registering the committed
  synchronous `IFeatureFlags` under `CAPABILITIES.FEATURE_FLAGS`, backed by an exported
  `FlagProvider` port whose implementations own a cached snapshot plus an async `start()`/`stop()`
  lifecycle the plugin drives from an async `register()` (genuinely awaited by the kernel) and
  `onClose`; three providers — `ConfigProvider` (immutable inline flags, `'config'`),
  `MemoryProvider` (mutable map with `setFlag`/`removeFlag`/`replaceFlags`), `DatabaseProvider`
  (injected structural `IFlagStore`, single `runtime.setInterval` poll armed once in `start()`,
  keeps the last good snapshot on poll failure and reports it) — plus a `'custom'` arm accepting any
  `FlagProvider`; one pure zero-dependency `evaluateFlag` seam whose precedence is
  **allowlist-first** (`users` overrides `enabled: false`, so the committed
  `{ enabled: false, users: [...] }` examples behave as documented) then `enabled`, then a
  deterministic FNV-1a-32 `bucket(flag, userId) % 100` percentage rollout (no `userId` on a partial
  rollout → `false`); a free-function `createFlagGuard(flag, options?)` route guard (302 `fallback`,
  else `statusCode ?? 404`, short-circuiting without `next()`, letting an unregistered-capability
  error propagate) rather than a `middleware` method on the committed contract; a `feature-flags`
  health indicator reporting `'degraded'` with `detail` when a provider's optional `status()`
  reports unhealthy; no `common` change and no npm dependency — the `IFeatureFlags`/`FlagContext`
  contract and `FEATURE_FLAGS: 'feature-flags'` token were committed in M1. **LaunchDarkly was
  deferred**: the Node server SDK's `variation`/`allFlagsState` are async (verified from
  `@launchdarkly/js-server-sdk-common` `LDClient.d.ts`), so no provider can satisfy the synchronous
  `isEnabled` without widening `common`; the `'custom'` arm was the documented bridge. **Resolved in
  M47** — `LDFlagsState.getFlagValue` is synchronous, which is the bridge, plus an optional
  `IFeatureFlags.isEnabledAsync`. Corrected the ROADMAP/PUBLIC_API `flags.middleware(...)` examples
  to `createFlagGuard`, dropped LaunchDarkly from the ROADMAP provider list and ARCHITECTURE Rules
  row, added the missing Feature Flags Options/Exports/Notes sections, and fixed the ROADMAP
  implementation-files list in the same PR) — complete (PR #67)
- **Milestone 32** (`packages/multi-tenancy-plugin` — MultiTenancyPlugin factory; four resolvers:
  Subdomain/Header/Path/Jwt; three isolation strategies: Column/Schema/Database; `ITenantDataStore`
  port + `MemoryTenantDataStore` default; `TenantRepository`; cache-key isolation via
  `prefixCacheKey`; `tenantMiddleware` at priority 40; `multi-tenancy` health indicator; widening
  `common` with `IMultiTenancyService`, `ITenantRepository<Entity, Id>`, and `IRequest.tenant`;
  correcting ROADMAP ctx-less example, PUBLIC_API common row, ARCHITECTURE priority table per
  C-series conflicts; post-implementation fixes: `SubdomainResolver`'s `baseDomain` now constrains
  resolution instead of being ignored — `evil.com` resolved a tenant before; the memory store hands
  out detached row snapshots and never allocates a partition on a read path; the committed
  `prefixCacheKey` lost a third `separator?` parameter the implementation ignored; a real kernel-app
  integration test was added because none existed; an empty resolver chain and a malformed injected
  `dataStore` now fail at `register()` rather than per request; all 15 test files were converted
  from the banned `Deno.test` to `describe`/`it` + `expect`) — complete (PR #71)
- **Milestone 33** (`packages/testing` — test utilities; depends on `common` + `kernel` only, no
  plugin and no npm dep) — `createTestApp` wrapping `createApplication` + auto-`start()` with no
  port (so `inject()`/`fetch()` work with no socket) plus an `autoStart: false` escape hatch;
  `createMockPlugin` collapsing the `provides: [CAPABILITIES.RUNTIME]` plugin literal hand-rolled in
  nine packages; a free-function `inject` accepting a URL string / `InjectRequest` / web `Request`;
  `createTestContext` replicating the kernel's internal `createRequestContext` (monotonic
  `startTime` via `hrtime()`, never `Date.now()`; live `AbortSignal`; `request.signal` > `signal` >
  default precedence); `MockServiceRegistry` and `MockResponse` standing in for the kernel-internal
  `ServiceRegistry`/`ResponseBuilder`; `FixtureManager`; and `collectStream` for reading a streaming
  `fetch()` body incrementally. Two kernel constraints are load-bearing and documented rather than
  worked around: `plugins` must include a `runtime` provider (the kernel makes it mandatory at
  `start()` and this package cannot import `RuntimePlugin`), and global middleware needs
  `autoStart: false` because `start()` compiles the pipeline. Verification corrected a committed
  `PUBLIC_API.md` example that called `inject()` without `start()` (it throws), and
  post-implementation review fixed contract-infidelities in the default test runtime that the tests
  had enshrined — `env` was a `Map` cast to a `Record`, `subtle` was `null`, `randomBytes(n)`
  returned 0 bytes, and the timers were real rather than inert — plus a `MockRequest` whose `json()`
  returned an object body while `text()`/`bytes()` silently dropped it — complete (PR #78)
- **Alpha release `v0.1.0-alpha.1`** — taken out of band before M34, on `release/v0.1.0-alpha.1`
  (not a milestone, so not a `feat/…` branch). All 40 workspace members bumped to `0.1.0-alpha.1`;
  the 11 explicit `jsr:@setu-ts/{common,kernel}@^0.1.0` specifiers bumped alongside, because a
  `^0.1.0` range does NOT match a prerelease and `deno publish` does not warn. **35 implemented
  packages publish; the 5 stubs (`cli`, `sdk`, three starters) do not** — `deno publish` from the
  workspace root would push all 40, so releases go through `scripts/publish-packages.ts`, which
  walks an explicit dependency-ordered allow-list in `scripts/release-packages.ts` one package at a
  time. `deno task release:verify <version>` guards the four things the gates cannot see (version
  agreement, specifier resolvability, full workspace coverage, no stub in the list). Added a
  `CHANGELOG.md`, a tag-triggered `.github/workflows/release.yml`, and the 23 missing package
  READMEs. **JSR versions are immutable** — yankable, never deletable or replaceable.
- **Alpha release `v0.1.0-alpha.2`** — on `release/v0.1.0-alpha.2`, published 2026-07-28. **36
  packages** (adds `cli`); only `sdk` and the three starters remain unpublished. The whole scope
  moves as ONE version because the CLI forces it: `setu new` stamps generated projects with the
  CLI's OWN version as the range for `kernel`/`runtime`/`common`/every template plugin, so a CLI at
  `alpha.2` beside a framework at `alpha.1` would scaffold projects pinning versions that do not
  exist. Also fixed 44 relative links across 28 package READMEs — JSR resolves a README's relative
  links against `jsr.io/@setu-ts/`, so `../../PUBLIC_API.md` returned a 400 `malformedRequest` on
  every package page; package READMEs must use absolute GitHub URLs. **This was the first release CI
  published.** `alpha.1` went out by hand because the workflow failed every time, in three distinct
  ways, none reproducible locally: (1) the publish step lacked `--allow-env`, because the workflow
  inlined its own `deno run` instead of calling the `release:publish` task and the copy drifted — it
  now calls the task; (2) it also lacked `--allow-net`, needed by the already-published check, which
  `--dry-run` SKIPS, so a green dry run proves nothing about a real run; (3) no package was linked
  to the GitHub repo, which tokenless OIDC requires and token publishing does not — hence `alpha.1`
  never hit it. `deno task
  release:link-repos` links all 36 through the API. Do NOT read
  `githubRepository: null` on already-published packages as evidence the link is optional; those
  were published with a token. **Six packages went live with no visible README** (`cli`,
  `feature-flags-plugin`, `multi-tenancy-plugin`, `openapi-plugin`, `queue-plugin`,
  `storage-plugin`) — not a packaging fault: `/README.md` is in every published tarball manifest. A
  JSR package's `readmeSource` setting defaults to `jsdoc`, and JSR renders README.md only as a
  FALLBACK — `render_docs_html` builds the entrypoint's module doc first and substitutes the README
  only `if index_module_doc.sections.docs.is_none()`. deno_doc DROPS prose that follows a tag, so a
  block opening with `@module` has no description, the fallback fires, and the README renders; a
  block whose description comes first and ends with `@module` HAS a description, so that
  one-paragraph blurb becomes the entire package page. Those six were the only entrypoints written
  description-first. `deno task release:verify` now enforces `@module`-first as check 5, because
  nothing else sees this — the README ships in the tarball, so the gates, the coverage bar, and
  `deno publish --dry-run` are all green and the loss shows up only on jsr.io. Fixing it in source
  only takes effect on the NEXT version (JSR versions are immutable); to fix an already-published
  page, PATCH `readmeSource: 'readme'` on the package via the API — but that setting also suppresses
  the module JSDoc's `@example` "Examples" section, which is why the source fix, not the setting, is
  the durable one.
- **Milestone 34** (`packages/cli` — the `setu` CLI: `new` project scaffolding and plugin-aware
  `generate` code generation. `runCli(argv, deps)` returns an exit code and never calls `Deno.exit`;
  `src/main.ts` is the sole process boundary (`Deno.args`, `Deno.cwd()`, `console`, the Deno
  filesystem, the one `Deno.exit`) and `CliDependencies` deliberately has NO default — a defaulted
  `fs` is exactly what let the first draft ship a CLI that printed "Created README.md" while writing
  nothing. Zero-dependency `parseArgs` supporting `--key=value` AND `--key value` for the declared
  value flags (`--dir`, `--runtime`); one `deriveNames` producing five casings that all 13
  schematics share; schematics are PURE `(names, options) => GeneratedFile[]` so `--dry-run` is
  exact and the overwrite check ("check every planned path, then write") lives in one place.
  Registry is a `Map`, not an object literal, so `setu g constructor x` misses cleanly instead of
  resolving `Object.prototype`. `--runtime deno|node|bun|cloudflare-workers`: Deno gets
  `deno.json` + `main.ts` binding via `app.start({port})`; node/bun get `package.json` (npm-compat
  `@jsr/…` deps) + `.npmrc`
  - `tsconfig.json`; Workers get `wrangler.toml` + a `fetch` export and NO `listen`. Seven
    schematics are gated on their backing plugin, detected by reading the target project's manifest
    — never by booting it. Custom schematics load through a real `await import()` behind an
    injectable `ModuleLoader` seam, with a guarded real-import integration test. `VERSION` is a
    static JSON import of the package's own `deno.json` (no drift, and `deno publish` includes the
    file). **The generated code is verified, not assumed**: a drift gate scaffolds a project,
    generates all 13 schematics into it, and runs `deno check` against the real published JSR
    packages — it caught `ctx.request.params` (params live on `IRequestContext`) and missing
    `experimentalDecorators`. Doc deliverables C1–C6 shipped: `setu` everywhere, ARCHITECTURE deps
    corrected to `common` + `runtime` (not `kernel`), the `ICliApi` JSDoc no longer claims a
    consumer that does not exist, `metric`/`migration` added to the ROADMAP file list, `--template`
    dropped to M36. Post-implementation code review found and fixed six correctness bugs the gates
    passed: a relative `--dir` resolved custom schematics to the FILESYSTEM ROOT while built-in
    schematics resolved against the CWD (fixed by `resolveDir` at both command boundaries);
    `generate` silently swallowed an invalid `--runtime` that `new` rejected; a name normalizing to
    nothing wrote a hidden `src/services/.service.ts`; `g route class` emitted `(class) => {` — a
    SyntaxError, fixed in the TEMPLATE with a fixed `routes` identifier rather than by rejecting the
    name, since `/class` is a legal route path; a digit-leading name emitted `class 2faService`; and
    `new --help` exited 2. The last two slipped through because the drift gate only ever used the
    name `order-item` — M34b's e2e gate takes a hostile-name set) — complete (PR #88)
- **Milestone 34b** (`packages/cli` — `setu new --template rest|microservice`, a `setu.config.ts`
  application seam, and discovery/dispatch of plugin-contributed CLI commands via
  `ICliApi`/`CAPABILITIES.CLI_COMMAND`, committed since M1 with no reader until now. Every
  scaffolded project — templated or not — exports `createApp()` from `setu.config.ts`; `main.ts`
  imports it to start the server and the CLI imports it to find commands, so the plugin list has ONE
  home. The factory must NOT start the app: M34's `main.ts` called `start({port})` at module scope,
  so importing that would bind a socket. Templates emit INLINE wiring, never `*-starter` imports —
  those packages still `export {}` and M36 owns them — with `rest` = 9 plugins + `errorHandler()`
  MIDDLEWARE (`exceptions` ships middleware, not a plugin) and `microservice` = rest +
  messaging/queue/resilience/telemetry, refused on `cloudflare-workers` because brokers need raw
  sockets. Discovery calls `start()` with NO port (the kernel skips `listen` without one), but
  init/bootstrap hooks DO run — a database plugin connects — so teardown is unconditional; built-in
  verbs match first and never boot the project; duplicate command names are refused rather than
  resolved by plugin load order. **The hostile-name e2e gate found an M34 defect already merged to
  `main`**: `g controller` emitted a `decorator-plugin` import while ungated, so a fresh project got
  source whose own import could not resolve — M34's drift gate missed it because the manifest was
  hand-patched to make it pass. Now gated, and `rest` installs `DecoratorPlugin`. That gate spawns
  `deno check` in a subprocess (so `packages/cli/deno.json` grants `run`) and repoints the generated
  project's imports at THIS workspace rather than JSR — which is both more correct (drift means
  disagreement with HEAD, not with a published snapshot) and necessary: `setu new` pins generated
  projects to the CLI's own version, so during a version bump the pinned version is not published
  yet, and checking against JSR would deadlock the release workflow's own test step against the
  publish that would fix it) — complete (PR #89)
- **Milestone 47** (alpha-3 limitation closeout — the three `CHANGELOG.md` "Known limitations" from
  `v0.1.0-alpha.1` that were real capability gaps rather than wording problems. Taken out of order,
  before M35/M36, because they gate the `v0.1.0-alpha.3` release; delivered on ONE combined branch
  at the maintainer's direction rather than three, since they share that gate. **A.**
  `packages/resilience-plugin` timeouts now cancel: `common` gains `ResilientCall`/`HardenedCall`
  and `IResilienceService.wrap` + `ICircuitBreaker.execute` are widened to use them —
  source-compatible for CALLERS, breaking for IMPLEMENTORS because `fn` sits in a contravariant
  position (established with `deno check`, not assumed; the only in-repo implementors were two
  structural test doubles). A new `patterns/abort.ts` owns `linkAbort`/`throwIfAborted`/
  `abortReasonOf` with listener disposal, so a long-lived caller signal cannot accumulate one
  listener per invocation; `timeout` aborts the per-attempt controller with the SAME `TimeoutError`
  instance it rejects with (one error identity); `retry` checks the signal before each attempt and
  wakes its backoff early on abort (that sleep also leaked its timer handle on every attempt
  before); a `bulkhead` waiter cancelled while queued leaves the queue and never runs its call.
  **B.** `packages/feature-flags-plugin` gains a `LaunchDarklyProvider`. Every evaluation method on
  the Node server SDK is async, so the bridge is `LDFlagsState.getFlagValue` — the SDK's one
  SYNCHRONOUS read, verified against the shipped `.d.ts` AND against a real client — behind a
  per-context snapshot cache whose cold read returns a configured `fallbackValue` and schedules a
  background refill (coalesced per key, so a hot loop over an uncached user does not stampede).
  `common` gains an OPTIONAL `IFeatureFlags.isEnabledAsync` carrying no cold-context caveat, and
  `FeatureFlagService` funnels both entry points through ONE provider. Structural facades keep the
  SDK's `any`-typed `EventEmitter.on` at the boundary; the load-failure branching is an internal
  `toLoadFailure` seam so it is unit-tested rather than left uncovered behind the guarded real
  import. **C.** cross-replica fan-out: `common` gains the `IRealtimeBackplane` port,
  `RealtimeFrame`, a new `CAPABILITIES.REALTIME_BACKPLANE` token, and the pure `encodeFrameData`/
  `decodeFrameData` codec — in `common` because three packages need the identical wire shape and no
  plugin may import another. A NEW `packages/realtime-backplane-plugin` ships `'memory'` (default, a
  REAL single-process bus rather than a no-op), `'messaging'` (over `CAPABILITIES.MESSAGING`,
  reusing all five existing brokers with zero new deps), `'redis'`, and `'custom'` transports;
  `websocket-plugin` and `sse-plugin` resolve the token OPTIONALLY, so absent it nothing changes,
  and both `register()` become async to await their subscription. Redis uses TWO connections because
  a subscriber-mode connection refuses every other command — a protocol property invisible to any
  single-fake test, so the constructor refuses a client injected without its subscriber. Loop
  prevention is a per-instance origin stamp; an arriving frame is delivered through a local-only
  path and NEVER re-published, and never creates a room/channel that does not already exist locally.
  `RoomBroadcastOptions.except` IS honored cluster-wide — connection ids are `runtime.uuid()` and
  therefore globally unique, so the frame carries `exceptId` and every replica skips the match.
  `Room.size`/`SseChannel.size` stay LOCAL, and that one is genuine: a cluster-wide count is
  inherently async (scatter-gather), so it cannot satisfy the synchronous committed `size` getter
  and wants a separate async method — deferred to a presence milestone as a CONTRACT decision, not
  an implementation gap. Added the new package to `scripts/release-packages.ts`) — complete (PR #97)
- **Milestone 35** (`packages/sdk` — client SDK) — portable, zero-npm-dependency HTTP client with
  bearer/API-key auth interceptors, client-side resilience (retry with fixed/exponential backoff and
  delta-seconds `Retry-After`, a rolling-window circuit breaker, a sliding-window rate limiter),
  request/response interceptors, and a pure OpenAPI 3.1 → TypeScript code generator. The only
  in-repo import is type-level from `common`; no kernel, no plugin, no npm dependency, so it runs in
  a browser. Two seams keep it testable without real time or a network: an injected `fetch` and an
  `IClientTiming` (`performance.now()` + abort-aware `sleep`) that `createClient()` defaults, so
  `Date.now()` never appears. The breaker's `resetTimeout` is measured from the trip, NOT from the
  oldest failure in the rolling window — conflating the two silently closed the circuit whenever
  `timeout < resetTimeout` and made half-open unreachable — and a failed probe restarts the cooldown
  so a dead dependency is probed once per cooldown rather than on every request. Codegen output is
  verified by a committed fixture that `deno task check` type-checks (`deno check` covers `test/`),
  which is what a subprocess check could not do: it compiled a temp file in isolation and could not
  catch emitted source disagreeing with the SDK's own `IHttpClient`. Review found the generator
  emitted the raw `operationId` into a JSDoc comment escaped only for string literals, so a document
  carrying a comment terminator injected EXECUTABLE code into the generated factory — a payload that
  type-checked and ran; comment text is now escaped for its own context. It also rejected two
  silent-corruption cases it used to emit: a path placeholder with no declared parameter (which
  produced source referencing an undeclared identifier) and a declared path parameter absent from
  the template (whose value was dropped). `packages/sdk` moves from `UNPUBLISHED_PACKAGES` to
  `PUBLISHED_PACKAGES` Tier 3, so `release:verify` now reports 38 publishable packages; the next
  release must run `release:create-packages` and `release:link-repos` before the first sdk publish,
  because tokenless OIDC requires the repo link) — complete (PR #98)
- **Milestone 36** (`packages/starters/rest-starter`, `packages/starters/microservice-starter`,
  `packages/starters/full-stack-starter` — opinionated plugin composition libraries:
  `createRestApp`, `createMicroserviceApp`, `createFullStackApp` with pre-wired plugin sets, option
  arms, and Workers- portability documentation) — complete (PR #106)
- **Alpha release `v0.1.0-alpha.3`** — on `release/v0.1.0-alpha.3`, published 2026-07-30 (PR #99,
  tag at the merge commit `672b2f5`; CI published it, one green `Publish to JSR` job). **38
  packages** — `sdk` (M35) and `realtime-backplane-plugin` (M47) published for the first time; only
  the three starters remain unpublished. Verified after publishing by querying all 38 on the
  registry, then installing `kernel` + `runtime` from JSR into a throwaway dir and serving a request
  (`200`); `common` resolved transitively at alpha.3, which is the only real evidence the
  cross-package specifier bump landed inside the published tarballs. The six formerly-READMEless
  pages render their READMEs, checked against their alpha.2 counterparts so the check distinguishes
  rather than passing vacuously. All 41 workspace members bumped as one version (the CLI forces it —
  see alpha.2). Carries the queued JSR README fix (cherry-picked `9a913b8`, which was cut from a
  pre-M14d `main` and so could not be merged as a branch), whose `release:verify` check 5 enforces
  `@module`-first; proved live by moving `@module` in `packages/sdk` and confirming the check
  flagged exactly that package. **Two breaking changes ride together** and the release notes state
  both in full rather than only linking them: the M14d `rr.req.<topic>` RPC wire change (restart
  callers and responders together, do not roll) and the M30b FCM `serverKey` → service-account
  replacement (a deliberate compile error). **FCM HTTP v1 ships unverified against live FCM** — the
  wire shape is asserted field by field and the RS256 assertion signed with real Web Crypto, but no
  test reaches Google and CI holds no Firebase project; stated plainly in the release notes as the
  maintainer's call rather than left implicit. Two version-bump traps this release surfaced, now in
  `docs/releasing.md`: `packages/sdk` writes its `jsr:` specifier INLINE in four `src/**` files (not
  through an import-map alias) and its manifest maps that exact specifier string to a pinned
  version, so source and both sides of the mapping must move together —
  `grep -rn '<old-version>' packages/*/src` must come back empty; and the cross-package pin count is
  now 12 manifests (`{common,kernel,runtime}`), not the 11 the runbook claimed. Also corrected the
  root README, which listed the SDK under "Not yet built" while marking it ✅, had no
  `realtime-backplane-plugin` row, and claimed 36 packages / 30 plugins.
- **Milestone 48** (`packages/session-plugin` — cookie sessions and form CSRF: `SessionPlugin`
  registering an `ISessionService` under a new `CAPABILITIES.SESSION` token, the capability the
  framework had none of — `tokens.ts` declared no `SESSION` and `auth-plugin` ships JWT/API-key/
  refresh/RBAC with no cookie surface at all. Default is a self-contained **encrypted** cookie:
  AES-256-GCM under an HKDF-SHA256 key, entirely via `runtime.subtle` (the M16 `JwtService`
  precedent), so zero npm deps and Workers-portable. Setting `store` (`'memory'`/`'cache'`/custom
  `ISessionStore`) moves the payload server-side behind an opaque id, which is the only way to get
  immediate revocation — the cookie strategy's documented trade-off is that a stolen cookie stays
  valid until `Max-Age`. `mode: 'sign'` (HMAC, payload READABLE) pairs with the store strategy;
  `'encrypt'` is the default so the exposing choice is never accidental. Rotation is a key list —
  index 0 seals, every entry opens — addressed by an HKDF-derived non-secret `kid` in the envelope,
  so opening is O(1) rather than trial decryption. Expiry is server-authoritative: `maxAge` lives in
  the sealed payload as a `runtime.now()` wall-clock stamp, because a cookie's `Max-Age` is
  client-controlled; plus `rolling` and `idleTimeoutMs`. Form CSRF ships **in this package** (the
  synchronizer-token strategy, a different mechanism from http-security-plugin's stateless
  Origin/Referer check, which a `<Form>` post structurally cannot satisfy via `customHeader`) with
  the token in session data — no second cookie, no second secret, and the published plugin
  untouched; `csrfFormMiddleware` at 275 and a standalone `verifyCsrfToken` sharing one
  implementation for React Router actions. Sessions reach handlers via `ctx.state` + one
  `getSession(ctx)` accessor and **no `common` widening**: `IRequestContext` is fully `readonly`, so
  a `session` member would force every producer to build one, and the ROADMAP's floated
  `IRequest.cookies` was declined as a field no code path reads. Commit-on-response is sound because
  the kernel's `appendHeader` never consults `#ended` and `snapshot()` returns live `Headers` —
  verified in source, not assumed. Three ROADMAP claims did not survive source-checking:
  `decorator-plugin`'s `parseCookies` is **exported public API**, not private, so it now delegates
  to the new `common` codec and its three behaviour corrections (percent-decoding, quote stripping,
  first-occurrence-wins) are a CHANGELOG'd defect fix; the `v1.iv.ciphertext.tag` envelope is
  **unreproducible** on Web Crypto, which concatenates the tag with no `getAuthTag()`, so the wire
  shape is `v1.<kid>.<iv>.<sealed>`; and `storage-plugin` was declined as a store backend because
  `IStorage` has no TTL. Post-implementation code review then caught two High defects in the commit
  path, both in options that the happy-path tests exercised only in isolation: `regenerate()`
  followed by `destroy()` in one request leaked the pre-regeneration store row — after a regenerate
  `session.id` is the NEW id, never written to the store, while the presented cookie carries the old
  one, so a stolen copy of it kept authenticating after an explicit destroy, defeating the one
  property the store strategy exists for; and `idleTimeoutMs` measured time since the last session
  WRITE rather than the last request, because `seen` advances only in `commit()` and `commit()` is
  skipped for a clean read, so under the DEFAULT `rolling: false` a user requesting every 30 s
  against a 60 s window was signed out after 90 s — actively harmful in its default pairing and
  contradicted by "expire after this much inactivity" in three doc sites. Both are fixed with tests
  that fail without the fix; the idle fix necessarily commits on every request (a `Set-Cookie` per
  response, and a store write on the store strategy), which is documented rather than hidden, and it
  deliberately does NOT extend absolute expiry — a test pins it apart from `rolling`. All 19 changed
  `src` files ≥96% branch/function/line) — complete (PR #105)
- **Milestone 36b** (`packages/starters/*` + `packages/decorator-plugin` + `packages/cli` — starter
  integration: realtime, DI, and NestJS familiarity. Three deliverables, none of which changes any
  default: **(A)** gated `realtime` (three sub-arms: `websocket`/`sse`/`backplane`) and `di` arms on
  `RestStarterOptions`, inherited by the microservice and full-stack tiers through the existing
  `extends` chain with no new gate logic, so the default composition of all three tiers stays
  byte-identical to M36 — M36's rule that nothing unusable is bundled is kept, the arms just make
  previously-impossible compositions expressible without `app.register(...)`. The starter does NO
  validation of the `'messaging'` backplane transport: the backplane's own `register()` already
  throws naming `MessagingPlugin`, and a test pins that the REST tier rejects it while the
  microservice tier boots with it, so the tier distinction is proven rather than asserted. `di` is
  gated because `DecoratorPlugin` branches on `ctx.container` — registering `DiPlugin` changes how
  every decorated service is constructed and the lifecycle it gets. **(B)** parameter-level
  `@Inject`: `Inject` widened to `ClassDecorator & ParameterDecorator`, branching on the argument
  count, with the class-level positional list deprecated (§9.2) not removed. Constructor parameter
  decorators evaluate in **reverse** argument order (re-probed this milestone, not taken on trust),
  so tokens are stored index-keyed and assembled ascending — appending in call order would reverse
  the list and misinject every argument, the exact failure the deliverable removes. `IMetadataStore`
  in `common` declares only three readonly maps, so `mergeCtorParam`/`ctorInject` are concrete-class
  members and there is **no `common` change and no new token**. A token can never be inferred
  (`emitDecoratorMetadata` is absent repo-wide and Deno does not support it), so every ambiguous
  case throws at startup instead of misinjecting: mixing both forms, a hole below the last injected
  index, and `@Inject` on a method parameter. This also fixed a latent defect it made reachable —
  `instantiate()` required service metadata before consulting the container, so a `@Controller`
  (which carries no `@Injectable`) took the registry path even in a DI app where its dependencies
  live in the container, and construction failed outright; the guard contradicted the function's own
  JSDoc. **(C)** `setu new --template nest`, the showcase: REST set + `DiPlugin` + an `@Injectable`
  service + a `@Controller` using the parameter form, wiring INLINE like the other templates (not
  the deferred `--starter` path). That needed a template-contract widening the original plan had
  assumed away — `Wiring` was `{ pkg, symbol }` and the renderer hardcoded `Symbol()`, so neither a
  plugin argument nor an extra source file was expressible; three optional fields (`Wiring.args`,
  `localImports`, `files`) close it with every existing wiring rendering byte-identically. Verified
  by scaffolding the project, repointing its imports at the workspace, `deno check`ing it, and
  RUNNING it — both routes serve 200 with the injected service's output. Docs: the `CLAUDE.md` "Next
  milestone" line had M36b mislabelled as the React Router skeleton, contradicting
  `ROADMAP.md:4601`; ROADMAP had **no M36b section and no `36b` Progress row** at all, both added;
  the ROADMAP NestJS-comparison caveat still claimed sessions did not exist after M48 shipped them;
  and four cross-package starter README links were relative, which returns 400 on jsr.io) — complete
  (PR #107)
- **Milestone 36c** (`packages/cli` + `packages/starters/*` + `packages/config-plugin` +
  `packages/runtime` — React Router app skeleton and config-driven composition. Two deliverables.
  **(A)** `setu new --template full-stack` emits a React Router **8** framework-mode skeleton: the
  `routes → features → services → models` layering, `flatRoutes` `_app`/`_auth` groups each wrapped
  in their own `layout()`, the `~/*` alias, the `.server.ts` convention, one worked feature, and the
  Vite/npm build files. ROADMAP said the app structure was owned by the full-stack STARTER; that is
  impossible and was corrected — a starter is a JSR **library** and cannot write `app/routes.ts`
  into a user's project, so the CLI owns the file layout and the starter owns the plugin composition
  the generated `setu.config.ts` calls. The deliverable that distinguishes this from
  `create-react-router` is the REMOVAL: a conventional RR app's
  `lib/{session,csrf,sse,kv,
  service-logger}.server.ts` and its `config/services.server.ts`
  module-level caches are the session/SSE/secrets/logger capabilities plus the kernel registry, and
  a test pins that none of them is emitted. Session reaches loaders through an **app-declared**
  `RouterContextKey` — `getSession` takes an `IRequestContext` a loader never sees, while
  `populateLoadContext` receives exactly that, so the bridge lives in app code and
  `react-router-plugin` stays ignorant of `session-plugin`. Composing through a starter needed
  `TemplateDefinition.appFactory`, which reverses M36's inline-wiring rule for this ONE template
  with cause (22 wirings is not a file a human wants to open); it took its own type rather than
  reusing `Wiring`, because §3.4's runtime-conditional `assetsDir` cannot be expressed as a fixed
  string. Workers omits `assetsDir` (no `fs` → the asset handler 404s rather than throwing, and
  omitting it registers no route at all). **(B)** config-driven composition:
  `createFullStackAppFromConfig(build, configOptions?)` loads config once, hands the snapshot to the
  resolver, and passes THAT SAME object into the app via a new `ConfigPluginOptions.instance`, so
  the values the composition branched on are the values handlers read. Per-option
  `urlFromConfig`/`secretFromConfig` were **rejected, not implemented** — they need a value at
  plugin-construction time, before `ConfigPlugin` has registered. That needed two extractions, each
  leaving one implementation behind two entry points: `loadConfig` in `config-plugin` and
  `createRuntimeServices` in `runtime` (the barrel exported `detectRuntime` and four per-platform
  factories but nothing for the DETECTED platform — the map was private to
  `RuntimePlugin.register`). A fifth package joined late: no starter had a `session` arm, because
  M48 postdates M36, so `RestStarterOptions.session` was added (gated — the plugin throws without a
  secret). Three defects the drift gate caught that nothing else would: the template pinned React
  Router **7** while the plugin imports `npm:react-router@8`; the Deno `start` task lacked
  `--allow-read`, which SSR needs to import its own server build; and the gate's own
  `useWorkspacePackages` mapped starters to `packages/<name>` (they live under `packages/starters/`)
  and mangled the `~/` alias. Also added a duplicate-path guard, since `findExisting` probes the
  filesystem and cannot see a path planned twice inside one project) — complete (PR #108)
- **Milestone 50** (`packages/service-discovery-plugin` — the capability the framework had none of:
  it can be _found_ by an orchestrator but cannot _find_ anything. The kernel's `ServiceRegistry` is
  an in-process capability registry (same word, unrelated concern), `health-plugin` produces probes
  a discovery system consumes without ever registering anywhere, and `sdk` takes a fixed `baseUrl`.
  Brokered messaging needs no discovery by construction — callers address a topic — so direct
  service-to-service HTTP was the gap. `ServiceDiscoveryPlugin` registers an `IServiceDiscovery`
  under a new `CAPABILITIES.SERVICE_DISCOVERY` token over a pluggable `DiscoveryProvider` port with
  five arms (`'static'`, `'consul'`, `'kubernetes'` EndpointSlices, `'dns'`, `'custom'`); the option
  type is a **union discriminated on `provider`**, so a missing per-arm credential is a compile
  error rather than a startup throw (the M30 `ChannelConfig` precedent). **Zero npm dependencies** —
  §12.2's inject-or-lazy pattern collapses to inject-only because Consul and the Kubernetes API
  server are plain HTTP JSON, so one `IDiscoveryHttp` seam with a buffered `request` AND a streaming
  `stream` (Consul's blocking-query protocol lives entirely in the `X-Consul-Index` **header**; a
  Kubernetes watch is a chunked body `text()` would never resolve) covers both providers. Cache is
  read-through on the **monotonic** clock with per-service in-flight coalescing (the M47
  LaunchDarkly precedent) and stale-on-failure; a watch event invalidates that name immediately, so
  the TTL is a safety net rather than the freshness mechanism. Consul's two documented index hazards
  are handled as requirements, not defensive extras: a **backwards** index after a server restart
  resets to `0` (otherwise the client misses updates for an unbounded time) and an index of `0`
  becomes `1` (it busy-loops older servers — an incident no test would surface). The Kubernetes
  watch is used as a change **SIGNAL**, not a delta log: any `ADDED`/`MODIFIED`/`DELETED` re-LISTs
  and fires the full list, which removes the stateful slice-by-name merge where hand-rolled k8s
  clients most often go wrong, at the cost of one extra LIST per change. `conditions.ready === nil`
  means **ready** (treating `undefined` as not-ready would silently discard every endpoint in a
  slice omitting the field), and Consul's `Service.Address` is an **empty string** for a service
  registered without one, so the `Node.Address` fallback is mandatory — omitting it yields
  `http://:8080`. Outlier ejection is deliberately a **different mechanism** from M27's circuit
  breaker, not a duplicate: `wrap` breaks a CALL SITE (refusing healthy instances because unhealthy
  ones failed), ejection removes a POOL MEMBER while the call site stays open; they compose by
  re-`pick()`ing inside the wrapped call. Envoy's two safeguards are load-bearing —
  `maxEjectionPercent` caps concurrent ejections and an all-ejected pool falls back to the
  unfiltered list, because a correlated failure otherwise converts a partial outage into a total
  one. `pick` filters ejected instances while `resolve` does not, and `resolveUrl` funnels through
  `pick` so both entry points read one configuration. Two flagged widenings outside the package:
  **`IRuntimeServices.dns?: IDnsResolver`** (+ `SrvRecord`) on the M44 `fs?` / M45 `workers?`
  precedent, implemented by Node/Deno/Bun and OMITTED on Workers — DNS-SRV cannot be expressed over
  `fetch` and is how Consul DNS, k8s headless services and ECS Service Connect are actually
  consumed. `SrvRecord.host` is a normalized name **on purpose**: Deno spells it `target`, Node
  spells it `name`, and passing either through would type-check on both runtimes while producing
  `undefined` hostnames on one; `resolveHost` concatenates `A`+`AAAA` and rejects only when BOTH
  fail, since an IPv4-only host has no `AAAA` record at all. And **`ILifecycleApi.onStopping`**, a
  new kernel phase running at the very start of `stop()`, before the app refuses requests —
  deregistering in `onShutdown` (after the drain, after the socket closes) leaves Consul routing at
  a dead port for up to a check interval on every rolling deploy. The plan claimed `stop()` would be
  "byte-for-byte unchanged" with no hooks registered; a pre-existing kernel test **falsified that**
  — `await` on an already-resolved promise still defers `#stopping = true` by a microtask, handing a
  404 to a request that used to get a 503 — so `#doStop()` branches on `hasStopping()` and skips the
  phase entirely, making the compatibility claim literally true. Self-registration runs at
  `onBootstrap`, which is BEFORE `listen()`; that window is harmless only because the mandatory,
  non-disable-able health check keeps Consul reporting the service critical and every read sends
  `passing=true` — so the check is load-bearing, not a convenience default. Doc deliverables C1–C5
  shipped: the ARCHITECTURE package diagram gained this node with the 10-member backlog **named, not
  absorbed**, into M38; README's five mutually inconsistent counts corrected to 43 members / 33
  plugins with the alpha.3 sentence scoped to the release; PUBLIC_API gained a Service Discovery
  section, the `dns` runtime row, and the `onStopping` contract note; M39 gained the scope boundary
  (it owns the platform objects, M50 owns app-side resolution/balancing/watching/ejection). Code
  review then found five defects the green gates had passed, all fixed in the same PR: a rejecting
  `onStopping` hook ABORTED the whole shutdown (the rejection escaped before `#stopping = true`, the
  drain, the socket close and both later hook phases, and `#stopPromise` cached it — so the app kept
  serving and could never be stopped); both watch backoffs accumulated one permanent `abort`
  listener per retry (50 cycles produced 51 added, 0 removed), the class M47 already fixed in
  `resilience-plugin`; `readJsonLines` released its reader lock but never CANCELLED, so every
  Kubernetes resync abandoned a chunked body that is still an open connection; and
  `KubernetesProvider.authHeader` dereferenced `runtime.fs` unguarded, so the EXPORTED class threw a
  bare `TypeError` when constructed outside the factory. The fifth is the instructive one: the
  ejection key separator was an embedded raw NUL BYTE rather than its escape sequence, which made
  `file` report the source as BINARY and `grep -rn` skip it silently — including this file's own
  mandated forbidden-construct audit, whose "empty" result was therefore a FALSE PASS for that file.
  Runtime behaviour was correct and all four gates plus the 90% bar were green, which is exactly why
  it survived; only re-reading the source caught it. One review probe was itself wrong and had to be
  redone: a self-closing fake stream reports zero cancels whether the code is correct or not, so the
  body-leak evidence only became real once the fake stayed open the way a live watch does) —
  complete (PR #109)
- **Milestone 49** (`packages/grpc-plugin` — co-serving the gRPC family (gRPC, Connect, gRPC-Web) on
  the SAME port and fetch handler as ordinary Hono routes, registering an `IGrpcService` under a new
  `CAPABILITIES.GRPC = 'grpc'` token. Runtime is **Connect-ES core** + Protobuf-ES because it is
  fetch-native; `@grpc/grpc-js` was rejected (binds a raw `node:http2` socket — Node-only, needs its
  own port, re-introduces the server model M23 removed) and server-side `grpc-web` was rejected
  (needs an Envoy sidecar, no client-streaming or bidi). A gRPC exchange cannot travel through
  `IRequest`/`IResponse` — no raw streaming body, no trailers — and
  `mapWebRequestToFrameworkRequest` calls `arrayBuffer()` on every request, so interception is one
  new **optional** `IHttpAdapter.setRpcHandler?(handler)` member (the M44 `fs?` / M45 `workers?` /
  M46 `setUpgradeRouter?` precedent), consulted in all four adapters after the WebSocket
  short-circuit and before body mapping; `null` falls through to Hono. Detection is **prefix-only**
  (`basePath`, default `/grpc`) because Connect's real unary content types include
  `application/json`, so sniffing would hijack ordinary routes; the check is segment-aware, so
  `/grpcfoo` is NOT claimed. Connect ships neither reflection nor health, so both are built here
  over **embedded base64 `FileDescriptorSet` constants** revived at runtime — no generated
  TypeScript committed, no proto compiler in the publish path. **Four facts were established by
  probing the real runtime rather than inferred, and each had already produced a defect:**
  Protobuf-ES represents a oneof as `messageResponse: { case, value }`, NOT flat sibling fields —
  the flat form type-checks and serializes to an EMPTY body, which is what made reflection silently
  return nothing; Connect accepts a plain init object, so no `create()` and no Protobuf-ES import is
  needed; `FileRegistry.getFile()` keys on the SUFFIXED path while `DescFile.name` strips `.proto`;
  and `FileRegistry.get()` resolves neither nested types nor methods, so the reflection symbol index
  is walked here and is strictly more complete. The committed `GrpcServiceDefinition` also
  constrained on `methods` (an ARRAY on a real `DescService`, not assignable to
  `Record<string, T>`), forcing every caller into a cast — now `method`, the record form the plan
  specified, pinned by a real-descriptor no-cast test. Health `Check` honors the `service` field
  (`SERVICE_UNKNOWN` for a name not served) and maps `degraded → SERVING`. Three further defects
  were found by writing the tests: a bare `startsWith` prefix check that shadowed prefix-adjacent
  Hono routes; a root `basePath` normalizing to `/` and producing unmatchable `//pkg.Svc/Method`
  keys; and `close()` answering `503` for EVERY path, which would take the whole app down on
  shutdown — it now claims only paths it actually served. Removed a `getFallbackConnectRuntime()`
  no-op that let the plugin register a router silently answering `404` when Connect was absent; a
  missing dependency now throws `GrpcRuntimeLoadError` naming the specifier. All 11 `src` files at
  100% branch/function/line) — complete (PR #110)
- **Milestone 51** (`packages/graphql-plugin` — GraphQL plugin: schema-first and code-first arms,
  GraphQL-over-HTTP transport with media-type negotiation and status-code watershed, bounded
  parse+validate document cache, error masking, depth limiting, introspection switch, GraphiQL page,
  `npm:graphql@^16` inject-or-lazy seam, `graphql` health indicator, `onClose`. Post-implementation
  verification found five defects and four missed deliverables that all four green gates and a 97%
  coverage table had passed, every one of them because a test asserted the defect or asserted
  nothing. **The headline defect made the plugin's core promise non-functional**: the factory
  defaulted `buildContext` to a stub returning `{}`, so the service's `#buildContext !== null`
  branch always won and the documented `DefaultGraphqlContext` was unreachable — through the ONLY
  real entry point, resolvers received an empty object and could reach no capability at all. The
  unit test passed because it constructed `GraphqlService` directly (no `buildContext`), and the
  "integration" test passed because it supplied its own; that file drove a hand-rolled mock plugin
  context and never a kernel app, so it could not have seen it, and the plan-mandated
  both-entry-points-under-a-non-default-config test was never written. It is now a real
  `createApplication` + `inject` suite whose regression case asserts the four context members and
  resolves a live capability. Also fixed: the `405` carried no `Allow: POST`; `data: null` from a
  field error was misclassified as a request error and answered `400` under `graphql-response`
  (`isValidationError = hasErrors && !hasData`) when an executed operation is always `200`; masked
  internal errors were logged NOWHERE, because the sink was read off `IRequestContext`, which has no
  `logger` member, so the cast always yielded `undefined` — the sink now comes from
  `IPluginContext`; and the document cache never saved a parse, because `#checkOperationKind` parsed
  outside it on every request (measured: 5 parses for 5 cached repeats, now 0). The parse →
  operation-guard → validate → execute pipeline moved into the executor behind an
  `ExecutionPhaseOutcome` carrying `status` + `executed`, which is what lets a field error and a
  request error be told apart, and it made the plan's `OPERATION_RESOLUTION_FAILED` row real —
  previously an ambiguous document leaked graphql's own uncoded message. Dead surface removed:
  `execution/operation-check.ts` (49 lines whose only importer was its own test),
  `ExecuteOptions.maxDepth`/`introspection` (never read), `GraphqlExecutionOutcome.streaming` in
  `common` (the plan omitted `extensions` for exactly this reason and then shipped `streaming`), and
  the `isPost` parameter over two byte-identical watershed branches. 15 `expect(true).toBe(true)`
  assertions are gone; six of them sat in `depth-limit.test.ts` feeding the rule
  `{ kind: 'SelectionSet' }` objects while `getDepth` counts the literal `'selectionSet'` **path
  key**, so those fixtures measured depth 0 and the rule could never fire — the tests documented a
  fiction. Missed deliverables shipped: the package was in **neither** release list, so it would
  never have published (`release:verify` says so in as many words); ARCHITECTURE still listed
  GraphQL in the Future subgraph and Future Additions; README still had it under "Not yet built" as
  `🚧 Planned`; and `PUBLIC_API.md` carried the GraphQL section **twice**, the duplicate pair
  disagreeing on the status rules. Two traps this closed that nothing else sees: `index.ts` opened
  its module JSDoc description-first, which on jsr.io **suppresses the README** (`release:verify`
  check 5 caught it), and `inject()` exposes no response headers, so the `Allow` fix had to be
  proven through `app.fetch` — an `inject`-based test would have passed either way) — complete (PR
  #116)
- **Milestone 51b** (`packages/graphql-plugin` + `websocket-plugin` + `common` — GraphQL
  subscriptions over WebSocket and SSE, request batching, Automatic Persisted Queries, custom scalar
  resolvers. Ships the `graphql-transport-ws` state machine over the OPTIONAL
  `CAPABILITIES.WEBSOCKET`, GraphQL-over-SSE in distinct-connections mode over M42's
  `IResponse.stream()`, and a starter arm. **Every new behaviour is opt-in** — `subscriptions`,
  `apq`, and `maxBatchSize` all default off, so an upgrade with no config change is byte-identical,
  and `POST/GET /graphql` still answers the tested `400 SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`.
  Three flagged `common` widenings: `GraphqlRequestParams.extensions`, `IGraphqlService.subscribe`
  (+ `GraphqlSubscriptionOutcome` / `GraphqlOperationContext` / `GraphqlConnectionInfo`) — a
  REQUIRED member, so **breaking for implementors** though the framework's own service is the only
  one in-repo — and `WebSocketRouteOptions.heartbeat`. That last one exists because
  `HeartbeatSweeper` walks every connection on every route sending a RAW TEXT payload, which a
  conformant `graphql-transport-ws` client must answer by closing `4400`:
  `WebSocketPlugin({ heartbeatMs })` would have broken every subscription in the application, and
  neither package could detect it. The GraphQL route claims the opt-out and runs the protocol's own
  `ping`/`pong`.

  **Verification found the headline deliverable non-functional, at 92–100% coverage with all six
  gates green.** `attachResolvers` assigned the whole `{ subscribe, resolve }` entry to the field's
  `resolve`, so `subscribe` was never set and graphql threw "Subscription field must return Async
  Iterable. Received: undefined." — which escaped as a rejection and surfaced as the kernel's 500.
  Schema-first subscriptions could not work at all. `ResolverMap` could not even express one (an
  entry had to be a function), which is why the shipped integration test carried
  `resolvers as never`. And **no test anywhere drove a real subscription**: both transport e2e files
  declared a Query-only schema, so the test named "client complete tears down the subscription" ran
  a QUERY, and every `subscription { … }` string in the suite hit either the HTTP-refusal test, a
  fake runtime, or a fake service. That is why the rest shipped green. Separately, resolver errors
  inside a LIVE subscription reached clients **verbatim** while the HTTP path masked the identical
  error — the service's own comment claimed the transports masked; `grep` over `src/transports/`
  found no masking at all. Masking now happens once, in the service. The plan's shared
  `prepareDocument` prologue was never written either, so `subscribe.ts` duplicated
  parse/guard/validate/cache and `checkOperation`'s `transport: 'stream'` arm had no src caller;
  both pipelines now share one prologue and the guard returns the resolved operation kind so
  dispatch costs no second AST walk. Also fixed: an unknown WS message type was ignored with a
  comment claiming "protocol requires" when PROTOCOL.md requires closing `4400` (the ignore rule is
  for unknown IDs); a client `complete` could not suppress an unresolved single-result operation;
  the transports used global timers rather than `IRuntimeServices`; the SSE controller had no
  `cancel` hook, so a departing consumer left the pump enqueueing into a dead controller. Code
  review then caught two defects in those repairs — the guarded release of the source iterator could
  raise an unhandled rejection out of a fire-and-forget pump, and an SSE persisted-query miss
  answered a buffered `400`, reintroducing the exact `EventSource` failure in-stream errors exist to
  avoid. Doc deliverables the milestone had skipped entirely shipped here: `PUBLIC_API.md`,
  `ARCHITECTURE.md`, both package READMEs, and a CHANGELOG entry that had claimed subscriptions over
  HTTP now answer `200` with a stream — the opposite of what ships. All 24 `src` files at ≥90%
  branch/function/line.

  **Interop is proven against the authorities, not against our own fakes** (`apps/graphql-demo`,
  outside the workspace so its npm client deps never reach a published dependency graph):
  `npm:graphql-ws`, the reference implementation of the protocol this hand-writes, and
  `@apollo/client`'s persisted-query link. 15 checks. The suite is built around a false pass that
  actually happened — an early run swept clean while both Apollo requests went out hash-only,
  because the APQ cache was warm and the miss→retry handshake never executed. Each run now boots its
  own app on an ephemeral port and asserts the WIRE SEQUENCE, and both shapes were produced and
  observed (`["hash-only","document","hash-only"]` cold, `["hash-only","hash-only"]` warm), so the
  guard is known to discriminate. The app's basic type-check and GraphQL smoke check are run by
  `deno task check:apps`; the npm-client interop suite remains manual because CI does not install
  its extra clients) — complete (PR #117)
- **Milestone 52** (`packages/cloudflare-plugin` — the platform the framework could _serve_ on but
  not _reach_:
  `grep -rn "waitUntil\|KVNamespace\|D1Database\|R2Bucket\|DurableObject\|
  cloudflare:workers" packages/*/src`
  returned NOTHING, and `cf-runtime.ts` defaulted its env source to `{}` while
  `createRuntimeServices` called the platform factory with no arguments — so `runtime.env` was
  **empty** on Workers and `ConfigPlugin` plus the secrets `EnvProvider` read nothing there.
  `CloudflarePlugin` registers `ICloudflareBindings` under a new `CAPABILITIES.CLOUDFLARE` token
  with typed accessors (`kv`/`r2`/`d1`/`queue`/`service`/
  `durableObject`/`get<T>`/`vars`/`waitUntil`), each throwing `CloudflareBindingMissingError` naming
  the binding AND the ones that are present rather than returning `undefined`. **Zero npm
  dependencies and nothing under `packages/` imports `cloudflare:workers`** — the application passes
  `env` (and `waitUntil`) in. That is not a style choice: the specifier is unresolvable by Deno, so
  a static import breaks `deno check` on every other runtime and a non-literal dynamic import is the
  fake-lazy-import smell CLAUDE.md bans; injection is also what the platform docs recommend. Four
  platform facts were verified against current docs and each one shaped the design: `env` is
  importable at module scope but binding **methods** may not run there (so `register()` captures and
  shape-checks bindings and never reads through one — a probe read would throw on a real deployment
  while passing against every fake, and the health indicator performs no binding I/O either, since a
  KV read per probe interval bills); `waitUntil` became importable only on **2025-08-08**, which
  postdated the CLI's scaffolded `compatibility_date = "2024-09-23"` (conflict C3, bumped); **KV
  rejects an `expirationTtl` below 60 seconds** while `ICacheStore.set` accepts anything, so values
  carry a `{ v, e }` envelope whose logical deadline is checked on every read against
  `runtime.now()` while the physical TTL is floored at 60 — a 5-second entry expires in 5 seconds
  instead of surviving a minute, and disabling that one check fails **9** tests including the
  real-`SessionPlugin` one; and **R2 bindings cannot presign at all**, so `getSignedUrl` throws (the
  M28 `LocalStorageProvider` precedent) while `getStream` gives the zero-copy alternative.
  `R2Storage.delete` heads first because R2's `delete` returns void and reports nothing, so the
  committed `Promise<boolean>` costs a round trip rather than a constant `true`.
  `KvCacheStore.clear()` **requires** a prefix — the binding has no bulk delete, so the sweep pages
  `list` and deletes each key, and unprefixed it would delete keys the store does not own.
  `KvSessionStore` is app-constructed and handed to `SessionPlugin({ store })`, because that option
  is read at plugin construction before any application exists. Cache and storage registration are
  opt-in and instance-named (`cache.<name>`, the `cache-plugin.ts:67` precedent), since the kernel
  rejects two providers of one token. Two deviations from the committed plan, both recorded in it:
  `splitWorkerEnv` lives in **`common`**, not `runtime`, because `cloudflare-plugin` needs the
  identical partition and no plugin may import another (the M47 frame-codec precedent) — keeping it
  in `runtime` would have forced the duplicated copy §11.1 forbids; and the CLI threads the
  platform's own `fetch(request, env)` argument through a new `Wiring.workersArgs` field instead of
  emitting `import { env } from 'cloudflare:workers'` into `setu.config.ts`, because `setu` itself
  imports that module to discover plugin commands and the specifier is unresolvable off a Worker
  toolchain. Verified beyond the gates by scaffolding a real Workers project, repointing it at this
  workspace, `deno check`ing it, and driving its own `fetch(request, env)` export with a KV-shaped
  binding: 200, value read back, envelope visible in the store. All 11 `src` files at 100%
  branch/function/line. **Not verified against a live Worker** — CI holds no Cloudflare account) —
  complete (PR #111)
- **Milestone 52b** (`packages/cloudflare-plugin` — Cloudflare Queues, Cron Triggers, and the Cache
  API: the three platform features that need a **module-level handler export** from the
  application's Worker rather than anything reachable through `fetch`. The original M52b scope also
  carried D1 and Durable Objects; it was **split at the maintainer's direction** into M52b / M52c /
  M52d, because D1 alone is a `common` contract promotion spanning three packages and a DO backplane
  is its own design. No `common` change and no new capability token. **Queues:** `WorkersQueue`
  satisfies the committed `IQueue` over a producer binding, opt-in through a `queue` arm and
  registered under `CAPABILITIES.QUEUE` (or `queue.<name>`, the `cache.<name>` precedent). A
  Cloudflare message body is arbitrary JSON carrying neither a job name nor an id, and
  `producer.send()` resolves to `void`, so a `{ v, name, id, data, maxAttempts? }` envelope carries
  both and the id `add` returns IS the id the processor sees as `job.id` — using `Message.id`
  instead would have made them two different values. An unroutable message (unreadable envelope, or
  a name with no processor) is **retried, never acked**, because acking discards it permanently and
  silently; `maxAttempts` is enforced at dispatch since Cloudflare's `max_retries` is queue-wide
  config; `delayMs` converts to whole `delaySeconds` **rounded up** so a job is never early; and
  `ProcessOptions.concurrency` bounds one name's messages without throttling another's.
  `addRecurring` throws, naming Cron Triggers. **Cron:** `WorkersCron` + `createScheduledHandler`,
  and the decision the ROADMAP asked for — a Workers `IScheduler` **cannot** honour runtime
  `schedule()` calls, so `CAPABILITIES.SCHEDULER` is deliberately NOT registered: `every`/`delay`
  arm timers across an isolate eviction (which is also the real reason `scheduler-plugin` cannot run
  on Workers), `pause`/`resume`/`remove` need state that does not survive an invocation, and
  `getNextRun` is owned by `wrangler.toml`; six of eight methods throwing violates Liskov. That
  decision is also why `createScheduledHandler` takes the `WorkersCron` while `createQueueHandler`
  takes the app — the cron registry is not in the service registry to resolve. **Cache API:**
  `cacheApiMiddleware` over `caches.default`, reporting under `X-Cache-Api` so it composes with
  `cache-plugin`'s `X-Cache` store-backed middleware rather than colliding; the platform's refusals
  (non-GET, 206, `Vary: *`, uncleared `Set-Cookie`) are checked first via the pure exported
  `assessCacheability` rather than discovered from a thrown `put`, and the 206 rule is
  **unconditional** because `cacheableStatuses: [200, 206]` is a legal configuration that would
  otherwise let the platform throw. A HIT replays through `IResponse.stream`, which is what made
  `app.inject()` unusable for cached routes and moved the tests to `app.fetch` — more faithful,
  since that is the entry point a Worker invokes. One defect found by chasing a coverage gap rather
  than by a failing test: `WorkersQueueOptions.logger` captured `ctx.logger` at `register()`, the
  exact mistake M52 documented and fixed on the `waitUntil` seam — a logger registered imperatively
  afterwards would have silenced every dispatch report — so it is now a thunk, with a test that
  fails without the fix. All 20 `src` files at **100%** branch/function/line. **Not verified against
  a live Worker** — CI holds no Cloudflare account, though the whole surface WAS driven against real
  **workerd** via `wrangler dev`: queues (producer + a real `MessageBatch`, with an unroutable
  message observed being redelivered exactly `max_retries` times), a real `ScheduledController`,
  `caches.default`, KV and R2. That harness is what caught the kernel's module-scope
  `AbortController` (fix/PR #112) — every application failed to boot on Workers and no gate could
  see it, because the suite runs on Deno where a module-scope controller is legal.
  Post-implementation code review then found five more defects the green gates had passed, all fixed
  on this branch with tests that fail without the fix. The important one: `cacheApiMiddleware`
  consulted the cache on **every method**, and since the key is a URL string — which the Cache API
  resolves as a GET request — a `POST` to a path with a cached GET response was served that response
  and its handler never ran, a mutation silently discarded behind a 200. Reachable on the documented
  global-pipeline usage; the method is now checked before the read, verified on workerd. Also: an
  inline cache write that rejected propagated out of the middleware and turned a good 200 into the
  kernel's 500 (`Cache.put` rejects for an oversized body or a quota error, and the response already
  exists by then, so both write paths now report and continue); `createQueueHandler` returned a
  function that threw **synchronously** despite being typed `=> Promise<void>` and assigned straight
  to the Worker's `queue` export; `message.ack()` sat inside the processor's `try`, so a throwing
  ack was reported as a processor failure AND retried, giving one message two dispositions; and
  `WorkersQueueArm` was exported without a PUBLIC_API entry) — complete (PR #113)
- **Milestone 52c** (`packages/common` + `packages/database-plugin` + `packages/cloudflare-plugin` —
  D1 as a first-class backend, gated on promoting the data-access port. The seam a backend
  implements was `IDatabaseAdapter`, declared **inside** `database-plugin` and never exported, while
  `common` shipped only the lifecycle-shaped `IOrmAdapter` — so a backend in another package was
  literally inexpressible (§2.2 forbids a plugin importing a plugin). Promoted `IDatabaseAdapter`,
  `IAdapterTransaction`, `IDataSource`, `NormalizedQuery` and `OrderDirection` into `common`, and
  **deleted** `database-plugin/src/adapters/adapter.ts` so exactly one definition exists. The
  promotion adds ONE member — a non-transactional `createDataSource(entity)` — and that addition is
  the whole point: `createDataSourceFactory` was a second closed switch that **cast the adapter to
  each concrete class** (`adapter as PrismaAdapter`) to reach `createDataSourceForEntity`, which is
  the real reason the seam was closed, not the arm list. It is now deleted, all three built-in
  adapters carry `createDataSource`, and `createDataSourceForEntity` is deprecated-not-removed
  (§9.2). `DatabasePluginOptions` became a union discriminated on `type` with a `'custom'` arm
  requiring `adapter`, so a missing backend is a **compile** error (the M30 `ChannelConfig` / M50
  precedent); named `'custom'` rather than `'external'` to match M31/M50. `DataSource` survives as a
  deprecated alias of `IDataSource`. The promotion also fixes a latent public-API defect: the barrel
  exported `DataSource` whose `findAll` parameter is `NormalizedQuery`, which the barrel did **not**
  export — the type was unnameable by any consumer. **D1's transaction reconciliation is deferred
  batch.** D1 rejects `BEGIN TRANSACTION` outright (the platform error names
  `state.storage.transaction()` as the alternative) and `batch()` is its only unit of atomicity, so
  `beginTransaction()` buffers every write and flushes the whole buffer as ONE `batch()` at commit;
  `rollback()` discards and sends nothing. Refusing with a throw was rejected — the platform does
  offer atomicity, so refusing would strand the committed `IDatabaseService.transaction()`. The two
  costs are documented, tested, and in PUBLIC_API rather than left to discovery: **no
  read-your-own-writes** inside a transaction (reads hit committed state), and an in-transaction
  `create()` **requires an explicit primary key** (a deferred INSERT cannot report a generated key
  to a caller awaiting `create()` before the flush; outside a transaction `RETURNING *` supplies the
  real row). `update`/`delete` read first so both honor their committed return contracts. Values are
  always bound (`?N`); identifiers cannot be, so table/column names are validated against
  `[A-Za-z_][A-Za-z0-9_]*` and double-quoted, and every builder refuses a statement exceeding D1's
  **100-bound-parameter** limit rather than letting D1 fail with a message pointing at the SQL.
  `D1Result` was deliberately NOT widened with `meta`: `delete` uses `DELETE … RETURNING <pk>` and
  `update` uses `UPDATE … RETURNING *`, so row counts come from `results.length` and the M52 facade
  is untouched. `D1Adapter` is app-constructed and handed to `DatabasePlugin({ type: 'custom' })` —
  the `KvSessionStore` precedent, because those options are read before any application exists.
  **The test double is a real SQLite engine** (`node:sqlite`, the engine D1 runs) rather than a
  scripted fake, so the generated SQL is genuinely parsed and executed and batch rollback is real; a
  scripted fake can only prove which calls were made. Writing the tests caught a defect in the new
  code — several methods typed `Promise<T>` threw **synchronously**, bypassing any caller using
  `.catch()` (the M52b `createQueueHandler` defect class) — and one already merged on `main`:
  `resolveLogger` extracted `logger.debug` into a local and invoked it **detached**, and both
  loggers `logger-plugin` ships implement `debug` via a private `#` field, so `logQueries: true`
  threw `TypeError` on **every** repository call whenever a real logger was registered. Every
  existing test injected a plain-object logger, where a detached method works fine. `cache-plugin`
  carries a regression test for the identical bug; `database-plugin` never got one, and now has it,
  driving the REAL `ConsoleLogger` — verified to fail without the fix. Deliberately NOT fixed:
  `DatabaseService.query()` throws synchronously for the memory adapter despite returning a promise
  (`migrate()` beside it rejects). Two committed tests pin that behavior and correcting it is a
  behavior change outside this milestone's scope — flagged in a JSDoc note instead. **Not verified
  against live D1** — CI holds no Cloudflare account. Code review then found the defect no gate
  could see: `D1Adapter` stored its binding **unvalidated**, so an absent binding (a name typo, a
  missing `d1_databases` stanza) let the app boot clean, report `up` from the `database` health
  indicator, and fail every query with a bare `TypeError` — the M50 `KubernetesProvider.authHeader`
  class, and a contradiction of this package's own principle, since `facades.ts:402` states the
  guard family exists "to fail at `register()` with a name rather than at the first request with a
  bare `TypeError`" while `isKvNamespace`/`isR2Bucket` had no D1 member. Coverage could not have
  caught it — there was no branch to cover, and all three new files were already at 100%. Added
  `isD1Database` plus constructor validation throwing `CloudflareBindingMissingError`; five tests,
  all five verified to fail without the guard. Review also closed a test gap where
  `LIMIT -1 OFFSET ?N` and the `IS NULL` filter were asserted only as SQL **strings** and never
  executed (both were correct), and corrected three doc claims — a barrel test claiming "exactly the
  documented public surface" while omitting `D1Adapter`, `IDataSource.create`/`delete` promising
  persistence with no caveat for the deferred-write path, and a PUBLIC_API "every builder refuses"
  that overstated the parameter-cap check. All `src` files touched are at 100% branch/function/line)
  — complete (PR #114)
- **Milestone 52d** (`packages/cloudflare-plugin` — Durable Objects: a DO-backed
  `IRealtimeBackplane` registered under the committed `CAPABILITIES.REALTIME_BACKPLANE` and a
  DO-backed distributed lock handed to `SchedulerPlugin({ distributedLock: { lock } })`
  structurally. **No `common` change and no new token** — M47 and M18 committed both contracts. The
  ROADMAP's `SchedulerPlugin({ lock })` was one level too shallow, and `enabled: true` turns out
  **not** to be required: `resolveLock` consults `lock` before `enabled`, verified from source
  rather than assumed. Because `cloudflare:workers` is unresolvable off a Worker toolchain, the
  package ships two plain cores (`RealtimeBackplaneObjectCore`, `DistributedLockObjectCore`) that
  the application's exported DO class delegates to; a mixin reads better but **cannot be typed
  without `any`** — the TS mixin constructor constraint requires it and the `unknown[]` form rejects
  a `(ctx, env)` constructor — so delegation is the design, and it also lets the app's class extend
  the real base class. **Six platform facts were verified against current Cloudflare docs, and two
  changed the design.** `ctx.acceptWebSocket` is the **hibernation** API: the runtime may evict the
  object and **re-run its constructor** while sockets stay open, so the fan-out core holds **zero**
  in-memory state and reads `getWebSockets()` as the only membership — a `Set` in a field would
  empty itself on the first hibernation while every non-hibernating test passed, which is the single
  most likely way this milestone could have shipped green and broken; the test therefore builds a
  FRESH core over the same state. And **a Worker isolate cannot be relied on to hold a long-lived
  outbound WebSocket**, which the ROADMAP's "each replica holds a WebSocket to the DO" did not say —
  so the socket opens lazily and reopens on failure, and the real guarantee is documented in four
  places rather than implied: a subscription lives exactly as long as the isolate holding the
  members it serves, and since those members are client sockets in the SAME isolate (an
  HTTP-triggered Worker has no duration limit while its clients stay connected), losing one loses
  both **together**. Also checked and recorded so a reviewer does not re-raise them: the
  6-connection limit counts only connections **awaiting response headers**, so an established socket
  costs no slot; and DO eviction is ~10 s to hibernation, else 70–140 s. That last one is why the
  lock persists its holder in `ctx.storage` and never a field — a TTL routinely outlives eviction,
  and an in-memory deadline would hand the same lock to a second holder. Lock correctness comes from
  the platform's **input gate** ("while a storage operation is executing, no events shall be
  delivered to the object"), making the read-compare-write atomic with no transaction; **the test
  fake had to reproduce that gate** — without it the fake reported five simultaneous winners for one
  lock, which was a defect in the double, not the code. A non-2xx from the lock object **throws**
  rather than reporting "not acquired", since a 404 means the binding names the wrong class and
  folding that into contention would silently disable every scheduled job. Payloads are re-broadcast
  **verbatim** and never parsed, so the object stays schema-ignorant and a future `RealtimeFrame`
  widening needs no redeploy of the application's class. `isRealtimeFrame`/`dispatchFrame` are a
  deliberate local copy of `realtime-backplane-plugin`'s (the M30b `pemToDer` precedent — §2.2
  forbids the import). Closed the last hole in the binding-guard family:
  `BindingRegistry.durableObject` cast **unvalidated**, so a missing stanza or mistyped `class_name`
  let an app boot clean and fail on the first `idFromName` with a bare `TypeError` — exactly what
  M52c's review found on D1 — now `isDurableObjectNamespace` plus constructor validation. Doc
  deliverables C1–C5 shipped, including the ARCHITECTURE note that `cloudflare-plugin` is now a
  **second provider** of `REALTIME_BACKPLANE` and an application must register exactly one. All 28
  `src` files at **100%** branch/function/line. **Verified against real workerd** via `wrangler dev`
  (12/12 checks): the whole surface was driven through a bundled Worker exporting both DO classes
  under the documented wrangler stanza. That harness settled the milestone's last open design
  question empirically — **a plain DO class WITHOUT `extends DurableObject` is accepted by
  workerd**, which is what makes the delegation design (forced by §5.2, since a mixin cannot be
  typed without `any`) correct rather than merely convenient. It also proved the three things no
  fake could: a real `stub.fetch` WebSocket upgrade answering a 101 that carries a `webSocket`, a
  real `WebSocketPair` + `state.acceptWebSocket` inside the object, and the real **input gate** — 8
  concurrent contenders on one lock object yielded exactly 1 winner, the property the Deno fake had
  to hand-simulate. The code-review fix was verified there too, with a negative control: with the
  `onMemberJoined` hook removed the listen-only replica received `[]` on workerd, and with it
  restored it received the broadcast. **Still not verified against a deployed Worker** — CI holds no
  Cloudflare account) — complete (PR #115)
- **Milestone 50b** (`packages/cli` — wiring service discovery into the microservice template. M50
  shipped the plugin and nothing consumed it: a project scaffolded with
  `setu new --template microservice` got messaging, queues, resilience and telemetry — the four
  plugins a service needs to talk to others — and then hard-coded the URLs of the services it
  called. Adds one `Wiring` to `MICROSERVICE_TEMPLATE`. The CLI emits inline wiring and never
  imports a starter (M36b's rule), so only newly scaffolded projects change and no published
  library's default moves; a `serviceDiscovery` arm on `MicroserviceStarterOptions` stays available
  as a non-breaking addition and was deliberately NOT folded in. REST does not get it — the tier
  boundary the repo already draws puts ingress on REST and egress on microservice. **This is the
  only template wiring whose `args` is an option object checked against a discriminated union**:
  `ServiceDiscoveryPluginOptions` has no default arm, so a bare call does not type-check and
  something must be emitted, and `'static'` is the only arm needing no backend or credential. The
  service map is left EMPTY rather than carrying a sample, because a sample fabricates a dependency
  that resolves to a dead port, while an unknown name resolves to `[]`. The trap: `args` is a
  rendered string, so a wrong discriminant or a misspelled field is invisible to the CLI's own
  `deno check` and is a compile error only in the GENERATED project — and the microservice template
  had **no e2e coverage whatsoever** before this, so nothing type-checked a scaffolded microservice
  at all. It does now, and the gate was proven to discriminate by breaking the string (`servicez`)
  and watching it fail, then restoring it. Also corrected the e2e comment claiming `nest` was "the
  only" template carrying an `args` string, and a stale ROADMAP line recording the alpha.4
  `release:create-packages`/`release:link-repos` step as still pending) — complete (PR pending)
- **Milestone 37** (`apps/*` — runnable example applications and the `check:apps` gate that keeps
  them working. Every capability the framework ships was proven by tests inside `packages/` and by
  nothing a reader could run; the ROADMAP's example list predated 22 milestones and named no
  capability added after M34, so it was corrected rather than implemented as written. Ten examples
  are new and `apps/graphql-demo` (M51b) is **adopted** rather than rebuilt. Examples stay OUT of
  the Deno workspace and each carries its own `deno.json` mapping `@setu-ts/*` at
  `../../packages/<name>/src/index.ts` — load-bearing, not stylistic, because an example pulling
  `npm:@connectrpc/connect` into the workspace would put it in a published package's resolution
  graph; pointing at `src/` rather than JSR is also the correct target for a gate, since drift means
  disagreement with HEAD (the M34b drift-gate reasoning). `fmt` and `lint` already covered `apps/`
  with no config change — only `check` and `test` were scoped — so `scripts/check-apps.ts` closes
  the whole remaining gap by type-checking each app's entry points and running its mandatory `smoke`
  task, with exit code **77** reserved for a reported skip so an unavailable prerequisite can never
  read as a pass. Examples are deliberately NOT coverage-measured: the 90% bar is a library standard
  and applying it to demo code produces tests written to satisfy a number. **The bar for an example
  is that it runs and proves something**, so each `smoke` asserts one behaviour — a written row read
  back through the same REST API, a command mutation observed through a separate query bus, tenant
  A's write invisible to tenant B, a `deno compile` binary serving `/health`, a descriptor-backed
  Connect RPC and an ordinary Hono route answering on one port. Two are real external harnesses
  rather than fakes: `apps/cloudflare` bundles and drives `wrangler dev` against workerd (KV
  read/write plus a `__scheduled` trigger), which commits the throwaway harness that caught the
  kernel's module-scope `AbortController` (PR #112), and `apps/realtime` runs two replicas over a
  `'redis'` backplane. **The realtime check shipped non-discriminating and was fixed in
  verification**: both replicas were created in ONE process, so the backplane's process-local
  `'memory'` transport carried the message and the smoke stayed green with zero cross-replica
  delivery — the precise failure §3.7 of the plan existed to prevent, and the one M47 capability no
  in-package test can reach. The replicas are now separate `Deno.Command` processes, proven to
  discriminate by swapping the transport to `'memory'` and watching it exit 1. Every smoke check was
  verified against a real backend where one exists: Redis 7 in Docker for realtime, real workerd for
  Cloudflare (whose scheduled path also discriminates — changing the cron pattern exits 1), and a
  broken tenant repository for multi-tenancy. Doc deliverables C1–C4 shipped: `examples/.gitkeep`
  deleted so one concept has one directory, the M0 directory list and the M37 example list
  rewritten, `graphql-demo` indexed in `apps/README.md`, and the M51b entry's "Not run by CI"
  sentence amended to say which part is now gated. Verification also found three holes in the gate
  itself, all closed in M37b on this same branch rather than deferred: the example's own test was
  run by nothing, `test/apps-gate.test.ts` never ran in CI, and `check:apps` left an untracked
  `apps/cloudflare/.wrangler/` that made a following `publish:check` abort) — complete (PR pending)
- **Milestone 37b** (`apps/*` — DI/decorators and memory-database examples, plus a microservices
  correction). `apps/di-decorators` proves a decorated controller's parameter-level `@Inject` and
  makes manual `container.createScope()` explicit: singleton instances span scopes while scoped
  instances do not; the framework creates no request scope automatically. `apps/database` writes,
  reads, updates, and rolls back through the memory adapter's public repository surface. The
  microservices Redis smoke now registers its `respond` handler on service B and issues the
  `request` from service A, so it proves actual cross-service brokered request/reply rather than a
  self-reply. Fixed the ioredis eager-connect defect in cache, queue, and messaging: each lazy
  loader constructs with `{ lazyConnect: true }`, then preserves its existing explicit `connect()`
  startup path. Redis-backed instances previously failed at `app.start()` because ioredis had
  already connected — so `CachePlugin({ store: 'redis' })`, `QueuePlugin({ adapter: 'redis' })` and
  `MessagingPlugin({ broker: 'redis-streams' })` could never start on the documented lazy path, and
  no gate could see it because every test injects a fake client whose `connect()` is a harmless
  no-op. That is the same contract-violating-double root cause the pre-M18 review campaign found;
  the defect was discovered by building the example, which is the argument for the example. The fix
  is verified through `app.start()` against a real Redis 7 for all three, plus a cache round trip,
  because the seam test alone cannot prove it. Also closed the three M37 gate holes: `check:apps`
  now runs an app's `test` task when one is declared (proven by breaking `apps/plugin-development`'s
  test and watching the gate exit 1), CI gained a `deno task test` step so `test/apps-gate.test.ts`
  runs there (that step was later removed — `test:coverage` now covers the root `test` directory
  itself, so the file still runs on a runner without the suite executing twice), and
  `apps/cloudflare/.wrangler/` is gitignored so `check:apps` no longer dirties the tree ahead of
  `publish:check`. `apps/compiled-binary` moved off its hardcoded port 4317 to `unusedPort()`) —
  complete (PR pending)
- **Milestone 53** (`.github/workflows/ci.yml` + `scripts/check-apps.ts` + guarded Redis tests —
  real-backend CI: making the proofs that matter actually run on every pull request. `apps/realtime`
  and `apps/microservices` both exited **77** unless `REDIS_URL` was set and no CI job set it, so
  the two examples whose whole purpose is cross-replica / cross-service behaviour against a live
  broker were skipped. Adds a `redis:7` service container, job-level `REDIS_URL`, an `ALLOW_SKIP`
  allowlist that turns a skip CI could have covered into a **failure**, malformed-app-directory
  reporting by name instead of an unhandled `NotFound`, and three deepened guarded real-import tests
  that construct a client over the real `loadIoredis` path and drive one command round trip. **The
  milestone found three defects no gate could see, which is the entire argument for it.** (1)
  `RedisQueue.reserve()` sent `ZRANGEBYSCORE` with a positional offset/count and **no `LIMIT`
  keyword**, so every reserve against a real server answered `ERR syntax error` —
  `QueuePlugin({ adapter: 'redis' })` could not dispatch a job at all. It survived because the test
  fake is `zrangebyscore: () => []`, a zero-arity stub that accepts any arguments: the same
  contract-violating-double root cause as the M37b ioredis defect. `IRedisQueueClient.zrangebyscore`
  is widened to a limit-clause union so the broken positional form is now a **compile** error. (2)
  `RedisStreamsBroker` stored poll-interval handles as `number` via `Number(intervalId)`, but
  `TimerHandle` is `unknown` in `common` — deliberately opaque — so an object-shaped handle coerced
  to `NaN` and `clearInterval` became a silent no-op, leaking a poll loop that kept issuing commands
  after `unsubscribe()`/`disconnect()`. The bundled runtimes were saved only by coincidence
  (`globalThis.setInterval` returns a Timeout that coerces to its id); any custom `IRuntimeServices`
  leaked outright. The fixture that exposed it is CORRECT precisely because it exercises that
  opacity. `queue-plugin`'s `as unknown as number` casts were the same class but not defects — a
  cast preserves the value — so they are retyped with no test, because a test cannot fail for a bug
  that was not there. (3) Two existing tests passed **only** because Redis was unreachable
  (`rejects.toThrow()` against `localhost:6379`); providing a live one flipped them red. Both now
  target an address the net grant deliberately does not cover. **Three wiring facts were established
  by measurement, each having first produced a wrong answer:** a `services:` label is NOT a
  resolvable hostname for a job running directly on the runner, so `REDIS_URL` must use a mapped
  `localhost` port — and getting it wrong does not skip, it makes the smokes throw; `check:apps`
  needs `--allow-env=ALLOW_SKIP` or the gate throws `NotCapable` on its first run; and a CLI
  `--allow-net=<list>` **replaces** a package's `test.permissions` block rather than unioning with
  it, so scoping at the root narrowed the nine packages already declaring `net: true` and broke 21
  GraphQL/SSE/WebSocket e2e tests — the grant therefore lives in each Redis package's own manifest,
  endpoint-scoped. A loopback-wide grant was also rejected with cause: it lets the tests see a real
  `ECONNREFUSED`, but ioredis retries forever and the runner hung until killed at 110 s. Code review
  then caught the milestone's own thesis applied incompletely — the three deepened tests guard on
  `REDIS_URL` and skip silently, and **nothing asserted they had run**, so dropping the variable
  from the workflow would skip all three while the job stayed green; `test/apps-gate.test.ts` now
  pins the service, the port mapping, the variable, and the scoped grant, with both assertions
  verified to fail when the wiring is broken. Suite green under BOTH conditions (Redis live and
  Redis stopped), which is the real bar — 1058 passed each way) — complete (PR #123)
- **Milestone 37c** (`apps/full-stack` — the runnable React Router example the framework's largest
  capability had none of. `react-router-plugin` (M44), `full-stack-starter` (M36/M36c) and
  `setu new --template full-stack` (M36c) all shipped with nothing a reader could run: 13 apps, none
  referencing React Router. **The toolchain question the milestone was opened on was answered by
  measurement, and the answer was neither of the two options the ROADMAP framed.** Both assumed the
  real Vite build needs a Node toolchain — so the choice was "commit a `ServerBuild` fixture" or
  "add Node/npm to CI". Deno's own npm support runs the identical build:
  `deno install
  --allow-scripts` took **4 s** and the build **0.6 s** against a project scaffolded
  by the CLI and repointed at the workspace, after which the app served SSR HTML and completed a
  CSRF-protected login. So the smoke performs the **real** build, CI gains no `setup-node` step, no
  fixture is committed, and `full-stack` is deliberately **not** in `ALLOW_SKIP` — with
  `test/apps-gate.test.ts` asserting it never becomes so, because the exemption would be a one-word
  edit that leaves CI green. AI_GUIDELINES §12.2 is untouched: "npm toolchain" describes the package
  ecosystem, not a required Node binary. **What CI does NOT prove is a browser** — hydration,
  static-asset delivery and client-side navigation were verified manually against Chrome via
  Playwright (11/11, shown to discriminate by aborting the client entry bundle: the hydration and
  client-side-transition checks flip to failing while SSR content still renders, which also
  demonstrates the login form degrading to a real POST without JavaScript). That suite is
  deliberately NOT committed, because it needs a browser CI does not install — the M51b
  `apps/graphql-demo` interop precedent. It found one real wart, now fixed: the example shipped no
  favicon, so every browser load logged a 404 from the SSR catch-all, and `root.tsx` now carries an
  inline `data:` icon. **Code review then found the milestone's own worst assumption.** It had
  claimed the `.tsx` modules were type-checked by `vite build`; they were not, and neither was
  `app/features/products/products.server.ts` — rolldown strips types without checking them, so a
  pure type error builds green, and `deno info --json smoke.ts` shows the gate's fixed entry points
  reach only six app modules. **Eleven app files were under no type-checker at all**, and the
  negative control that "proved" otherwise was mis-designed: it renamed an import to a MISSING
  EXPORT, which is module resolution and any bundler catches it. The example now carries a
  `check:app` task (`deno check app/**/*.ts app/**/*.tsx`, `jsx: 'react-jsx'`) run from `test`, so
  `check:apps` executes it — a glob, not a file list, because `app/routes.ts` resolves routes
  through `flatRoutes()` at build time and statically imports none of them. Review also closed two
  holes in the removal test itself: it matched only a bare `const …`, so
  `export const clientCache = new Map()` passed unnoticed, and it proved a context key was
  _mentioned_ rather than _read_ (the import statement satisfied it). Both now fail without their
  fix. **Then the maintainer opened the app and found what none of it caught: `/` was a blank
  page.** `app/routes.ts` wraps two `flatRoutes` groups in `layout()` calls and neither group had an
  `_index` file, so the root path matched a layout with no child — `<Outlet />` rendered nothing and
  the server answered **200 with an empty `<body>`**. Not a 404, not an error; a blank document,
  black in dark mode. Every gate passed because the smoke and the 11-check browser run both
  requested `/products` and `/login` EXPLICITLY and nothing ever requested `/`, and because a status
  assertion would have passed anyway — the page was blank, not failing. Fixed with
  `app/routes/_app/_index.tsx` (which also reads the session, so the landing page demonstrates a
  capability rather than being decoration) and a smoke assertion requiring visible CONTENT at `/` —
  an `<h1>` plus a link — verified to fail when the route is deleted. The lesson is the milestone's
  own: a gate that only requests the paths its author already believed worked is not coverage. **CI
  then caught a fourth defect no local run could.** `apps/full-stack` carries a `package.json`, so
  Deno resolves npm specifiers from `node_modules` rather than its global cache — and `check:apps`
  type-checks an app BEFORE running the smoke that creates `node_modules`. On a cold checkout
  `deno check main.ts smoke.ts` failed with
  `Could not find a matching package for 'npm:ws@^8.18.0'`, because the app's import graph reaches
  plugins that lazily import npm drivers. Every local run passed because `node_modules` persisted
  from an earlier build — the warm-state trap this repo keeps hitting. Fixed with
  `"nodeModulesDir": "auto"`, reproduced first by deleting `node_modules`, `build/` and `deno.lock`
  and re-running the gate's exact order. The example is composed through
  `createFullStackAppFromConfig`, whose final statement is `return createFullStackApp(...)`, so one
  application exercises both starter entry points; the `reactRouter`, `session` and `database` arms
  are all GATED, so a default-options full-stack app registers none of them and an example omitting
  them would prove nothing. The smoke's bar is the ROADMAP's: an SSR page rendering rows **written
  through the database capability** — carried by a fifth context key (`databaseContext`) the M36c
  skeleton does not ship — then a `<Form>` login whose **302 rather than 403** proves the
  synchronizer token round-tripped through the session plugin's middleware. It is driven with
  `app.fetch`, never `inject()`, since the SSR body is a stream and step 3 reads `Set-Cookie`.
  **Four negative controls were each observed failing and then reverted**, and the second is the one
  worth keeping: replacing `contextKeyFor('app.database', …)` with a `{ defaultValue }` literal
  **type-checks cleanly (exit 0) while the smoke fails** — the module exists twice at runtime (Vite
  inlines a copy into the server build; the kernel loads the other from source), so two hand-written
  key objects match nothing and every context read silently returns its default. Two facts the
  implementation established that no gate would have: `apps/full-stack` needs the **workspace's
  `compilerOptions`** in its own manifest, because its import graph reaches `telemetry-plugin`,
  which only compiles under `exactOptionalPropertyTypes` — the same trap the CLI e2e documents for
  scaffolded projects; and `smoke.ts` ends in an explicit `Deno.exit(0)`, because importing
  `react-dom/server` under Deno keeps the process alive after `app.stop()` resolves, while
  `deno test`'s op and resource sanitizers report nothing leaked (measured by importing it alone,
  and by the same script with the `reactRouter` arm removed exiting cleanly). A ROADMAP deliverable
  was **corrected rather than implemented as written** (C1): it required `config/services.server.ts`
  to be ABSENT, but the M36c skeleton emits it deliberately and its own JSDoc says what a capability
  replaces is the module-level CACHE, not the accessor file — so the test pins the five
  `lib/*.server.ts` modules absent AND that the accessor holds no module-level state. No `packages/`
  source changed) — complete (PR #126)
- **M54** (cloud message brokers — SQS/SNS via `SqsQueue`/`SnsPublisher` in `queue-plugin`, GCP
  Pub/Sub and Azure Service Bus via `GcpPubSubBroker`/`ServiceBusBroker` in `messaging-plugin`,
  `'custom'` arm on discriminated `MessagingPluginOptions` union, cloud-gate runtime checks,
  inject-or-lazy SDK adapt/load seams, guarded real-import tests, SQS→ElasticMQ e2e in CI, plus
  guarded Pub/Sub and Service Bus emulator suites run locally — see `docs/messaging-emulators.md`) —
  complete (PR #128)
- **Milestone 55** (`packages/static-plugin` — static file serving as a capability rather than a
  side effect of SSR. The framework had exactly one static file server, `react-router-plugin`'s
  `createStaticAssetHandler`, written for content-hashed SSR bundles: an unconditional `immutable`
  `Cache-Control` applied to every response, no directory-index resolution, no conditional requests,
  and a whole-file `readFile` into memory. `StaticPlugin` registers `IStaticFiles` under a new
  `CAPABILITIES.STATIC_FILES` token with configurable `cacheControl` (a string or a per-path
  function defaulting to immutable-for-hashed, `must-revalidate` otherwise), `index`/`fallback` as
  SEPARATE options — the SPA fallback fires only when `Accept` includes `text/html`, without which a
  missing `.js` returns the HTML shell under a JavaScript content type — **strong**
  `"<size>-<mtimeMs>"` ETags degrading to a WEAK size-only validator when `StatResult.mtime` is
  absent (the strong/weak split is load-bearing, not cosmetic: `If-Range` MUST be ignored for a weak
  validator, so the originally-shipped weak form made **every resumed download restart from byte
  zero** — `size`+`mtime` is exactly what nginx and Apache emit as strong for static files, and our
  millisecond `mtime` is finer-grained than either), single-range `206`/`416` (multi-range
  deliberately falls back to `200`), `.br`/`.gz` sidecar negotiation whose ETag comes from the
  SIDECAR's stat (sharing the original's would poison caches — the one defect most likely to ship
  green here), and `GET`+`HEAD` on one handler. The pure content-type map and containment guard were
  promoted to `common` and `react-router-plugin` now delegates to them, its emitted headers pinned
  byte-identical by a regression test — §2.2 forbids the import, but §2.1 permits pure utilities, so
  this DELETED a duplicate rather than creating the M30b `pemToDer` one. Widened `IFileSystem` with
  an optional `readStream?(path, {start, end})` (`end` INCLUSIVE, matching both `node:fs` and the
  `Range` wire format so no off-by-one translation exists), implemented on Node/Deno/Bun and omitted
  on Workers. **Four defects were found after the implementation reported itself done, all with
  green-looking commits behind them.** The suite HUNG past 10 minutes (it runs in ~1m30s) on a
  contract-violating test double: the Deno mock used `read: () => Promise.resolve(3)`, but real
  `Deno.FsFile.read` returns `number | null` where `null` is EOF, so with no range options
  `bytesRemaining` is `Infinity` and the stream enqueued 64 KB chunks forever. That same file had
  REPLACED the existing tests rather than adding to them — across the three runtime adapter test
  files **1123 lines of pre-existing coverage had been deleted** (bun −320 net, node −328, deno −98)
  and swapped for readStream tests duplicating an already-correct `deno-read-stream.test.ts`; all
  three were restored with branch tests appended instead. Then the headline deliverable turned out
  to be **dead on two of three runtimes**: Node's default `mods.fs` is `node:fs/promises`, which
  exports NO `createReadStream` (probed, not assumed), so every call threw
  `Failed to create read
  stream`; and Bun declared `createReadStream` in `BunModules.fs` but
  `buildBunHost` neither imported nor returned it, so every call threw
  `not supported on this Bun version`. Both survived because every unit test INJECTED a host
  supplying what the default host lacked — the M37b ioredis and M53 `zrangebyscore` root cause
  exactly. The fix is guarded by `runtime/test/integration/read-stream-real.test.ts`, which drives
  each adapter's DEFAULT host against real files and was verified to fail with the precise
  production error when the Node fix is reverted. Finally `isLexicallyContained` did not reject
  percent-encoded traversal although its own test asserted it did: callers decode once, so a
  surviving `%2e` means DOUBLE encoding (`%252e%252e` → `%2e%2e`) that the raw `..` check cannot
  see. All `src` files ≥90% branch/function/line, with node and bun adapters at 100%;
  `release:verify` now reports **47** packages. Code review then found five more defects the green
  gates had passed, each fixed with a test verified to fail without it: a **HEAD leaked a file
  descriptor**, because the body stream was opened before the HEAD check and so was never read and
  never cancelled — one leak per HEAD on any file above `maxBufferBytes`; **hashed assets lost
  `immutable` whenever a sidecar was served**, since Cache-Control resolved from the SERVED path and
  `…-a1b2c3d4.js.br` never matches the content-hash pattern, which made the milestone's headline
  default inoperative in practice because every modern browser sends `Accept-Encoding: br, gzip`;
  the `cacheControl` callback received an ABSOLUTE path where the contract says root-relative, and
  the test that claimed to cover it ignored its argument entirely; `handler/resolve-path.ts` was
  dead — no `src` importer, absent from the barrel — and encoded the OPPOSITE of two shipped
  decisions (a bare `startsWith` prefix strip matching `/assetstest.txt`, and a fallback with no
  `Accept:
  text/html` guard), so wiring it up later would have reintroduced both; and
  `IStaticFiles.serve` was `(ctx: unknown) => Promise<unknown>` with the implementation casting,
  leaving the capability's only method untyped. **Interrupted downloads also never resumed**: the
  ETag was always weak, and `If-Range` MUST be ignored for a weak validator (RFC 9110 §13.1.5), so a
  client resuming with exactly the validator it had been issued got a `200` and restarted from byte
  zero — the ETag is now STRONG whenever `mtime` is present, matching what nginx and Apache emit for
  static files, and weak only when size is the sole signal. Reverting the three fixed `src` files
  failed 8 of 13 regression steps, the other 5 being deliberate controls) — complete (PR #132)
- **Milestone 56** (`packages/exceptions` + `packages/validation-plugin` + the three starters — RFC
  9457 Problem Details, retiring a withdrawn specification. RFC 7807 was obsoleted by RFC 9457 in
  July 2023 and the framework advertised it in two packages, a public `ErrorFormat` union value, an
  exported symbol in each, the three starters, and eleven doc sites. **The wire format barely
  changed, and that was established from the RFC rather than assumed**: Appendix D lists exactly
  three changes — a type-URI registry (§4.2), clarified multiple-problem handling (§3), and
  non-dereferenceable type-URI guidance (§3.1.1) — with the five core members, the
  `application/problem+json` media type, and extension members all carried over verbatim. So this is
  a naming change plus ONE semantic correction. That correction is **`about:blank`**: `HttpError`
  carries `statusCode`/`message`/`details`/`cause` and **no problem-type identity beyond the status
  code**, so the `https://setu-ts.dev/errors/404` it minted for every error identified nothing
  `status` did not already carry — precisely what §4.2 registers `about:blank` for. The sole
  exception is `validationError()`, the only factory placing `errors` into `details`; it defines an
  extension member, so it keeps a concrete URI, spelled to match the literal `validation-plugin`
  already emitted so both packages finally identify one problem type identically. `statusTitle()`
  needed no change — it already yields the reason phrase §4.2 wants beside `about:blank`. The
  deprecated `'rfc7807'` arm **keeps RFC 7807 behavior in `exceptions`** (§9.4 forbids silently
  changing a released API, and a symbol named after 7807 emitting something else gives the caller no
  signal); the two formatters differ only in a `typeOf` strategy passed to one shared
  `buildProblemDetails` core, so nothing is duplicated. In `validation-plugin` the alias is the
  **same object**, because that formatter's `type` was always semantic rather than status-derived
  and its body was already 9457-valid. **The defect most likely to ship green was the media type**:
  both packages keyed `application/problem+json` off a single formatter REFERENCE
  (`error-handler.ts:93`, `validation-middleware.ts:129`) so a directly-passed formatter agreed with
  the alias — adding a second formatter without generalizing that serves a Problem Details body as
  `application/json`, which generic clients ignore, while the `'rfc9457'` STRING arm tests fine.
  Both are membership tests now, driven by reference in tests; reverting the exceptions fix fails 8
  steps across the unit AND integration suites. Also corrected a doc-vs-behavior conflict predating
  the milestone: `ARCHITECTURE.md` documented `type: https://setu-ts.dev/errors/not-found` while the
  code emitted `.../404`. The `errors` extension keeps `{ field, message, code }` — realigning to
  RFC 9457 §3's illustrated `{ detail, pointer }` was explicitly declined, since `errors[].field` is
  the most widely consumed part of the validation response. Code review then found that **neither
  package asserted its barrel exports**: dropping `rfc9457Formatter` from the exceptions
  `src/index.ts` left 18 other tests green — including the integration test and all three starters,
  which are that barrel's only consumers — plus `deno check`, the 100% per-file coverage bar (a
  re-export file is fully covered merely by being loaded), and `publish:check`, because every test
  imported the concrete module rather than the barrel. The M52c defect class. Both packages now
  carry a `barrel-exports.test.ts`, and the exceptions one also pins that the internal Problem
  Details core does NOT leak into the published surface) — complete (PR #135)
- **Milestone 57** (`packages/common` + `packages/auth-plugin` + `packages/openapi-plugin` — derived
  OpenAPI security. PR #136 made an operation's requirement DECLARABLE, which left the document as a
  second source of truth: a route could carry `requireAuth()` and declare `security: []`, or carry
  no guard and inherit a document-level requirement, and nothing objected. `common` gains a
  `SECURITY_METADATA` symbol + `RouteSecurityMetadata` + the pure
  `withSecurityMetadata`/`securityMetadataOf` helpers; all six `auth-plugin` guard factories brand
  the middleware they return; `openapi-plugin` gains `deriveSecurity: { scheme }` and reads the
  brand off `RouteInfo.definition.middleware`. No plugin imports another — the symbol in `common` is
  the entire channel (the M24 `TELEMETRY_CONTEXT_OPAQUE` precedent), and it uses **`Symbol.for`**
  deliberately, because a locally-created symbol misses on every read when two copies of `common`
  share a process — the failure M37c hit with hand-written React Router context keys. **Guards were
  otherwise indistinguishable**: probed, `requireAuth()` returns a function with `name === ''`,
  arity 2, zero own properties and zero own symbols — an ad-hoc inline middleware has a BETTER
  identity than the guards did. The metadata carries authentication PRESENCE only, and that is a
  decision rather than a simplification: an OpenAPI requirement names a **scheme**, and none can be
  inferred from `'admin'`, so a `roles` field would be dead surface. The consequence is documented
  in three sites — a 403 remains a surprise the document cannot warn about. Precedence is declared >
  derived > document-level, so a route that already declares is byte-identical, which includes every
  `@Public` decorated route (PR #136 gives those a declared `[]`); `authenticated: true` beats
  `false` on a route carrying both, matching enforcement since `publicRoute()` only calls `next()`.
  Everything is **opt-in**: without `deriveSecurity` no document changes. Only ROUTE-level
  middleware is inspected — `app.middleware.add()` is absent from `RouteInfo`, which is correct
  anyway since `authMiddleware()` populates the principal and never rejects. The §3.5 `register()`
  refusal from PR #136 was extended to the derived scheme name. The integration suite drives the
  REAL `auth-plugin` guards through a kernel app rather than hand-branded fakes, which is what
  proves the two packages agree on the symbol) — complete (PR #137, stacked on PR #136)
- **Milestone 58** (`packages/cli` — `setu g module`, the first aggregate schematic and the first
  managed file. 13 single-artifact schematics existed and no aggregate, so a domain module meant
  `g controller` + `g service` plus a hand edit of `setu.config.ts` to reach
  `DecoratorPlugin({ controllers, services })`. Emits five files: an `@Injectable` service, a
  `@Controller` injecting it by an explicit token (`emitDecoratorMetadata` is unavailable under
  Deno, so a parameter's type cannot be read), a `describe`/`it` service test, a per-module barrel,
  and a regenerated aggregate barrel exporting `MODULE_CONTROLLERS`/`MODULE_SERVICES`. **The design
  problem was not the aggregate but the wiring.** `Schematic` is
  `(names, options) => readonly GeneratedFile[]` — pure, no I/O — and `--dry-run` prints from that
  same array, so nothing that reads the project can live inside a schematic; an AST edit of
  `setu.config.ts` was rejected outright (needs a TypeScript parser in a zero-dependency package,
  cannot preserve formatting, makes `--dry-run` a prediction). So the command layer scans
  `src/modules/` and passes the names through a new **optional** `SchematicOptions.modules` — the
  `plugins` precedent — and the schematic returns the whole barrel from its one pure call. Rewriting
  a barrel the CLI itself wrote needed an exemption from the overwrite refusal, shipped as a
  per-file `GeneratedFile.managed` read ONLY by `findExisting`; a `--force` flag was rejected
  because it would lift the check for all fourteen schematics and let a mistyped `g service user`
  clobber real work. Both widened types are barrel exports, so both are **optional** additions on
  the M42 `signal?` / M44 `fs?` precedent — a required `modules` would break a custom schematic's
  own test with no deprecation path, since §9.2 assumes a replacement API and an added field has
  none. The `rest`, `microservice` and `nest` templates emit the seam from scaffold time and
  reference it through `Wiring.args`, so a NEW project is wired with no edit ever; `full-stack` is
  deliberately not a host (`routes → features → services`, no `src/modules/` concept). Writing the
  tests found the defect that would have shipped green: `runGenerateCommand` rebuilt each file as
  `{ path, contents }` and **dropped `managed`**, so the exemption never reached `findExisting` and
  every generate after the first refused on the barrel — two tests failed, and it now spreads the
  file instead. A fixture defect was fixed first: `createFakeFs.stat` reported a directory only if
  its own `mkdir` had been called, so a test seeding `src/modules/user/x.ts` saw no module while a
  real filesystem would — the contract-violating-double class, now prefix-aware. The hostile-name
  sweep covers `g module` (six names including the reserved words `class` and `new`), and a
  scaffold→generate→`deno check` pass runs on both `rest` (no DI) and `nest` (DI), which is the only
  place the emitted `@Inject` is proven to compile on the container-less path. Three negative
  controls were each observed failing and reverted: removing the `managed` skip, misspelling an
  option key inside the `args` string (invisible to the CLI's own `deno check` — the M50b trap), and
  dropping the barrel sort. All new and changed files at 100% branch/function/line.

  **Code review and a functional probe then found four more defects, every one of which had passed
  all four gates, both publish gates and 100% per-file coverage.** The headline one: **the generated
  module did not work at all** — every route answered
  `500 Cannot read properties of undefined (reading 'response')`, because `DecoratorPlugin` builds a
  handler's argument list from parameter metadata ALONE (`createHandler` → `resolveParameters`) and
  never passes the request context positionally, so the emitted `list(ctx: IRequestContext)`
  received `undefined`. There is no built-in decorator for the context either — the set is
  Body/Query/Param/Header/Cookie/CurrentUser — so a decorated handler must return a plain value and
  let the plugin serialize it. The `201` on `create` is dropped rather than faked, since a decorated
  handler cannot set a status code. **`setu generate controller` carried the identical defect from
  M34 through five releases**, so every controller it ever emitted answered 500; it is fixed HERE
  rather than on a `fix/…` branch at the maintainer's direction (same package, same one-line class
  of fix), a deliberate deviation from this plan's out-of-scope list. Also: a stray directory under
  `src/modules/` (a `shared/` helper folder) was swept in as a module, so the barrel imported files
  that do not exist and the developer's project stopped compiling — a directory now counts only when
  it holds both canonical files; and the emitted service test could not run because no template
  declared `@std/testing`/`@std/expect`, whose fix then exposed an **overload** —
  `npmDevDependencies`' mere PRESENCE was a proxy for "this template has a frontend npm build", so
  declaring test deps gave a REST Node project `npm run build` and a REST **Deno** project a
  `package.json`, which switches Deno to `node_modules` resolution (the `apps/full-stack` trap).
  `TemplateManifest.npmBuildScript` now carries that signal explicitly.

  **Every one of the four hid behind a check scoped to what its author already believed worked** —
  the e2e skipping the one generated file it was least sure of, an `emits no package.json` test that
  never passed a template, and unit tests asserting decorator PRESENCE rather than behaviour (the
  `controller` one asserted the broken `IRequestContext` import was present, so a controller that
  could not serve a request was fully "covered"). The missing gate is now committed:
  `serves requests from generated modules` boots a scaffolded project in a subprocess and drives
  real requests on BOTH `--template rest` (no DI → `@Inject` resolves from the ServiceRegistry) and
  `--template nest` (DI present, a different construction path), plus one for the standalone
  controller; restoring the old shape reproduces the exact 500 and fails all three. The hostile-name
  sweep now covers `g module`, and no longer excludes `*.test.ts` from the drift check.
  `g controller`'s output shape changing is a **behaviour change to already-published generated
  output** — CHANGELOG carries the migration note, and it belongs in the next alpha's release notes)
  — complete (PR #139)
- **Milestone 60** (`packages/cli` + `cqrs-plugin` + `events-plugin` + `metrics-plugin` — generated
  code that is wired. `setu generate` emitted fourteen artifacts and exactly ONE reached a
  registration site (the M58 module barrel); the other thirteen compiled and did nothing. Eleven now
  reach one with no edit to a file the developer owns, and three get an explicit "none" backed by
  evidence. **The ROADMAP's own per-schematic sort did not survive `grep`, and correcting it was the
  milestone's substance**: five of the six artifacts it placed in the "plugin-options registration
  site" bucket have no such option — `CqrsPluginOptions` carried only `behaviors`,
  `EventsPluginOptions` only `async`/`errorHandler`, `auth-plugin` publishes no guard list, and
  `MetricsPluginOptions.customMetrics` is declarative (`NamedMetricConfig`) not the accessor
  function the schematic emits. `IApplication` also has **no `lifecycle` member**, so application
  code has no phase in which to register anything imperatively — anything needing a resolved
  capability must be a plugin option or a plugin, which is what forced the two option additions
  rather than a call somewhere in `createApp()`.

  One generalized mechanism replaces what would have been ten bespoke copies: a `SeamSpec` per
  family (`dir`/`suffix`/`barrel`/`exports`/`renderBarrel`), one `readArtifactNames` scanner, one
  optional `SchematicOptions.artifacts`, and `templates/seam.ts` deriving the scaffold-time files,
  config imports and wiring from that ONE registry — so a family cannot acquire a barrel no config
  imports, or an import no barrel exports. Two new `TemplateDefinition` fields (`setupCalls`,
  `pluginSpreads`) carry the seams whose site is a statement or an array spread rather than a plugin
  option; `configModule` rendered the plugin list, the middleware adds and the hello-world route as
  three fixed blocks and a statement was expressible in none of them.

  `CqrsPlugin` and `EventsPlugin` join the `microservice` template, because **no template installed
  them** and their three schematics are gated on them — so `g command-handler`, `g query-handler`
  and `g event-handler` could never be wired in any scaffolded project. Both are in-memory and
  zero-config (the tier's rule), and neither needs a socket, so the Workers refusal is unchanged.
  `g service` is shaped on the DETECTED plugin set (the maintainer's call among three framings):
  `@Injectable` plus a barrel with `decorator-plugin` present, today's plain class byte-for-byte
  otherwise, so it stays ungated and keeps working in a bare project. `g plugin` moves to
  `src/plugins/<name>.plugin.ts` — a suffix of `.ts` would admit any hand-written module in that
  folder and the barrel would import a symbol the developer never wrote. `g metric` gains the
  `NamedMetricConfig` its option actually takes (the accessor is how code increments a counter; the
  config is how it EXISTS at boot, visible in `/metrics` as `# HELP`/`# TYPE` before anything
  samples it — verified from `renderCounter`, not assumed).

  **Booting a fully generated project found a defect the wiring itself introduced, which is the
  whole argument for the functional bar.** `g service widget` and `g module widget` both register
  `@Injectable({ token: 'widget-service' })`, `DecoratorPlugin.registerService` is first-wins on a
  token, and the standalone barrel is spread before the module one — so the module's controller was
  handed the standalone service and every request to it answered `500`
  (`this.widgets.list is not a function`). The same class exists on HTTP paths, where the kernel
  keys `#entryMap` on `${method} ${path}` and a duplicate OVERWRITES: `GET /widget` was registered
  three times and two of the three artifacts were unreachable. `generate` now refuses both before
  writing, naming the conflict and the consequence; the check is skipped without `decorator-plugin`,
  since neither collision can exist there. That refusal in turn forced the M34b hostile-name drift
  sweep to split into three non-colliding groups — folding a suffix into the name instead would mean
  `class` never lands in a binding position again, which is the one thing that sweep exists to test.

  Verified by scaffolding both host templates, generating one of every available artifact,
  type-checking all 39 emitted files against this workspace, and BOOTING: the generated route
  answers 200 carrying the generated middleware's header, the standalone controller and the module
  both answer 200, the service and plugin tokens resolve, both indicators appear in `/health`, both
  metrics are declared in `/metrics` before anything samples them, and the command, query and event
  buses all reach their generated handlers. Four negative controls were each observed failing and
  reverted — and the fourth caught a **vacuous assertion in my own test helper**:
  `assertSeamContract` reversed a single-element list, so its byte-identical clause passed whether
  the barrel sorted or not. It now refuses fewer than two names, or names already in sorted order,
  and all ten seam contracts fail without the sort.

  **Code review then found a second defect the wiring introduced, and it is the one that would have
  hurt every existing user.** A barrel imports specific symbols from each artifact, and `middleware`
  and `metric` each gained a second export here — so a project that generated one of them BEFORE M60
  got a regenerated barrel naming a symbol its own file did not have:
  `TS2305 … has no exported member 'AUDIT_LOG_MIDDLEWARE_PRIORITY'`, from a command that reported
  success. Every existing generated project would have broken on its next `g middleware` or
  `g metric`. The scanner admitted a candidate on filename and file-ness alone; it now requires the
  file to EXPORT every symbol the barrel will import, and reports what it skipped so an artifact is
  never silently unwired. That list now has ONE home — `SeamSpec.importSymbols`, read by
  `renderBarrel` for the import it emits AND by `readArtifactNames` as the admission rule; the split
  between those two is exactly what let it ship. This is the flat-family form of the precondition
  `readModuleNames` already applies to a module directory, which the M58 review added for the
  identical reason. Reproduced with a real `deno check` and verified to fail without the fix at all
  three levels (scanner unit tests, the command-level skip report, and an e2e that type-checks the
  regenerated barrel). Fixing it dropped `seam-spec.ts` to 95.7% branch on an unreachable `?? ''`
  fallback, removed rather than tested since the arm is dead. All changed `src` files at **100%**
  branch/function/line) — complete (PR #141)
- **Milestone 61** (`packages/cli` — decorators and DI as real choices in the generator.
  AI_GUIDELINES' "5 Optional Rules" state that decorators are optional, DI is optional, and that
  **"everything has a programmatic API — no feature requires decorators or reflection"**; the
  generator contradicted all three, and the contradiction was mechanically checkable. `VALUE_FLAGS`
  declared no `--di`, `DiPlugin` appeared in exactly one template module, and `controller`/`module`
  are gated on `decorator-plugin` — so the only opt-in was the template and it was coarse: no
  template gave neither AND refused the decorated schematics, `rest`/`microservice` gave decorators
  without a container, `nest` gave both plus a NestJS showcase you may not have wanted.

  **`--di`** adds `DiPlugin` to any template. It is boolean, so it needs no `VALUE_FLAGS` entry, and
  it is read ONCE in `runNewCommand` and passed down as a `TemplateFeatures` value. It
  **deduplicates**, which is the load-bearing part rather than tidiness: the kernel THROWS
  `Duplicate plugin name 'di'` at `start()` (`plugin-resolver.ts:106`), so appending blindly would
  make `--template nest --di` scaffold a project that type-checks, passes every file assertion, and
  then cannot boot — a test pins `nest --di` byte-identical to `nest`. On `full-stack` it reaches
  the starter's own `di?: DiPluginOptions` arm instead of a wiring, because `TemplateHost.plugins`
  must stay empty when an `appFactory` is set; that arm is the one M36b built and then observed was
  "unreachable from `setu new`". `--di` forks the COMPOSITION, never the generated source —
  `DecoratorPlugin` branches on the container's presence, so the same `@Injectable` class works
  either way and only its lifecycle changes.

  **The `controller`/`module` gate refusal now names `g route`**, as `SchematicMetadata.alternative`
  data beside the gate rather than a string in the command layer. The gate is NOT removed: those
  schematics emit `@Controller`, so an ungated project would get source whose own import cannot
  resolve (the M34b defect). Schematics with no honest alternative print exactly their committed two
  lines.

  **The no-template path became a seam host**, reversing a decision M60 recorded as _Unowned_. M60's
  premise was that it "means inventing a fourth `TemplateDefinition` … where six of the ten seams
  would be inert"; neither survived checking — `seamsFor(new Set())` already returns exactly the
  three ungated seams (`route`, `middleware`, `plugin`), so none is inert, and extracting
  `TemplateHost` from `TemplateDefinition` gives the minimal path a host with no `--template` value,
  so `TEMPLATES` and `new --help` are untouched. This mattered because it is the milestone's own
  claim: a bare project's `setu g route` wrote the module and the barrel while the generated
  `setu.config.ts` imported neither, so the ONLY HTTP handler a decorator-free project can generate
  answered `404` until the developer hand-edited the config. It is now proven by BOOTING a
  scaffolded bare project and driving the route (200), its middleware header, and its plugin token.

  **Booting the full matrix found two defects the gates could not see, and both are fixed here.**
  Every `template x --di` combination was scaffolded, generated into, and BOOTED in a subprocess:
  all 8 serve, `nest` and `nest --di` are byte-identical (the dedupe holding), and a `transient`
  `@Injectable` resolves to ONE instance without a container and TWO with one — which is what makes
  `--di` a real composition change rather than a registered-and-ignored plugin. (1) The generated
  service's JSDoc told consumers to reach the class with `services.get('<name>-service')`; with a
  container that THROWS, because `registerService` registers a provider on the container and never
  touches the kernel registry. Before `--di` only `nest` had a container, so the advice was almost
  always right — the flag makes it wrong on every template, which is why the correction ships here.
  (2) **`--runtime node` could not run ANY decorated code.** It started with
  `node --experimental-strip-types main.ts`, and Node's built-in TypeScript support erases types
  without transforming code: a legacy decorator is a bare `SyntaxError` and the constructor
  parameter property `g module` emits is `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. So `--template rest`
  and `g route` booted while `g service`, `g controller`, `g module` and `--template nest` could not
  start at all — nest not even from a clean scaffold, shipped that way since M34. Node projects now
  declare `tsx` and start with `tsx main.ts`, reading the `experimentalDecorators` the generated
  tsconfig already sets; `--experimental-transform-types` was tried and rejected (it fixes the
  parameter property and still refuses the decorator). Runtime-level, not template-level — Bun
  compiles TypeScript outright and Deno/Workers never invoke the runner. Verified with real
  `npm install` + `npm start`. (3) **`--runtime cloudflare-workers` could not be built or deployed
  at all.** `wrangler` bundles `src/index.ts` with esbuild, which resolves neither `jsr:` specifiers
  nor a Deno import map, and the Workers target emitted no `package.json` and no `.npmrc` — so
  `npm install && npx wrangler dev`, which the CLI itself prints as the next step, failed with one
  `Could not resolve "@setu-ts/…"` per package. There was nothing to install. Workers projects now
  emit an npm manifest (npm-compat `@jsr/…` deps, `wrangler` pinned, `dev`/`deploy` scripts) plus
  `.npmrc`, alongside the `deno.json` that `setu generate` reads for plugin gating; Deno still gets
  none, because a `package.json` switches it to node_modules resolution.

  **Every runtime was driven for real**: Deno (8 combos), Bun (`bun install`, all artifacts 200),
  Node (`npm install` + `npm start`), Cloudflare Workers (**real workerd** via `wrangler dev` — a
  pristine scaffold serves `/`, `/health`, `/metrics` and every generated route, controller and
  module), and `full-stack --di` through a real `deno install` + `react-router build` to an SSR 200
  with the container live — which is what proves the `di: {}` string reaches the starter rather than
  merely being emitted. NOT verified against a DEPLOYED Worker: `wrangler dev --local` runs workerd
  on this machine, which is the same runtime but not Cloudflare's edge.

  **A `--no-decorators` variant was rejected rather than deferred**: it would have to emit a
  router-registered handler module, which is exactly what `g route` emits, so it is either a second
  copy of that schematic (§11.1) or a bare alias — dead surface either way.

  **One plan claim did not survive measurement and was corrected rather than quietly dropped.** The
  plan asserted the M50b mitigation — that a misspelled `args` field is "a compile error in the
  GENERATED project" — covered the `full-stack` `di: {}` string. It does not: TypeScript does NOT
  apply excess-property checking to an object literal returned from a contextually-typed callback,
  and the emitted call is `createFullStackAppFromConfig((config) => ({ … }))`. Probed against the
  real type, `{ session: {…}, totallyBogusKey: {} }` in that position type-checks CLEANLY while the
  identical literal assigned to an annotated variable raises `TS2353` — so type-checking
  `setu.config.ts` would have passed whatever key the template emitted, and this template's
  pre-existing `reactRouter`/`session` keys have the same exposure with no guard (recorded in
  ROADMAP "Out of scope", not fixed here). The e2e now writes a probe module putting the arm in an
  ANNOTATED position, verified to discriminate by renaming the starter's `di` arm and watching it
  fail. Four other negative controls were each observed failing and reverted: removing the
  `withDiPlugin` dedupe, emptying the minimal host's seams, dropping the refusal's alternative line,
  and suppressing the full-stack `di` emission) — complete (PR #142)
- **Milestone 38** (`docs/*` + `scripts/*` + `test/*` — documentation hub and tooling) — the
  documentation milestone: nine curated guides under [`docs/`](docs/) (getting-started,
  plugin-architecture, plugins, programmatic-api, decorators, custom-plugins, migration-nestjs,
  migration-fastify, examples, runtime-deployment), a reproducible
  [`deno doc`](https://docs.deno.com/runtime/reference/cli/doc/) HTML API generator
  ([`scripts/generate-api-docs.ts`](scripts/generate-api-docs.ts)) over local manifest export
  targets, a JSDoc-lint **ratchet** freezing the measured pre-existing diagnostics (776 when the
  plan was written; **775** after merging `origin/main`, which the ratchet itself caught and named —
  a below-baseline run is a failure that says "lower the constant", so debt paid down is locked in)
  while keeping ten clean packages permanently clean, a Markdown documentation gate
  ([`scripts/check-docs.ts`](scripts/check-docs.ts)) with structural package-catalog validation,
  generated-API-link and cross-file-anchor validation, and a dedicated per-file script-coverage gate
  ([`scripts/script-coverage.ts`](scripts/script-coverage.ts)) enforcing ≥90% branch/function/line
  on both documentation scripts. The snippet gate mechanically type-checks committed fixtures
  representing all nine guides plus the architecture registry example, with a negative control
  proving the compiler rejects the banned `app.get()` family. Corrected ARCHITECTURE §6
  service-registry examples (CAPABILITIES constants, no nonexistent `lazy` option,
  `registerFactory()` for lazy construction) and §16 testing claim (Deno full suite; Node/Bun
  published-artifact compat). No package source, manifest export, capability token, or plugin option
  changed. Developed on a branch cut before M56–M61, so `origin/main` was merged in before the final
  verification pass and the guides were re-checked against the merged tree — RFC 9457 (M56), derived
  OpenAPI security (M57), and the `module` schematic plus the M60/M61 CLI wiring all postdate the
  guides' first draft. Verification then found the guides still taught the DEPRECATED `'rfc7807'`
  alias in three files while `PUBLIC_API.md` called it deprecated (every gate passed — the alias
  still exists, so every fence compiled), a phantom `## HttpClient` section documenting a
  `@setu-ts/http-client-plugin` that exists nowhere in source, and two drift gates that could not
  detect their own drift because they matched a bare substring rather than a link. Also: the
  `PUBLIC_API.md` section anchors now name their package, which is a **breaking change for external
  deep links** (`#storage` → `#storage-setu-tsstorage-plugin`) — complete (PR #143)
- **Milestone 62** (`packages/cli` — monorepo support: more than one deployable service in a
  repository. The CLI had no workspace concept at all, so a second service meant
  `setu new other --dir .` — a fully independent project with its own manifest, its own lockfile,
  and no knowledge of its sibling. The sharp edge was discovery: M50b wires
  `ServiceDiscoveryPlugin({ provider: 'static', services: {} })` into the microservice template with
  a deliberately EMPTY map, because a sample entry would have named a dead port, so every caller's
  map was hand-edited in every service and nothing propagated a new name.
  **`setu new <name> --workspace` creates the root and `setu generate app <name>` adds a member.**

  **Two of the ROADMAP's three open questions were settled by MEASUREMENT, and the first removed a
  trade-off the section had assumed.** A Deno workspace root accepts a **GLOB** —
  `"workspace": ["./apps/*"]` resolves members for `deno task --recursive`, and a root whose glob
  matches nothing still runs and type-checks — so the member list is never maintained and adding a
  service rewrites NO manifest. The ROADMAP framed "one lockfile and one `deno task test`" against
  "simpler, with neither"; the glob gives the first at the cost of neither. Also measured: a
  member's `imports` MERGE with the root's rather than replacing them, a member's `compilerOptions`
  are honored (so a decorated class in a member compiles), a member needs no `name`/`version`, and
  `nodeModulesDir` is **refused** in a member
  (`"nodeModulesDir" field can only be specified in the
  workspace root deno.json file`) — which is
  why `--template full-stack` is refused as a member with a reason rather than out of caution.
  Framework pins live in each MEMBER's `deno.json` and NOT at the root, because `detectPlugins`
  reads one directory's manifest and never walks up: root-only pins would make every gated schematic
  refuse inside a member, and the e2e runs a real `g controller` inside one to prove it.

  The verb is `app`, not `service` — `setu generate service` already emits a class, and one word
  cannot mean two things in the same command. It is dispatched before the schematic registry exactly
  as `custom` is, and is deliberately NOT a registry entry: `Schematic` is a pure
  `(names, options) => GeneratedFile[]` performing no I/O, while this reads the workspace manifest,
  allocates a port and regenerates every sibling's module — hoisting that into `SchematicOptions`
  would put workspace state on a published interface no other schematic reads.

  **Discovery is the M58 mechanism applied to a CROSS-FILE write.** Every member carries a CLI-owned
  `src/discovery/services.ts`, `managed` and regenerated for ALL members on each `generate app`,
  exporting `SERVICE_PORT` (its own) and `SERVICE_ENDPOINTS` (every sibling, self EXCLUDED). The
  member's `main.ts` binds the former and its `setu.config.ts` hands the latter to the plugin, so
  the port a member binds and the port its siblings dial are ONE datum — the drift the design exists
  to remove. The overlay is applied only when the member installs `service-discovery-plugin`, since
  being reachable and consuming the map are separate properties. Ports come from
  `setu.workspace.json` and are allocated as `max(basePort - 1, ...existing) + 1`, from the MAXIMUM
  rather than the member count, so adding a name that sorts earlier cannot move a running service's
  port.

  The e2e goes past the ROADMAP's bar: it scaffolds a workspace on a **free** base port (a constant
  would collide on a machine binding real sockets), adds two members, type-checks both **from the
  workspace root with no `--config`** — which can only resolve if Deno discovered the glob — boots
  `billing` through its own generated entry, and has `orders` resolve it through
  `CAPABILITIES.SERVICE_DISCOVERY` and **fetch the resolved URL**. That last step is the only thing
  that proves map and binding agree: reverting `main.ts` to a literal port leaves everything
  type-checking and scaffolding cleanly while the request never arrives (verified — the probe burns
  its full 10 s retry loop and the assertion fails). Four negative controls were each observed
  failing and reverted: dropping `managed` (the second `generate app` refuses to overwrite),
  emitting the new member's module from its host as well (the duplicate-path guard fires), the
  literal port above, and removing the discovery gate (a plugin-less member's host stops being
  unchanged).

  Refactors this forced, both because two commands now need one implementation: the ~700-line
  project renderer moved out of `commands/new.ts` into `templates/project-files.ts` (a member IS a
  scaffolded project), and `firstDuplicatePath` moved to `utils/file-writer.ts`.
  `resolveTemplateChoice` is one template selector for both verbs, which let `isTemplateName` go —
  the registry `Map` lookup IS the unknown-name test, and keeping both left a permanently
  unreachable branch. No barrel change, so no public export moved. All new `src` files at **100%**
  branch/function/line) — complete (PR #144)
- **Milestone 59** (`packages/cloudflare-plugin` + `packages/cli` — Workers-native messaging, the
  last edge capability gap. `cloudflare-plugin` already served `QUEUE`, `CACHE`, `STORAGE`,
  `DATABASE` and `REALTIME_BACKPLANE`; `CAPABILITIES.MESSAGING` was the one token it could not,
  because all ten `messaging-plugin` brokers need a socket or a socket-bound SDK and `cloud-gate.ts`
  hard-refuses Pub/Sub and Service Bus on Workers by name. `WorkersBroker` serves it from the
  platform: `publish` is a Queues producer call, `subscribe` registers into a dispatch table the
  application's `queue` module export drives (the M52b `process`/`dispatch` split), and
  `request`/`respond` ride an opt-in `rpc` arm whose replies travel through a Durable Object the
  caller holds a WebSocket to. **Two ROADMAP claims did not survive source-checking, and correcting
  them was the milestone's substance.** It said the Workers inbox would be "a third implementation
  of a seam that exists" via M14d's `openInbox` — but `OpenInbox`, `ReplyInbox` and
  `RequestReplyCore` live in `packages/messaging-plugin/src/brokers/`, and §2.2 forbids a plugin
  importing another plugin, so the seam is unreachable from here; `common` carries no error class
  either, so promoting the two RPC errors was equally unavailable. The correlation manager is
  therefore purpose-built (not the §11.1 duplication case — the shipped core carries its reply over
  the broker's own `publish`, while here the request rides a queue and the reply is PUSHED over a
  socket no publish produced), and `CloudflareRequestTimeoutError`/`CloudflareRemoteHandlerError`
  are distinct classes, unambiguous per application because the kernel admits one provider of the
  token. It also said the microservice template's refusal would be "replaced by a runtime-aware
  arm"; no such mechanism existed — `TemplateHost.plugins` is a static array — so a declarative
  `TemplateDefinition.runtimeSwaps` is a template-contract widening, chosen over a callback so
  `--dry-run` stays exact and the swap is assertable without rendering a project. **Four platform
  facts were verified against current Cloudflare docs and each shaped the design:** a queue has
  **exactly one active consumer** (attaching a second is a publish-time error), so cross-service
  fan-out is unreachable and is documented rather than faked; `max_batch_timeout` ranges **0–60s**
  with a default of 5, which alone exhausts `RequestOptions`' default 5000 ms budget — so
  `max_batch_timeout = 0` is a stated requirement and the CLI emits it, not a tuning note; Durable
  Objects have **no wall-clock cap while the caller stays connected**, which is the only reason a DO
  reply inbox is viable; and delivery is at-least-once, so a duplicate reply is dropped rather than
  reported. The dispatch discipline mirrors `WorkersQueue` (exactly one disposition, `ack()` outside
  the handler `try`) with **one deliberate departure**: a publish whose topic has no subscriber is
  **acked**, because a job name with no processor is a mistake while publishing to a topic nobody
  listens on is ordinary pub/sub, and retrying would burn the 100-retry budget and dead-letter every
  fire-and-forget message. A request with no responder is **answered with a failure** rather than
  left to time out. Writing the tests found `respond()` throwing **synchronously** despite its
  `Promise` return type — the M52b `createQueueHandler` defect class, which a caller using
  `.catch()` would miss. Also closed the last hole in the binding-guard family:
  `BindingRegistry.queue()` cast unvalidated, so a mistyped binding booted clean, reported `up`, and
  failed on the first send with a bare `TypeError` — the exact defect M52c found on D1 and M52d on
  Durable Objects, and a contradiction of `facades.ts:402`'s own stated principle. **Removing the
  template refusal made `TemplateDefinition.unsupported` and its branch in `resolveTemplateChoice`
  unreachable by any input** (`microservice` held the last entry), dropping `choice.ts` to 80.8%
  line — so both were deleted rather than left as an uncoverable branch, which cascaded into an
  unused `runtime` parameter and two now-empty tests, all removed. Verified against **real workerd**
  via `wrangler dev`: a publish observed arriving at a subscriber in a separate `queue` invocation,
  and a full request/reply round trip through a real Durable Object. **The first negative control
  passed, which was the milestone's most useful failure** — `wrangler dev --persist-to` keeps its KV
  store between runs, so the fixed assertion value was satisfied by what an EARLIER green run had
  written and the check passed with nothing delivered at all; the note is now a fresh UUID per run,
  and both checks were then observed failing when their topic is broken. All `src` files at 100%
  branch/function/line except `workers-broker.ts` (96.2/100/99.3). **Booting a CLI-scaffolded
  Workers project then found a defect that had nothing to do with messaging and everything to do
  with actually deploying**: `detectRuntime()` compared `navigator.userAgent` against a LOWERCASE
  `'cloudflare'` while workerd reports `'Cloudflare-Workers'`, so it answered `'node'` on every real
  Worker — and since that answer picks the runtime adapter, a scaffolded Worker ran the **Node**
  adapter on Cloudflare, the `cloudflare` indicator reported `degraded`, and every
  `platform() === 'cloudflare-workers'` guard was silently disabled (including `messaging-plugin`'s
  cloud gate, so Pub/Sub attempted its gRPC load instead of the named
  `CloudBrokerUnavailableError`). Fixed here rather than on a `fix/…` branch **at the maintainer's
  direction**, a deliberate deviation from §15.2. The unit fakes sent `'cloudflare-workers/v1'` and
  `'cloudflare'` — strings the platform never sends — so the suite tested the double, the recurring
  root cause; they now use the real string, and `apps/cloudflare` asserts `detectRuntime()` on
  **real workerd**, since only the real platform sends its own user agent. The first attempt at that
  gate was itself vacuous: it asserted `runtime.platform()`, which this example gets from the
  explicitly-registered Cloudflare factory where it is hardcoded, so it passed with the bug in
  place. **Not verified against a deployed Worker** — CI holds no Cloudflare account) — complete (PR
  #145)
- **Milestone 39** (`docker/` + `k8s/` + `scripts/` + `docs/` — containerization and orchestration.
  The framework could be _served_ on four runtimes and _found_ by an orchestrator (M50) but not
  _shipped_ to one: `git ls-files` returned exactly ONE deployment artifact, M24c's collector
  config, and no Dockerfile, Compose file, Kubernetes object or deploy guide existed anywhere. Ships
  ONE parameterized `docker/Dockerfile` (`ARG APP`, builds any example — §11.1 forbids fifteen
  near-copies, so the ROADMAP's "Dockerfiles for each example" was corrected), a
  `Dockerfile.compiled` `deno compile` → distroless variant, a Compose stack, a Helm chart as the
  single authored source with **rendered manifests committed** beside it, and
  `deno task
  check:deploy`. **No `packages/` source, no capability token, no export changed.**

  **Three ROADMAP claims did not survive measurement.** `scratch` is **impossible** — `ldd` on the
  compiled binary shows it dynamically linked against glibc, so `distroless/cc-debian12` is the
  floor; the size win is 44.9 MB vs 52.4 MB, not an order of magnitude, because the binary embeds
  the whole Deno runtime, so the reason to prefer it is the removed shell, not size; and the Helm
  chart was promoted from "(optional)" to the single source, with `--render` failing on drift so
  chart and YAML cannot disagree.

  **The build context must be the repository root**, which is a correctness requirement rather than
  a convention: an example's `deno.json` maps only its DIRECT dependencies, so `@setu-ts/common`
  reaches `kernel` through the root workspace, and an image without root `deno.json` fails with
  `Could not find version of '@setu-ts/common' that matches '^0.1.0-alpha.6'` — the specifier
  resolves against JSR instead of the local member.

  **The milestone's headline finding came from trying to deploy: nothing in the framework or any
  example handled SIGTERM.** `grep` over `packages/*/src` and `apps/*/main.ts` returned zero hits,
  and a running container stopped in **144 ms with exit code 143** — killed by the signal, not the
  137 of a post-grace SIGKILL — so `app.stop()` never ran, `terminationGracePeriodSeconds` was
  decorative, and every `onStopping`/`onShutdown` hook (M50 deregistration, database and broker
  disconnects) was skipped. Fixed at the **application** layer at the maintainer's direction (a
  framework seam would need an `IRuntimeServices` signal member and a `common` widening — deferred
  and named, not omitted), documented as the recommended pattern, and verified: the same container
  now exits **0**.

  **Four more defects were caught only by a real cluster, each after all four gates were green.**
  (1) `runAsNonRoot: true` **refuses a non-numeric image user** — `USER deno` gives
  `container has runAsNonRoot and image has non-numeric user (deno), cannot verify user is
  non-root`,
  and Docker resolves the name happily, so it fails ONLY under Kubernetes; both images now declare
  numeric UIDs (1000, 65532). (2) An `emptyDir` at `/deno-dir` **masks the build-time module
  cache**, so every pod re-resolves from jsr.io at startup and dies with
  `JSR package manifest for '@hono/hono' failed to load` — fatal in an air-gapped cluster; only
  `/tmp` is mounted. (3) `helm template` defaults `.Release.Namespace` to `default`, so the
  RoleBinding named a ServiceAccount in the wrong namespace — it applied cleanly and simply granted
  nothing; every object now pins its namespace. (4) The manifests originally referenced
  `apps/minimal`, which imports kernel+runtime only and **serves no `/live` or `/ready` at all**, so
  the Deployment could never pass readiness; they reference `rest-api`, which reaches HealthPlugin
  through `rest-starter`. Probe paths are `/live` and `/ready`, NOT `/health/live` — verified 404
  against the running image.

  **The gate itself shipped two bugs that its own first real run exposed**, both in the same class:
  `helm --version` exits 1 (helm wants a bare `version`) and `kubectl --version` exits 1 too, so
  probing with a guessed flag reported an INSTALLED tool as missing — a **false skip**, the one
  outcome the exit-77 machinery exists to prevent. Presence is now resolved by looking for the
  binary on `PATH`, which cannot rot as those CLIs change. A missing-tool skip also originally
  returned "pass"; it exits 77.

  **All five negative controls were observed failing and reverted**: a `/health/live` probe drops
  ready replicas to 0; removing `COPY deno.json` fails the build with the exact resolution error;
  hand-editing a committed manifest fails `--render` by name; dropping `watch` from the Role makes
  `kubectl auth can-i watch` answer `no`; and a Service selector matching no pod empties the
  endpoints and refuses the request **while `kubectl apply` still reports success** — the defect no
  schema validator can see. Doc deliverables C1–C7 shipped: ROADMAP Docker/distroless/Helm bullets
  corrected with the measured numbers, a new ARCHITECTURE §19, `docs/deployment.md`, the RBAC the
  `kubernetes` discovery provider needs (documented NOWHERE before this), and M38's inline
  Dockerfile snippets fixed for the floating tag and root user they carried. Deliberate deviation
  from the plan: `check-deploy.ts` is NOT added to `script-coverage.ts`'s `SCRIPT_TARGETS` —
  `check-apps.ts` is not either, and the file is mostly `docker`/`kind` orchestration a test may not
  spawn; its decidable logic is exported and unit-tested instead. **Not verified against a managed
  cloud cluster** — CI holds no cloud credentials; the proof is a real local kind cluster) —
  complete (PR #149)
- **Milestone 63** (`packages/cli` — scaffold repairs) — complete (PR #153). Four defects found by
  building a three-service monorepo on the PUBLISHED `0.1.0-alpha.7` packages against real
  PostgreSQL, every one of which passed all four gates, both publish gates, and the coverage bar.
  **D1:** a project scaffolded on release day could not `deno install` at all — Deno 2.9 refuses a
  dependency published in the last 24 hours and `setu new` pins the CLI's own version, so the root
  now emits `minimumDependencyAge`. **D2:** a stock `--template rest` project answered **500 on
  `/health`**, the path its own generated Kubernetes probes point at, because the generated `start`
  task never requested `--allow-sys` for `selfIndicator`'s `runtime.hostname()`; the per-template
  `denoPermissions` seam already existed and simply had no entry. **D3:** every `.tsx` route in a
  `full-stack` project failed `deno check` with 79 `TS2686`. The mechanism is sharper than the
  obvious reading and was established only after the first negative control PASSED: a manifest with
  NO `compilerOptions` key type-checks JSX cleanly, because Deno applies its own `react-jsx` default
  — declaring ANY option replaces that set, so the unconditional `experimentalDecorators` was the
  CAUSE, not a redundant extra. Compiler options are now per template (`denoCompilerOptions`), and
  `full-stack` gains the `check:app` task that reaches route modules `deno check main.ts` never
  sees. **D6:** a fresh workspace failed `deno fmt --check` on 62 of 74 files the CLI itself wrote —
  no `fmt` config was emitted, and with one added the `.tsx` emitters still disagreed, so generated
  imports are now sorted and wrapped the way `deno fmt` does and emitted JSX is single-quoted. The
  deliverable that keeps them fixed is `test/e2e/scaffold-runs-e2e.test.ts`, which formats, lints,
  installs, type-checks and BOOTS every template, then requests what it advertises — booting
  deliberately without `-A`, since a forgotten permission is unobservable under a blanket grant.
  Four negative controls were each observed failing and reverted
- **Milestone 64** (`packages/decorator-plugin` — `@Ctx()`, the built-in parameter decorator that
  resolves the live `IRequestContext`, so a decorated handler can set a status code, add a header,
  or stream without dropping the whole route down to `app.router.post(...)`. A missing export rather
  than a feature: `createParameterDecorator` and `registerParameterResolver` were already public and
  a custom resolver is already handed the context, so this ships the ten lines every application was
  writing, as a built-in `customType` beside `current-user`. **Recognition is by neither of the two
  obvious mechanisms, and both were tried.** Matching the NAME `context` (the first commit) silently
  steals an application's own `createParameterDecorator('context')`, which was legal and documented
  before this. Matching the metadata object's IDENTITY (the second) fixes that but is fragile under
  any module duplication, so the marker is a `Symbol.for` VALUE — the `SECURITY_METADATA` precedent
  in `common/src/http.ts:383`. **The failure that fragility was first justified with does not
  happen, and building a real two-copy scenario is what showed it.** Two copies of this package
  duplicate the metadata STORE too, so decorators populate copy A's store while the plugin reads
  copy B's, `registerController` returns early on the missing `@Controller` metadata, and every
  route answers **404 with nothing logged** — louder and more confusing than the silent `undefined`
  context that was assumed, and it never reaches the marker at all. Hence two startup warnings, both
  of which **warn and never throw**: a class listed in `controllers` carrying no `@Controller`
  metadata (the duplication signal, since auto-discovery filters to decorated classes and so is
  never a developer mistake), and a custom parameter no resolver can satisfy, named by controller,
  handler and index. Not a throw because `resolveParameter` has always returned `undefined` for an
  unregistered custom type — released API, §9.4 — and because an application may register its
  resolvers after the plugin registers, which would make a startup reading stale. One
  `classifyCustom` feeds both the startup check and request-time resolution, so the two cannot drift
  about what resolves. `autoDiscover` is deliberately NOT covered: it has no in-repo consumer (not
  the CLI templates, not the starters, not any of the 15 apps) and a bad `controllersPath` already
  warns through `result.errors`. The cross-copy test imports a genuinely separate module instance
  under a distinct URL rather than hand-building a stand-in, and carries a vacuity guard asserting
  the copies really are distinct, so it cannot pass if Deno ever deduplicates them; four negative
  controls were each observed failing and reverted, including `Symbol.for` → `Symbol()`, which fails
  exactly the two cross-copy tests while the guard and the rejection cases still pass) — complete
  (PR #154)
- **Milestone 65** (`packages/cli` — functional default and `class-based` opt-in. `REST_PLUGINS`
  drops `DecoratorPlugin`, so `rest` and the `microservice` set it composes from install neither
  opt-in plugin; `--template class-based` installs the coherent decorator-and-DI pair. The selector
  is the generated manifest itself — one internal `generatorMode(plugins)` reading
  `decorator-plugin` — so `SchematicOptions` gains NO field and a later `generate` cannot silently
  emit the other style. Functional `generate module` is **ungated** and emits its registration
  through the existing routes seam rather than a new barrel, so the module is live at startup;
  decorated write handlers take M64's `@Ctx()`, which is what lets them answer a real `201`. **Two
  published CLI options were removed**, both with named refusals rather than silence: `--di` (the
  independent axis produced two incoherent compositions) points at `--template class-based`, and
  `nest` — renamed to `class-based`, since the framework has a class-based mode, not a NestJS one —
  is refused through a `RENAMED_TEMPLATES` map rather than the generic unknown-name error (§9.2: a
  published template name is public surface, and "expected one of: …" does not say which entry took
  over). Two capabilities are genuinely gone and are recorded rather than implied:
  `--template full-stack` has no DI opt-in at all now, so `FullStackStarterOptions.di` is again
  unreachable from `setu new` (M61 made it reachable and proved it with a real build and boot), and
  `generate service` in the default composition has **no registration site** — a plain function has
  none to have, so M60's "eleven of thirteen wired" no longer describes the default world; it emits
  a `src/services/index.ts` re-export for convenience, and both that barrel's header and the emitted
  JSDoc say it registers nothing.

  **Verification found one defect and two deleted proofs.** Ungating `module` made every host able
  to emit a `*.service.test.ts`, but only the templates carrying `FUNCTIONAL_MODULE_MANIFEST`
  declared `@std/testing`/`@std/expect` — so the no-template and `full-stack` hosts scaffolded
  cleanly, reported `created …/widget.service.test.ts`, and then failed `deno check` on an import
  the CLI itself had just written. That is the M58 defect exactly, reintroduced by ungating, and no
  gate saw it because the module e2e ran on `class-based` alone while the minimal seam probe
  generates route/middleware/plugin and never a module. The deps moved to their own
  `templates/test-deps.ts` and are now asserted across every host by iteration rather than by name,
  plus a real `deno check` of the emitted test in three project shapes; reverting fails 4 unit steps
  and 2 e2e steps while `--template rest` still passes, so the check discriminates. The seam probe
  had also DROPPED the microservice host with its `CQRS_PROBE`, leaving the generated command, query
  and event handlers wired by nothing observable, and dropped the service-token read rather than
  re-pointing it at the container — where `DecoratorPlugin` actually puts an `@Injectable` once
  `DiPlugin` is present (the M61 finding, and the reason the old `services.get` form would have
  thrown on the new host). Both are restored, the probe now boots BOTH opt-in hosts, and each
  restored assertion was observed failing against a deliberately wrong expectation. ~530 net lines
  of unit coverage had also been deleted rather than adapted: the module-barrel dedup and
  byte-identity guards, the never-`Deno.test` check, `assertSeamContract('service', …)`, name-casing
  idempotence, and the whole M61 JSDoc-resolution suite whose text still ships — all restored across
  both style arms.

  **A second defect surfaced from a question about the unwired service, not from a gate.** The
  artifact scan admits a file only when it exports every symbol the barrel would import, and it ran
  ONE spec per family — but `service` now has two shapes, so a functional project was scanned with
  the CLASS spec and every service the CLI had just written failed the `<Pascal>Service` check.
  Every `setu generate` after the first `g service` therefore printed
  `Skipped src/services/x.service.ts: it does not export XService` and
  `Regenerate it to bring it up to date`: there is no `DecoratorPlugin` barrel in that project, the
  file is exactly what was generated, and the advice LOOPS, since regenerating produces an identical
  file. Fixed with `FUNCTIONAL_SERVICES_SEAM` plus a `scanSeamSpecs(installed)` accessor, so the
  registry stays the one place deciding which spec describes a family; the exported symbol has one
  owner read by both the renderer and the scanner, which is exactly the split that caused it. The
  same change delivers the convenience the maintainer asked for — a managed `src/services/index.ts`
  re-export — whose header states it is not a registration, since no plugin option takes a list of
  functions. Reverting fails both new tests while the stale-class-service report keeps passing, so
  the fix narrows the diagnostic rather than disabling it. An empty-list arm added with it dropped
  the file to 50% branch and was DELETED rather than tested: this barrel is never scaffolded, only
  rendered by the schematic, which always passes the name being generated) — complete (PR #155).
- **Milestone 66** (`packages/database-plugin` — executable Prisma v7 and Drizzle adapters) —
  complete (PR #156). `PrismaAdapter` no longer constructs a client: Prisma v7 generates into an
  application-selected output path a JSR package cannot locate, and the removed lazy import passed
  the legacy `datasources` option v7 rejects, so `options.prismaClient` is now required and
  validated at `connect()`. `DrizzleAdapter` translates every repository operation into real builder
  calls against real columns — it previously selected whole tables and filtered, ordered, paginated
  and projected them in JavaScript, and passed a fabricated `{ column: 'id' }` to `eq`, so `update`
  and `delete` addressed nothing. `drizzleTables` is now required with an `id` column per table, the
  silent fallback to placeholder operators is gone, and writes read their result from `RETURNING`
  rather than echoing input back as persisted. The proof is a real `pgTable` driven through
  drizzle's actual SQL generator over a `pg-proxy` driver — no server, no credentials — and it
  discriminates: restoring the placeholder column fails it.

  **Verification found three defects the branch's own gates had passed, all fixed here.** The
  headline one is the milestone's own thesis applied incompletely: `count()` still evaluated in
  memory, selecting every matching row and measuring the resulting array's length, so counting a
  million-row table transferred a million rows. It now selects drizzle-orm's `count(*)` and reads
  the one aggregate row the database returns (`count` is exported by the pinned `0.45.2` — probed,
  not assumed, along with its `mapWith(Number)` decoding of pg's string bigint). Every fake-backed
  test passed either way, which is why it survived; the real-Drizzle proof now pins `count(*)` in
  the emitted SQL and pins that it names no columns, verified to fail against the old form. The test
  fixture had to be corrected with it — a real driver answers an aggregate select with ONE row, not
  a projected row per match, so a fake that kept projecting would have reported `NaN` through a
  shape no driver produces. Second: **the full suite did not pass on the branch.** M38's doc-fence
  gate compiles `docs/migration-nestjs.md`, and the rewritten Prisma example referenced an
  undeclared `myPrismaClient` — `deno task test` failed on it, so the four mandated gates were
  evidently not all re-run after the doc edit. Third, no CHANGELOG entry existed for what are two
  breaking configuration changes (a Prisma adapter configured by `url` alone, and a Drizzle adapter
  without `drizzleTables`, both now fail at startup); both now carry migration text. Coverage also
  gained the three genuinely uncovered branches found while checking it — missing-column rejection
  for `where`/`orderBy`/`select`, and the multi-condition `and()` combination, which no test had
  ever exercised — taking `drizzle-adapter.ts` from 94.0 to 96.4 branch.
- **Milestone 67** (`packages/cli` + `packages/starters/rest-starter` + `packages/config-plugin` —
  scaffold defaults and workspace ergonomics: the five alpha.7 findings that each cost a hand-edit.
  **D5** a `full-stack` workspace member got a generated `src/discovery/services.ts` that nothing
  could consume, because `TemplateHost.plugins` must stay empty when an `appFactory` is set and no
  starter had the arm — so `RestStarterOptions.serviceDiscovery` was added and inherits through the
  REST → microservice → full-stack chain, and an internal `AppFactoryRenderContext` lets the
  workspace overlay pass `SERVICE_ENDPOINTS` into the factory build object. **S3** the CLI emitted
  no dotenv file at all, so there was no generated answer to where configuration goes; it now emits
  a gitignored `.env` beside a tracked `.env.example`, selectable with `--env-file`. **S4** inline
  templates now pass `{ format: 'rfc9457' }` to `errorHandler`, matching the starter factories;
  `@setu-ts/exceptions` keeps its own default. **S8** a port probe at workspace creation and member
  allocation, plus `setu workspace ports --reallocate`, which rewrites manifest, maps, Compose and
  Kubernetes together. **S9** `--depends-on` records prerequisites and the generated root `dev`
  runner gates each dependent on its prerequisites' `/ready`.

  **Verification found two behavioural regressions in generated output that all eight gates passed
  over, and both are the same class: a gate scoped to what its author already believed worked.** The
  dotenv deliverable produced a project that **could not boot from a clean checkout** — the CLI
  wrote `.env`, gitignored it, and wired `ConfigPlugin({ envFilePath: '.env' })`, which THROWS on a
  missing file, so the first colleague's clone, every CI checkout, and any container built from the
  repository died at `ConfigPlugin.register` before a route existed; the generated README never
  mentioned the file. Fixed with an additive `ConfigPluginOptions.envFileOptional` (default `false`,
  so nothing released changes) that skips an ABSENT path while a path that exists and cannot be read
  still throws — a `stat` probe, because every runtime spells not-found differently and absence and
  unreadability are different faults. And every generated **workspace** failed `deno fmt --check`
  AND `deno lint`, which is M63's D6 reintroduced: the new `scripts/dev.ts` carried two empty
  `catch` blocks and lines past the width its own emitted `fmt` config sets, and a root README
  paragraph was hand-wrapped to the wrong column. Neither could be seen because
  `scaffold-runs-e2e.test.ts` — the M63 gate — covers only `setu new <name> --template …` and never
  `--workspace`, and because **nothing ever executed the dev runner**: it was asserted as
  `toContain('/ready')` against the template literal that renders it, while the plan had promised a
  real e2e proving a dependent waits and a subprocess test of the failure path. Both gates now
  exist: `workspace-e2e` formats and lints a real generated workspace, and a new `dev-runner-e2e`
  RUNS the emitted runner against fixture members whose prerequisite binds after a deliberate delay
  — the only way "started after" and "started concurrently" can be told apart, and the control with
  `dependsOn` removed reports the opposite result from identical fixtures. `scaffold-runs-e2e`
  gained the assertions the plan had mapped to it and never got: the dotenv pair and its ignore
  rule, a boot with the file DELETED, a value read back through the configured path, and a thrown
  error's Problem Details body asserted field by field with `message` absent. Also fixed: the
  `.env.example` named none of the variables the generated code requires — `full-stack` emits
  `config.getOrThrow('SESSION_SECRET')` and shipped a blank example — so `TemplateManifest` gained
  `envVariables`, with a development value in the ignored file and an empty one in the committed
  example; `--depends-on` was silently accepted on a standalone `new`, unlike every other misapplied
  flag; a Deno project's `.gitignore` had grown a `.wrangler/` rule for a directory that target
  cannot produce; and the config-plugin wiring carried a hardcoded dotenv literal beside the
  manifest one, a second source of truth that `--env-file` silently overrode. **One verification
  finding was itself wrong and was reversed rather than shipped**: the `--env-file` refusal in
  `generate app` was reported as missing a Cloudflare Workers arm, but a workspace refuses
  `--runtime cloudflare-workers` at creation and `readWorkspaceManifest` refuses a manifest naming
  it, so a Workers member cannot exist and the branch would have been unreachable — it is a comment
  saying so instead. Six negative controls were each observed failing and reverted) — complete (PR
  #157)
- **Milestone 68** (contract gaps: `common` + `kernel` + `auth-plugin` + `database-plugin` +
  `cloudflare-plugin` — the four alpha.7 smoke findings that touch committed contracts). **S5:** a
  portable `FilterExpression` tree in `common` (`eq`/`contains`/`gt`/`gte`/`lt`/`lte`/`in`, composed
  with `and`/`or`) plus `IRepository.findOne`. It is **additive** — `filter` sits beside the
  released equality `where` map rather than replacing it, which keeps every existing call
  source-compatible AND avoids reserving `or`/`and` as user field names. Each of the four adapters
  translates natively (Memory evaluates rows, Prisma builds `where` input, Drizzle builds an
  operator tree, D1 builds bound SQL); nothing filters in JavaScript. Two semantics had to be
  decided rather than inherited, because SQL and an in-memory `===` disagree: an `in` list
  containing `null` gets an explicit null branch (SQL `IN` never matches `NULL`), and an EMPTY `in`
  compiles to a match-nothing predicate that binds no values. `findOne` is `findAll` with
  `limit: 1`, so there is exactly one evaluation path per adapter. **S6:** the router refuses a
  duplicate `METHOD path` before mutating anything — a **breaking behaviour change**, since the
  entry map previously OVERWROTE, making one of the two handlers permanently unreachable with no
  diagnostic. **S7:** `RouteInfo.owner` (optional, so the addition is source-compatible) reports the
  plugin whose `register()` created a route, reusing the registration cursor the env-var validator
  already maintained rather than adding a second registry. **S10:** `AuthPluginOptions.rbac` is
  optional; absent it, `provides` names only `jwt`/`authentication` and no authorization service
  exists — guards then fail loudly instead of resolving a permissive fake.

  **Verification then found that the milestone's own gates could not see most of what it shipped.**
  Every gate was green, coverage exited 0, and both publish gates passed — while
  `drizzle-adapter.ts` had REGRESSED from 96.4 to 90.3 branch, because `eq`/`gt`/`gte`/`lt`/`lte`,
  null-only `in`, and both identity short-circuits were translated by code no test executed; the
  same five leaves were uncovered in Prisma, and D1's `eq`-null, empty `in`, null-only `in` and
  empty-composition arms in the SQL builder. Four rows of the plan's own test table were never
  written, including the one that mattered most — D1's filter SQL was asserted only as STRINGS and
  never executed, which is the exact gap M52c's review had closed once already. Driving all of it
  found no defect (probed: real SQLite through the repository, and the real Drizzle SQL generator),
  so the gap was a missing regression guard rather than a bug — an operator-mapping typo would have
  shipped green. All four rows are now delivered, including a `findOne({ filter })` lookup over HTTP
  and a JWT-only app driven through a REAL kernel application, since the auth suite's fake registry
  returns `undefined` for an unregistered token where the kernel's throws — the guard-without-RBAC
  question is unanswerable against the fake.

  **One real defect was found, and only by asking which dialect the escaping was written for.**
  `contains` escaped `%`/`_`/`\` and emitted a bare `like()`, which relies on the DEFAULT escape
  character — a backslash on PostgreSQL and MySQL, and **undefined on SQLite**, where `LIKE` has
  none. Measured against real SQLite: the emitted pattern matched ZERO rows, so a literal search for
  a value containing `%` returned nothing at all. The predicate is now built with Drizzle's `sql`
  tag as `LIKE ? ESCAPE '\'` (standard SQL, verified rendering on both dialects and executing
  correctly on real SQLite), and `DrizzleOperators` takes `sql` in place of `like`. Two things kept
  this invisible: the only real-Drizzle test runs on `pg-proxy`, where the bug is unreachable
  because Postgres happens to define the same escape character — and `DrizzleAdapter` structurally
  requires `execute`, which no SQLite driver exposes, so the adapter REFUSES a SQLite instance
  outright today and the bug was latent rather than live. The new regression test therefore drives
  `createDrizzleDataSource` (public API in its own right) over `sqlite-proxy` against a real
  `node:sqlite` engine, with `50XYoff now` seeded as the negative control an unescaped wildcard
  would also return; reverting the clause fails it and its Postgres sibling. Case sensitivity is NOT
  fixed and is now documented in three sites instead: `contains` follows the column's collation on a
  `LIKE` backend, which no portable operator can override.

  Also corrected: the seven `IRouterApi` verb methods gained a throw and documented none of it; the
  `rest-starter` `auth` arm still told callers RBAC was required; the database README got export-
  table rows but not the prose deliverable the plan named; and the CHANGELOG recorded nothing at all
  — including the two breaking changes (duplicate-route refusal, and `IRepository.findOne` being
  required for a direct implementor). The `guide-fence-compiler` B9 negative control was repaired
  during implementation and the repair is worth keeping in mind: it had been passing because `rbac`
  was missing, NOT because `jwt.secret` was, so making `rbac` optional is what exposed that the
  control had never tested its own claim — complete (PR #158)
- **Milestone 69** (`packages/database-plugin` — typed Drizzle query seam).
  `createDrizzleDatabase(drizzleDb, transactionBridge)` now creates an opaque package-owned
  typed/runtime configuration and distinct `getDrizzleDatabase(service, configured)` /
  `getDrizzleTransaction(uow, configured)` accessors preserve the exact outer Drizzle type while
  deriving the narrower callback-scoped native transaction type for a Unit of Work, excluding
  outer-only operations. A real `node:sqlite` join proves repository writes are visible inside that
  transaction and absent after rollback; exact selected-row inference is compile-time asserted.
  Promise-aware SQLite Proxy/libsql-shaped instances without `execute()` now support repositories
  and typed builders, while raw `query()` refuses them at the call site with a descriptive error.
  Synchronous callback drivers are explicitly rejected because the native transaction closes before
  awaited UoW work begins. Portable database contracts, tokens, and manifest exports remain
  unchanged.

  **This is a BREAKING configuration change and the one thing an upgrading reader needs first:**
  `DatabaseAdapterOptions.drizzleInstance` moved from `unknown` to the opaque
  `DrizzleDatabaseIdentity`, so every existing `type: 'drizzle'` application must wrap its instance
  in `createDrizzleDatabase(db, (database, work) => database.transaction(work))` — an unwrapped one
  is a COMPILE error, and `connect()` rejects it at runtime too. The bridge is application-supplied
  rather than inferred on purpose: a driver whose `transaction` callback is synchronous
  (better-sqlite3) commits before any awaited unit-of-work runs, so inferring promise-awareness from
  a structural `transaction` method would report atomicity the database never provided. Those
  drivers are refused by `createDrizzleDatabase`'s own types — verified by probing an async- and a
  sync-shaped database type, where the `@ts-expect-error` on the sync one is satisfied, so the guard
  fires rather than being decorative.

  Code review then found five things every gate had passed. The headline one is a documentation
  failure rather than a runtime bug, which is exactly why nothing caught it: the breaking change
  above was filed under CHANGELOG **Added** with no migration text, so an upgrading application
  would have met it as a compile error with no entry explaining it — now under Changed, with the
  wrap snippet and the reason. The committed plan also still asserted "No `WeakMap`, module-global
  registry ... is added" while `drizzle-database.ts` adds exactly that to map a witness back to its
  database (recorded as a correction rather than quietly left stale); `DrizzleDatabaseIdentity`'s
  JSDoc claimed the barrel exports the correlated type "instead" when it exports both; and this diff
  had rewritten TWO deliberate `NEVER Date.now()` guards into neutral prose, unrelated to the
  milestone — clock-mixing is a named recurring pitfall here, so both were restored. Finally, three
  NEW defensive branches were reachable but untested, including the outer-scope refusal in
  `UnitOfWork`, which is the one that would silently escape a transaction — a caller can construct
  that case through the public two-argument constructor. All three now have tests naming the failure
  they guard, taking `drizzle-query.ts`, `drizzle-database.ts` and `unit-of-work.ts` to 100%
  branch/function/line — complete (PR #162)
- **Milestone 70h** (`packages/cli` + `packages/common` + `packages/runtime` — the CLI scaffold
  batch of the alpha.8 smoke programme: **23 register rows** closed on one branch, because they
  share one shape — **a generated file sits outside every check path the generated project actually
  runs.** A `full-stack` project could not be started by following its own README, a pristine one
  failed its own `check:app` on a cold checkout, a `--transport rabbitmq` workspace failed its own
  `deno fmt --check` before anything was edited, and a Workers project's `deno task start` bound
  nothing and exited `0`.

  **Three scope calls widened the ROADMAP's stated `(cli, starters)` boundary, each the maintainer's
  at plan time.** **B1** is closed completely rather than in its two CLI-side halves: `common` gains
  an optional `IRuntimeServices.onSignal?(signal, handler)` + `RuntimeSignal`, implemented by the
  Node/Deno/Bun adapters on the `fs?`/`workers?`/`dns?` precedent. It is the one member absent for
  **two unrelated reasons** — Workers has no signal to receive (an isolate is evicted), and the Deno
  adapter omits it on **Windows**, where registering `SIGTERM` THROWS rather than no-opping — so the
  key's presence means "this runtime can register a handler", never "this platform raises signals";
  a no-op was rejected because it would let a caller conclude a shutdown handler runs when it never
  would. The payoff is that the generated `main.ts` now emits **ONE body, byte-identical across
  Deno, Node and Bun**, reaching no runtime API at all — no `Deno.addSignalListener`, no
  `Deno.exit`, no `process.on`, no `Deno.build.os` guard — where it previously rendered three bodies
  fixed at `setu new` time, so moving a project between runtimes meant rewriting its entry by hand.
  **E8** was reassigned here from M70n (the ROADMAP still called it "a decision to take, not a
  defect to fix" while `smoke/X1-FINDINGS.md` records the maintainer having already classified it a
  defect with breakage accepted): `src/routes/` folds into `src/controllers/`, so one directory and
  one barrel carry both generator shapes. That is not a new mechanism — `FUNCTIONAL_SERVICES_SEAM` /
  `SERVICES_SEAM` already share a `dir` and a `barrel`, and `SeamSpec.renderBarrel` takes the full
  `SeamArtifacts` record rather than one name list, which is exactly what lets ONE barrel read two
  kinds. **D3** was built rather than deferred: `setu add <plugin>` exists, so the two sites that
  told a developer to "install `@setu-ts/auth-plugin`" now name a command that does it.

  **Two of the plan's own negative controls did not hold as written, and measuring them is what
  showed it — both are recorded in the plan as corrections rather than quietly dropped.** The plan
  claimed the literal-`Deno.exit` body would fail "the shutdown e2e on Node"; it passes, because
  **no e2e in this repository boots a Node project at all**, and none can until `runtime` publishes
  with `onSignal` — a `--runtime node` project resolves `@setu-ts/runtime` from the published npm
  mirror and npm has no import-map equivalent for `useWorkspacePackages` to repoint. The control
  fails **6 unit steps** instead (byte-identity across targets, and
  `reaches no runtime-specific
  API` for each of deno/node/bun), which is the honest site, since
  what B1 changes is the emitted source rather than the Deno run of it. And the plan asserted the
  boot gate "asserts membership too" — it did not: removing a template from `BOOTABLE` made its
  build-and-boot assertions VANISH rather than fail, a one-word edit leaving the whole gate green
  while covering strictly less. That assertion now exists (the M37c `ALLOW_SKIP` precedent).
  Dropping `full-stack` happens to trip `deno check` (the `as const` narrows an equality into an
  impossible comparison), but dropping `microservice` type-checks **cleanly** — so the runtime
  assertion is the one that discriminates, and both were observed. The other four controls each
  failed and were reverted: the inline config callback (4 steps, 49 passing), the transport wrapping
  (`rabbitmq` fmt gate fails while `http` passes — verified both halves), `nodeModulesDir` (cold
  `check:app` fails resolving `@react-router/fs-routes`, passes with it), and `ROUTES_SEAM` pointed
  back at `src/routes` (9 tests).

  Also: `g migration` emitted a file nothing imported and nothing could run, so every project
  hand-wrote the same runner — it now emits a managed barrel in filename order plus a project-local
  `src/migrations/run.ts` and a `db:migrate` task. That is deliberately **not** a `SeamSpec`, and
  `seams/registry.ts` now says why: a framework seam is a registration site the framework reads,
  while this is a script the developer runs, and making it a seam would put a barrel into
  `setu.config.ts` that nothing consumes. `g module`'s barrel star-re-exports its service instead of
  naming the stub symbol — naming it meant that replacing the stub, the obvious next step, broke the
  barrel AND the generated test with `TS2305`, and neither file is reachable from
  `deno check main.ts setu.config.ts`, so both stayed broken through a full green run. Every
  template now emits a `test` task, without which that generated test was reachable by nothing.

  **Two breaking changes to already-published generated output**, both with CHANGELOG migration
  text: the `src/routes/` → `src/controllers/` move and the module barrel's re-export shape.

  **A verification-and-review pass then found ten more defects, every one past all four gates, both
  publish gates and the per-file bar — and the three worst were found by USING the CLI rather than
  by reading it.** (1) In a functional project `g route widget` then `g controller widget` reported
  success twice and left a barrel importing `registerWidgetRoutes` from two files: `TS2300`, so the
  generated project did not compile. M60's guard existed but returned early without
  `decorator-plugin`, on a premise that M65's ungating of `module` and this milestone's ungating of
  `controller` had each already falsified — and a test **asserted the old behaviour**, comment and
  all. (2) A project predating the `src/routes/` merge is invisible to every check in the command:
  the scanner reads the NEW directory, so the old one is never scanned, never skipped and never
  reported, while `setu.config.ts` still imports the old barrel — `g route billing` printed
  `created` and left the route unreachable. The CHANGELOG claim that such a project "degrades
  loudly" was **my own, and false**; it now reports the migration. (3) The milestone's headline X2-4
  fix reached **2 of 8 call sites**: `renderList` took a guessed `prefixWidth` defaulting to 24, and
  the one caller that overrode it wrote its own declaration out a second time to call `.length` on
  it. Measured — three generated plugins produced a **123-column** line and three families produced
  103–112-column imports, so a project failed its own `deno fmt --check` on files the CLI had just
  written. It now derives the prefix from the name and type it already has, imports wrap too, a
  duplicate copy is deleted and one owned constant replaces four copies of `100`. The gate that
  missed it generated exactly ONE artifact of the one family that was fixed; it now generates three
  of every family.

  (4) **The generated test could not run off Deno at all** — `@std/testing/bdd` reaches `Deno.test`
  inside its own `_test_suite.js`, so on Bun it died with `ReferenceError: Deno is not defined`
  before a single assertion, and Node and Bun had no `test` script while the CHANGELOG claimed every
  template did. Each target now emits a harness it can execute (`bun:test`, `node:test`), verified
  by running them (`1 pass` / `pass 1`), and those two stop declaring `@std/*` — dependencies that
  could only fail there. That also exposed that `generate` **assumed Deno** whenever `--runtime` was
  absent, which nobody passes; it now detects the target from the project's own manifests. (5) A
  health indicator generated before A2 is dropped from its barrel and **its check stops running**,
  and the report said "Regenerate it" — which the overwrite check then refuses, the M65 loop
  exactly. Both real routes out are now named, and this plus the host-seam widening
  (`DenoHost`/`NodeHost`/ `BunHost` gained REQUIRED members, breaking any injected fake) are
  recorded as breaking changes; neither was. (6) `SchematicAlternative` lost its last producer when
  `controller` was ungated, leaving a branch unreachable by any input — deleted with it (M59's
  precedent).

  Five stale claims were corrected against the code rather than reworded around: `db:migrate` was
  documented in three places and emitted nowhere; the migration runner was `managed` while telling
  the developer it was theirs to extend; `export *` fixes the barrel and NOT the generated test,
  which names the function it exercises and should; `.env` cannot supply `PORT`, since
  `ConfigPlugin` loads it into its own store and the entry is evaluated before any plugin registers;
  and the ROADMAP package list named `starters`, which this branch never touches. Weak tests were
  replaced rather than left: the `add` harness reimplemented `parseArgs` and turned every flag into
  boolean `true`, so `--dir` was never exercised and reading the wrong flag name would have passed
  all twelve; a gate list was hardcoded and already stale; a refusal assertion was satisfied by the
  echoed name; and Bun's `onSignal` delegation was asserted by nothing. A mesh e2e also probed two
  peers without waiting for them to bind, and killed an already-exited child — which replaced the
  real failure with a `TypeError` naming no peer.

  All changed `src` files ≥90% branch/function/line, every file added during review at 100%) —
  complete (PR #166)
- **Milestone 70a** (`common` + `kernel` + `runtime` + `grpc-plugin` + `websocket-plugin` — the
  pipeline bypass, first of the M70 alpha-8 defect closeout. `setUpgradeRouter`/`setRpcHandler` were
  consulted **inside the HTTP adapter, before** the request was mapped and entered the kernel
  pipeline, so **no middleware applied to a WebSocket upgrade or a gRPC request at all**: X6-1 an
  unauthenticated WebSocket writing through a guarded endpoint, X7-6 an unauthenticated gRPC client
  reading and writing through one, metrics and security headers absent on both, and X7-7 RPC serving
  `200` through the whole shutdown drain while ordinary paths answered `503`. Every inbound request
  now runs the pipeline FIRST; the handshake or RPC dispatch happens only in the kernel terminal
  handler, after the pipeline declines to short-circuit — so X7-7 falls out for free, since
  `#stopping` is checked at the top of `#handleRequest`.

  Four flagged `common` widenings, all optional so no implementor breaks: `IRequest.raw?` /
  `IRequestContext.raw?` carry the **undisturbed** web `Request` (the M42 `signal?` / M44 `fs?`
  precedent), `IWebSocketService.routeUpgrade?`, and `IGrpcService.claims?`. The intent travels on
  the `IRequest`, branded under a `Symbol.for` key with `setUpgradeIntent`/`upgradeIntentOf` (the
  M57 `SECURITY_METADATA` precedent) — **the plan's §3.2 choice of `ctx.state` is unimplementable
  and the plan is corrected rather than left standing**: the adapter holds the `IRequest` and never
  sees the `IRequestContext`, which the kernel builds and discards internally, so nothing written to
  `ctx.state` could ever reach the adapter that must perform the handshake. The mechanism is
  per-adapter because the upgrade does not arrive on one path: Deno and Workers already have it on
  the fetch path, Bun's lives in the `Bun.serve` callback, and Node's never reaches fetch at all —
  it arrives on the raw `upgrade` event, which now runs the framework handler before handshaking.

  **The first implementation shipped four defects that every gate passed, and the two worst are the
  ones its own plan had named.** `#tryGrpc` had **no `basePath` guard**, and since
  `IGrpcService.handleRequest` is typed `Promise<Response>` and never returns `null`, it claimed
  EVERY unmatched route — so merely registering `GrpcPlugin` changed the whole application's 404
  from the kernel's `{"error":"Not Found"}` (`application/json`) to gRPC's `Not Found`
  (`text/plain`). That is verbatim the plan's §6 negative control ("remove the `basePath` guard and
  an ordinary 404 route must start reaching gRPC"), so it was evidently never run; the guard is now
  `IGrpcService.claims`, which exists because "outside my base path" and "mine, but no such
  procedure" are indistinguishable once both have collapsed into a 404. §3.6 was **not implemented**
  either — an upgrade carrying a body was answered `101`, because the check read `content-length`,
  which is absent both on an in-process `Request` and on any chunked upload; it now reads the
  **mapped** body, and `upgrade-with-body.test.ts` no longer carries a test titled "is refused 400"
  that asserted `200`. Third, **the suite was red**: moving detection into the kernel put a throwing
  header read outside `WebSocketService`'s reporting wrapper, so an upgrade-router failure was
  logged nowhere — detection now lives in the router's own `#route`, which is both where
  `WsRouteTable` (path-only) needs it and inside the wrapper, and the kernel keeps a try/catch
  backstop for a third-party service that does not report. Fourth, the docs gate was red on the
  `common` README exports table.

  **`inject()` could not reach either new path**, because it built a synthetic `IRequest` with no
  `raw` — so every kernel-level upgrade test passed vacuously by falling through to the 404. It now
  populates `raw`, guarded so a malformed URL still surfaces as the 400 `createRequestContext`
  produces. Dead surface from the retired seam is deprecated rather than removed (§9.2):
  `setRpcHandler?`, `RpcInterceptorStore`, `GrpcUnavailableError`, `GrpcService.createFetchHandler`,
  and `IGrpcService.available`, now unconditionally `true`. `UpgradeRouterStore.consult` IS deleted
  — internal, not barrel-exported — leaving `set`/`hasRouter`, which is all Node's listener gate
  needs. `isWebSocketUpgradeRequest` was promoted to `common` (the kernel cannot import `runtime`)
  and `runtime` re-exports it, deleting the duplicate rather than creating one — the kernel's
  hand-rolled copy had used a **substring** match on `Connection`, which claims `no-upgrade`.

  **Code review then found the defect that would have hurt the most users, and it was one of
  placement rather than logic.** Both helpers were consulted only inside `if (routeResult === null)`
  — so protocol dispatch lost to ANY matching route, and `react-router-plugin` mounts a catch-all on
  all seven verbs for SSR. Measured on a real app with `/*` registered: a WebSocket client was
  answered `200 {"ssr":true}` and so was a gRPC client. That breaks exactly the two compositions the
  framework advertises, full-stack SSR plus realtime and microservice plus gRPC, and it is narrower
  but still real without a catch-all — a plain `app.router.get('/ws')` shadowed `ws.route('/ws')`.
  Pre-M70a the adapter consulted both BEFORE routing, so this was a regression the milestone
  introduced. Dispatch now runs before route matching and still inside the pipeline, which keeps the
  security property and restores the precedence: a protocol switch is not an HTTP route, and a path
  inside the gRPC `basePath` belongs to gRPC (M49). That move needed one companion change or it
  would have traded the bug for a worse one — `basePath: '/'` normalizes to `''`, which CONTAINS
  every path, so a prefix-only `claims()` consulted before routing would have `404`ed the whole
  application; at the root it now reports only registered procedures, mirroring the asymmetry
  `dispatchRequest` already documents. The two capability lookups also moved from try/catch around
  `get` to `has`, since they now run per request rather than per 404.

  Two smaller review findings: a third-party upgrade router's throw was discarded although the
  kernel has a logger eight lines away (the pre-M70a rationale — "the adapter holds no logger" — no
  longer applies), now reported through the same channel as a suppressed hook error; and an
  **accepted** upgrade is answered by the runtime's own `101`, which carries none of the response
  headers a middleware wrote on `ctx.response` — measured: `x-security` and `Set-Cookie` present on
  a 404, both absent on the 101. That is a real limit rather than a bug (the socket is taken over
  before there is a response to decorate), but three doc sites claimed security headers "apply" to
  upgrades, so all three are scoped to say the pipeline RUNS — which is what lets a guard refuse —
  and a refused upgrade carries everything. Writing the shadowing test also caught a
  contract-violating double of my own: the fake `IWebSocketService` accepted a plain GET that a real
  one declines, which would have made the control pass for the wrong reason; it now applies the same
  RFC 6455 detection the real service does.

  Verified past the gates: a **real socket** on Deno completes a `hello`/`echo:ping` round trip and
  an unauthenticated one is refused with the guard observed running; the 404 body and content-type
  are byte-identical with and without `GrpcPlugin`; an upgrade with a body is `400` both with and
  without `content-length`; a WebSocket and a gRPC call both survive an SSR catch-all while that
  catch-all still serves every other path; a root-mounted gRPC service leaves ordinary routes alone
  while still serving its own procedures; and the drain answers `503` on both protocols. Six
  negative controls were each observed failing and reverted) — complete (PR #167)
- **Milestone 70b** (`cache-plugin` + `multi-tenancy-plugin` + `session-plugin` +
  `database-plugin` + `exceptions` + `feature-flags-plugin` + `common` — tenant isolation and data
  exposure). **Security.** Five rows in one branch, all with the same shape: a capability that was
  supposed to respect the tenant did not. X4-1 — `cacheMiddleware` keyed on `method:url` alone, so a
  tenant was served another tenant's cached body; the key now composes a length-prefixed tenant
  segment around the default **or** a custom `key`, and a `vary` option joins caller-supplied
  segments after it. X4-3 — a session minted under tenant A was presented under tenant B and wrote
  through; the session now seals the resolved tenant id into a reserved key on commit and the
  middleware short-circuits with `403` on a mismatch before the handler runs (`tenantBinding`,
  default `true`, inert without a tenancy plugin). X12-3 — every unhandled 500 returned the failing
  SQL and its bound parameters to the client; `ErrorHandlerOptions.maskInternalErrors` (default
  `true`) now masks a non-`HttpError` with status ≥ 500 to a generic detail after the logger has
  received the real one, and `false` restores the previous body verbatim. X12-1 — Prisma's
  `contains` treated `%`/`_` as `LIKE` wildcards, so a search for `50% off` returned every row; the
  value is now escaped on the connectors whose `LIKE` defaults its escape character to backslash,
  and refused with a named `UnsupportedFilterOperatorError` on SQLite (where the escape is not
  expressible) or when the connector cannot be determined, naming the new `provider` option. The
  `escapeLikePattern` helper moved to a shared `query/like-escape.ts` so Drizzle and Prisma cannot
  drift, and a `filter-conformance.test.ts` runs one query through every adapter and asserts they
  agree or refuse. X4-2 — `required: true` broke the k8s probes, because they carry no tenant
  header; `MultiTenancyPluginOptions.exclude` (default the six operational probe paths) skips the
  middleware body for a matching path, and `[]` restores the old behaviour. X4-6 — feature flags had
  no tenant dimension; `FlagContext.tenantId` (in `common`) and `FlagDefinition.tenants` (in the
  plugin) add a tenant _restriction_ ahead of every other rule, and `createFlagGuard` derives
  `tenantId` from `ctx.request.tenant?.id`. The package list was corrected at implementation time to
  add `feature-flags-plugin` and `common` (the X4-6 row the body assigned but the original list
  omitted, mirroring the M70h correction). X12-3 closes without a `cli` change: the fix is a safe
  default, so every already-scaffolded project picks it up by upgrading the package. — complete (PR
  #168)
- **Milestone 45b** (`packages/worker-pool-plugin` — `TaskPoolStats` as a Prometheus signal. M45
  built the snapshot and gave it exactly one consumer, the `worker-pool` health indicator, so pool
  saturation was answerable only by polling `/health` and diffing counts by hand. The plugin now
  resolves `CAPABILITIES.METRICS` **optionally** — `optionalDependencies` + `ctx.services.has`, the
  M47 `REALTIME_BACKPLANE` precedent — and pushes six instruments from an internal
  `WorkerPoolCollector`. **No `common` change, no new token, and `src/index.ts` is unchanged**: this
  ships a signal, not an API, and a `barrel-exports` test pins that (the M56 defect class). Absent
  `metrics-plugin` every call site is optional-chained and behaviour is byte-identical to M45.

  **Sampling is a push from the pool's own state transitions, and that was a decision rather than a
  default**: `IMetricsService` (`common/src/services/metrics.ts:154`) exposes no scrape-time
  callback, so the model had to be chosen, and interval sampling is the arm with a real wrong answer
  — a timer outliving `onClose` leaks a handle per application, which is the M53
  `RedisStreamsBroker` defect exactly. A test asserts no `setInterval` is ever armed. Gauges are
  written with `set()` from the SAME `stats()` the health indicator reads, at the five origins of
  state change (`run`/`onMessage`/`onWorkerError`/`onTimeout`/`shutdown` — every other mutation is
  reached only from one of those), so the two surfaces cannot disagree; counters take `inc(1)` at
  the settle sites, never the cumulative snapshot, which is the double-count trap the ROADMAP named.

  **The two failure counters are deliberately separate, and the split is what makes them honest.**
  `worker_pool_tasks_failed_total{task_module,reason}` is incremented at the one site that also
  increments `failedCount`, so summed over `reason` it always equals the health payload's `failed`.
  But `TaskPool.run` refuses a queue-full submission BEFORE a `Task` exists, so `stats().failed` can
  never see the clearest saturation signal the pool produces — hence
  `worker_pool_tasks_rejected_total`, a sixth instrument beyond the ROADMAP's five, covering
  `queue_full`/`pool_closed`/`unavailable`. Replicating the gap or widening `failedCount` (a
  behaviour change to a published health payload) were both rejected.

  **X8-2 is fixed here, and X8-7 stays with M70k** — the ROADMAP named both as prerequisites and the
  scope was set by the maintainer. X8-2 is a `try`/`catch` around one `postMessage`: reached from
  `run()` a `DataCloneError` rejects the caller's promise, but reached from `pump()` inside an
  `onMessage` callback the identical throw is an uncaught exception that **killed the host process**
  — so a bad input on a busy pool took the application down while the same input on an idle pool
  rejected cleanly. Catching inside `dispatch` makes both paths agree, retains the worker (it never
  received anything), and the drain loop now re-offers the freed slot to the next queued task rather
  than stalling behind the bad one. X8-7's named fix needs a worker exit signal `IWorkerHandle`
  (`common/src/runtime.ts:149`) does not have — an optional `common` widening plus per-runtime
  implementations, and a web `Worker` fires nothing on `self.close()` — so it is documented in the
  README and `PUBLIC_API.md` rather than half-fixed.

  **Two of the four negative controls corrected the work rather than confirming it.** Reverting the
  X8-2 guard failed all five clone tests with the raw `DataCloneError` escaping — but it also
  revealed that the test named "dispatched straight from `run()` (path A)" was not testing that path
  at all: no worker was ready yet, so `run()` merely queued and the drain did the dispatch, making
  both cases the same path. It now warms the pool first. And dropping `CAPABILITIES.METRICS` from
  `optionalDependencies` failed **only the metadata assertion** and no functional test, because the
  shipped `MetricsPlugin` sits at priority 100 against this plugin's 500 and is ordered first
  regardless — so the plan's claim that the edge is what guarantees ordering was overstated and is
  corrected in the plan. The edge is load-bearing only for a REPLACEMENT provider at a higher
  priority number, which §3.4 explicitly permits, and a test now constructs exactly that case.

  **Code review then found the milestone's own instrumentation reintroducing X8-2 through a
  different door.** Instrument writes are throwing calls — `MetricBase.validateLabels` rejects an
  undeclared or incomplete label set, and `IMetricsService` is a replaceable capability — and every
  collector call was unguarded, with two of them placed BEFORE the task was settled. Probed: with
  only the completed counter refusing, the caller's promise **never settled** while `stats()`
  reported `completed: 1`, so a task the worker had finished successfully lost its result and hung
  its caller forever; with a wholly failing backend the throw escaped `emitReady`/`replyOk`, which
  in production is `Worker.onmessage` — an uncaught exception, i.e. the same process kill X8-2 was.
  A third consequence: a refusing gauge rejected the caller from inside `run()`'s own promise
  executor **while the task stayed queued and still executed**, telling the caller it had failed
  while the work happened. Fixed in two places — `WorkerPoolCollector` guards every write and
  reports through `ctx.logger` (read at CALL time, the M52b lesson; instrument CREATION stays
  unguarded so a name collision fails `register()` loudly), and `TaskPool` settles each task before
  observing it. **Both halves are independently proven, which took three controls**: reverting only
  the ordering PASSED, because the guard alone covers those cases — so the ordering was unproven
  until a case was added where the REPORTER itself throws (a broken logger transport is real), which
  strands the caller when reverted and passes when not. Review also shipped the ROADMAP metric table
  the plan's C1 row had promised and never delivered (the section still described five instruments
  while six shipped), corrected `RecordedMetric.observe` to honour counter semantics
  (`Counter.observe` delegates to `inc`, so a double that always assigned would hide precisely the
  double-count bug these tests exist to catch), and keyed `GAUGE_OPTIONS`/`COUNTER_OPTIONS` on their
  name unions so a wrong lookup is a compile error rather than an `undefined` that strips a metric's
  labels. Writing the coverage test for the reporter surfaced a fixture bug the type checker caught:
  `{ ...base }` on a class copies fields and DROPS every prototype method. All `src` files at 100%
  branch/function/line except `task-pool.ts` (98.8/100/100)) — complete (PR #170)
- **Milestone 70c** (`messaging-plugin` + `realtime-backplane-plugin` + `storage-plugin` +
  `mail-plugin` + `queue-plugin` + `service-discovery-plugin` + `grpc-plugin` — health signals that
  describe lifecycle, not reachability). Six packages answered `up` with their backends stopped and
  `/ready` stayed `200` (X2-1, X3-2, X8-5, X10-3), so a dead dependency triggered no restart, no
  alert, and no rolling-deploy gate. The seam is one optional member on the port —
  `isHealthy?(): Promise<boolean>` — never a new status type: `isReady()` keeps its lifecycle
  meaning, and each indicator reports both, so a reconnecting broker is `isReady() === true` and
  `isHealthy() === false`. Probes are cached and time-bounded through one pure helper in `common`
  (`createCachedProbe`), and each implementation's probe is decided from the probed client surface
  (§3.4): `client.ping()` for the Redis adapters, a connection-fault flag for RabbitMQ,
  `transport.verify?.()` for SMTP, a `head('')`-shaped bucket probe for S3, and `unknown` (not
  `false`) when an injected facade lacks the primitive. RabbitMQ gets an explicit
  `ReconnectSupervisor` in **drive** mode (amqplib has no reconnect of any kind) that re-asserts the
  exchange and replays every active subscription — which is why X2-1's queues showed no consumers
  after a broker restart and never recovered; redis-streams/nats/kafka run it in **observe** mode
  because their clients self-heal. X3-7: the health report projects (`{ status, data?, latencyMs }`)
  instead of spreading, so an indicator's undeclared fields and caller-supplied `latencyMs` never
  reach `/health`. X10-3: `ServiceDiscoveryService` gains `#everResolved`, so "never reached the
  backend" is a distinct, reportable `down`. X7-8: the gRPC health bridge maps `degraded` →
  `NOT_SERVING` so the two faces of one app agree. **The §3.7 bar — a real backend, stopped — is a
  deliverable, not a note**: five `outage-real.test.ts` suites (messaging, realtime-backplane,
  storage, mail, queue) drive a real broker/gateway through a real `docker stop`/`start` and assert
  `up → down → up`, guarded on `RABBITMQ_URL`/`REDIS_URL`/`S3_ENDPOINT_URL`/`SMTP_URL`, wired into
  CI's service containers (rabbitmq, minio, mailpit) and pinned by `test/apps-gate.test.ts`, and
  deliberately NOT in `ALLOW_SKIP` so a dropped service fails CI instead of skipping. Writing those
  suites surfaced defects no fake could: the S3 provider never set `forcePathStyle` (every request
  against a custom endpoint failed with 400/404), two ioredis `ping()` calls were unbound (the probe
  reported `false` forever against a healthy Redis), and `RabbitMqQueue` threw on `disconnect()`
  after a fault and crashed the host process on a reset during `createChannel()` (the connection
  fault listener was installed too late) — all fixed and regression-tested. — complete (PR #172)
- **Milestone 70d** (`cli` + `common` + `health-plugin` + `cqrs-plugin` + `events-plugin` +
  `di-plugin` — the no-argument registration seams, closing the register's "single most repeated
  defect"). A CLI-owned barrel builds an artifact with `new X()` and the contract hands it no
  context, so generated health indicators and command/query/event handlers could reach nothing, and
  every affected exercise invented the same module-level-holder workaround (D4, X2-2, E3, E5).
  `common` gains `RegistryFactory<T>` (`(services: IServiceRegistry) => T`) and one
  `resolveRegistryEntry` resolver; the factory arm lands on `CqrsPluginOptions.commandHandlers` /
  `queryHandlers` / **`behaviors`** (the third instance list, §3.11),
  `EventsPluginOptions.handlers`, and `HealthPluginOptions.indicators`, each resolving at `onInit` —
  the first phase at which the registry holds every capability. The four CLI schematics emit an
  exported factory and the seam barrels reference it with no `new`; a pre-existing generated
  artifact that exports no factory is skipped and reported (add that export, or delete the file and
  regenerate — renaming a class to the factory's name emits a class constructor where the option
  wants an instance or a function, so it does NOT compile). `DiPlugin({ autoRegister:
  true })` in
  the `class-based` template (E3), the `ServiceScope` docs corrected (E5), and `apps/cqrs` converted
  to the new arm. E3 is proven by a BOOTED probe rather than by the emitted string: the class-based
  `seam-probe` host injects `CAPABILITIES.CONFIG` into a generated `@Injectable` and resolves it
  through the container, and reverting to a bare `DiPlugin()` fails it with
  `No provider registered
  for DI token 'config'` — the register's own E3 signature. **Breaking for
  already-published generated output** — the generated barrel no longer constructs with `new X()`,
  so a pre-existing artifact stops registering until the two-line factory export is added. All `src`
  files ≥90% branch/function/line) — complete (PR #173)
- **Milestone 70e** (`sdk` + `grpc-plugin` + `telemetry-plugin` — the default branches of injectable
  seams, closing X11-1 and X7-3). Every one of the three packages offers a seam so tests can inject
  a fake, and because every test injects, the `?? <the real thing>` fallback was the one line no
  suite ran. **X11-1:** the SDK's default transport stored the bare global `fetch` and called it
  with the client as receiver, so a browser's first request died with
  `TypeError:
  Illegal invocation`; the default now resolves `globalThis.fetch` at call time with
  the global as receiver (an injected `fetch` still wins). **X7-3:** the grpc-plugin's
  Connect/Protobuf-ES specifiers reached `import()` through a constant map that JSR's static
  npm-compat rewrite cannot reach, so the published artifact shipped `npm:` verbatim and could not
  load on Node or Bun — the default importer now calls four literal `import('npm:…')` expressions,
  and telemetry-plugin's five instrumentation loaders default to zero-arg literal importers the same
  way. Telemetry instrumentation outcomes are reported through the plugin's logger (`debug` for an
  enabled instrumentation, `warn` for a failure carrying `kind` + `reason`); the plugin declares the
  logger capability in `optionalDependencies` so the kernel orders `LoggerPlugin` first and the
  standard configuration reports every outcome — pinned by a kernel-level e2e test with the real
  `LoggerPlugin` that fails without the edge. A recurrence gate (`scripts/npm-specifier-audit.ts`)
  refuses any computed `import()` specifier in `packages/*/src` unless it carries a
  `computed-specifier: <reason>` marker, and runs on every suite run and as `release:verify`
  check 6) — complete (PR #174)
- **Milestone 70f** (`storage-plugin` + `kernel` + `exceptions` + `multi-tenancy-plugin` +
  `session-plugin` + `grpc-plugin` + `logger-plugin` + `notification-plugin` + `events-plugin` +
  `cli` + `common` + `testing` + `auth-plugin` + `http-security-plugin` + `feature-flags-plugin` +
  `starters` — error format and error visibility). One application answers in one shape, and every
  error it swallows becomes visible to an operator. `common` carries a request-scoped **error
  responder** seam (`ERROR_RESPONDER_STATE_KEY`, `IErrorResponder`, `ErrorResponseInit`,
  `respondWithError`) so a package that may not import `@setu-ts/exceptions` (AI_GUIDELINES §2.2)
  still answers in the configured format: `errorHandler` publishes the responder once at factory
  time, and all seven kernel terminals plus every first-party short-circuit site (upload ×6, tenant,
  session ×2, auth ×9, http-security ×3, the flag guard) route through it — each keeping its status,
  title, and disclosure **verbatim** under `'default'`, `'rfc9457'`, and a custom formatter (X9-6,
  X4-8/C3). The upload middleware moves `await next()` out of its `try` so a downstream failure is
  no longer reported as a malformed body (X8-1); the kernel's fallback 500 now logs the unhandled
  error with `serializeError` + request id/method/path while the body stays opaque (X11-2); a gRPC
  handler throw is logged at call time and rethrown, leaving the masked wire response unchanged
  (X7-5), with `GrpcPluginOptions.interceptors` threaded into
  `createConnectRouter({ interceptors })` (the `connect-loader` dropped-argument fix); a raw `Error`
  in log metadata is normalized before redaction in `ConsoleLogger` and pino, and `serializeError`
  closes the class for any call site (X2-5); a notification `AggregateError` names its channel and
  `INotifier.sendSettled?` reports per-channel results without throwing (X8-12); and the
  CLI/rest-starter default pairs `ValidationPlugin({ errorFormat: 'rfc9457' })` with the handler's
  format so a validation failure and a thrown error answer in the same shape (C3). The
  no-`errorHandler` fallback converges `{ error, message }` → `{ error, detail? }` (CHANGELOG
  migration note). All `src` files ≥90% branch/function/line) — complete (PR #176)
- **Milestone 70g** (`kernel` + `cli` — routing collisions; docs in `react-router-plugin` and
  `static-plugin`, and the end-to-end gate in `apps/full-stack`. Developed in an isolated worktree
  off `main`, in parallel with M70f, which it does not depend on). Four register rows with one
  shape: two claimants for one name, resolved by an accident of ordering and reported by a
  diagnostic naming the wrong party. **X5-1/F1:** the kernel's tie-break ranked candidates by
  static-segment count, and `parsePattern` classified `*` as a STATIC segment — so `GET /*` tied
  with `GET /openapi.json` and registration order alone decided. `ReactRouterPlugin` mounts its SSR
  catch-all at `PLUGIN_PRIORITY.NORMAL` (500) while `OpenApiPlugin` registers at `OPENAPI` (700)
  deliberately last, so **every full-stack application silently lost `/openapi.json` and `/docs`**
  to an SSR 404 page. `*` is now its own segment kind and the ranking is statics descending,
  wildcards ascending, registration index — which also corrects an inversion a probe found and the
  register had not recorded: `/a/*` counted TWO statics against `/a/:id`'s one and beat the param in
  **both** orders. The rule compares counts rather than positions, so `/a/*` loses to `/:x/b` on
  `/a/b`; that limit is in `Router.match`'s JSDoc, in `PUBLIC_API.md` and in a test, so a later move
  to per-segment ranking is deliberate rather than accidental. **X5-6/X4-4:** the duplicate-route
  refusal now names the FIRST claimant, reading the `owner` `RouteInfo` has carried since M68 —
  `Route 'GET /*' is already registered by plugin 'react-router'.` The kernel deliberately offers no
  ALTERNATIVE (the second half of X5-6's ask): it cannot know that `static-plugin`'s is a
  sub-prefix, so that goes in the plugin's own README and PUBLIC_API section instead. **X4-4/F2:**
  requiring a provenance marker in generated artifacts was **rejected** — no artifact the CLI has
  ever emitted carries one, so the requirement would un-wire every artifact in every existing
  project. Barrel membership is the ownership signal that needs no migration and reports exactly
  once, at the moment of claiming; and the precise detector for the case that breaks the boot is
  separate — a candidate whose symbol already appears in `setu.config.ts` is left OUT of the barrel,
  so the developer's own registration keeps working and nothing registers twice. **A1:** a static
  claim table, because `generate` may not boot the target project (M34b) and a zero-dependency CLI
  cannot import a plugin to ask it, kept honest by a root drift gate that reads every
  `ctx.health.register` site in the package sources and fails on a missing name, with each
  derived-name site listed explicitly so it cannot pass vacuously.

  **The package list was corrected from the ROADMAP's five** (`kernel`, `react-router-plugin`,
  `openapi-plugin`, `static-plugin`, `cli`) to `kernel` + `cli`, mirroring the M70b and M70h
  corrections: the fix the register itself prefers is in the KERNEL, and the two per-plugin
  alternatives are narrower restatements of one kernel rule, so none of the three plugins needs a
  `src` change. No package's `src/index.ts` changes either, pinned by a new kernel
  `barrel-exports.test.ts` (the M56 defect class). **The end-to-end gate is the request no gate ever
  made**: `apps/full-stack/smoke.ts` asked for `/products`, `/` and `/login` and never
  `/openapi.json`, which is precisely why this shipped — it now asserts both endpoints under their
  real content types, in the real composition, on every CI run.

  **Carries one change unrelated to routing, folded in at the maintainer's direction** (the M58
  `g controller` / M59 `detectRuntime` precedent, recorded rather than silent): the GCP Pub/Sub and
  Azure Service Bus emulator e2e suites could not pass under `deno task test` at all.
  `packages/messaging-plugin/deno.json` scoped `test.permissions.net` to Redis and RabbitMQ only,
  and a CLI `--allow-net` REPLACES that block rather than unioning with it (the M53 lesson), so with
  both emulators running and their env vars set the suites still failed — Service Bus with
  `getaddrinfo EPERM`, Pub/Sub with gRPC `14 UNAVAILABLE: Name resolution failed`.
  `docs/messaging-emulators.md` hid it by telling the reader to run each file with `--allow-all`,
  where it works. The allowlist gains the two emulator ports, and the doc gains three corrections
  each established by measurement: the Service Bus emulator's own AMQP port is **5672, which
  RabbitMQ already holds**, so it is published on 5673 and the port goes in the endpoint
  (`UseDevelopmentEmulator=true` accepts one — undocumented); the Pub/Sub emulator must be addressed
  as `127.0.0.1:8085` rather than `localhost:8085`, because `grpc-js` resolves a hostname through
  DNS and a `host:port` grant does not authorize that lookup, while an IP literal skips resolution —
  which is what keeps the grant endpoint-scoped instead of forcing the loopback-wide widening M53
  rejected; and the suite is **not repeatable** against a persistent emulator (a second consecutive
  run fails with `RequestTimeoutError`, contradicting the doc's "repeated runs never share state"),
  so the container is restarted between runs. Both suites now pass under the project's own
  permission model — 7 steps, verified in this worktree.) — complete (PR #175)
- **Milestone 70j** (`packages/database-plugin` — database adapter correctness) — complete (PR
  #177). Six register rows with one shape: an adapter reporting success while doing something other
  than what its contract says. **X12-2** `IDatabaseService.query()` could not work at all on the
  Drizzle adapter, which called `execute({ sql, params })` — a shape no Drizzle driver accepts,
  failing with the internal `TypeError: query.getSQL is not a function`. The fix is a **binder**,
  not a call-shape swap: Prisma (`$queryRawUnsafe(sql, ...params)`) and D1
  (`prepare(sql).bind(...)`) both forward the statement **verbatim** and bind natively, so that is
  the contract, and passing the bare string — which the driver DOES accept, probed — would silently
  drop `params`, which is worse than the current failure. A pure internal scanner splits the
  statement at its placeholders, skipping string literals, quoted identifiers, `--` and nested
  `/* */` comments and PostgreSQL `$tag$` bodies so a `?` inside `'text?'` is never one, and
  interleaves `sql.param(value)`. Measured against the real generator on three dialects: Drizzle
  numbers `Param` chunks in encounter order and renders them dialect-natively, so an
  ascending-placeholder statement round-trips **byte-identically**. Any disagreement between
  statement and parameter list — wrong count, a gap in the `$N` sequence, both styles at once — is
  refused before the driver is reached, because a mis-bound parameter is silent.

  **One boundary was measured rather than assumed, and the measurement reversed the obvious move.**
  A `sqlite-proxy` instance has no `execute` but does have `all()`, which looked like a free lift of
  the documented "only `query()` rejects" limitation. It is not: `all()` on a raw statement returns
  **positional** rows (`[["a", 1]]`), because the proxy protocol returns array rows and Drizzle has
  no field map for a statement it did not build, while `query<T>(): Promise<T[]>` promises objects —
  as Prisma and D1 return. Routing through `all()` would have traded a loud failure for a silent
  shape divergence, the exact defect class this milestone closes. The refusal stays, and README +
  `PUBLIC_API.md` now state the reason so it is not re-opened as an oversight.

  **X12-5** the default Memory adapter is closed for the two divergences the register calls worth
  fixing and DOCUMENTED for the two it does not. An unknown `select`/`orderBy` field is refused by
  name against the entity's **observed** column set — the union of keys over the rows the store
  holds — while `where`/`filter` are deliberately left alone: with no schema this adapter cannot
  distinguish an unknown column from one absent on every row, and matching nothing is a defensible
  answer, whereas ordering by a column no row has returns rows arbitrarily and projecting one
  silently changes the response shape. An entity holding **no rows** skips the check entirely (there
  is nothing to observe and nothing to return). Uniqueness and column types get a stated guarantee
  table instead, since no schema-less store can enforce them. **X4-9** needed no new code path:
  `createDrizzleDataSourceInner` already refuses an `id`-less table by name, so the fix is deleting
  the eager check from `connect()` — the registry was enforcing the REPOSITORY's precondition on
  tables only the typed query builder reads, which made it all-or-nothing.

  **D7** makes each built-in arm name what its adapter cannot run without, the guarantee the
  `'custom'` arm has had since M52c. **Prisma is included with Drizzle**, because M66 made
  `prismaClient` required at runtime and it is the identical defect — and that is what turned six
  stale doc sites from silent lies into checked ones (**X12-4**), since
  `DatabasePlugin({ type: 'prisma' })` and `options: { url }` appear in the root README,
  `PUBLIC_API.md`, `ROADMAP.md`, a starter README and `AI_GUIDELINES.md` §12.2 while the adapter has
  thrown on all of them since M66; the published Prisma snippet was also the **v6** constructor,
  which does not compile against a real v7 client, so the three undocumented prerequisites (driver
  adapter, `prisma.config.ts`, the adapter's `schema` option) are now a named setup section.
  `packages/starters` needed no `src` change — `RestStarterOptions.database` is a pass-through
  `DatabasePluginOptions` — and `BuiltInDatabaseOptions` keeps its published name as the union of
  the three new arms, so an existing annotation carrying a memory configuration still compiles.
  **X12-6** `transactionTimeout` is documented in both the README options table and `PUBLIC_API.md`.

  **Two defects outside the register.** One was found by reading the source: with `logQueries: true`
  the service's logging wrapper declared `count(where)` and called `ds.count(where)`, dropping the
  `filter` argument `IDataSource.count(where, filter?)` defines — so `repo.count({ filter })`
  answered a different number with logging on than off, and every existing test built the service
  without logging. The other was **introduced by this milestone and caught by its own test**: the
  new column refusal threw SYNCHRONOUSLY from a method typed `Promise<…>`, bypassing any caller
  using `.catch()` — the M52b/M52c class — so the check now returns its error and the adapter
  rejects with it. The X12-2 negative control reproduced the register's message verbatim across five
  tests, and the `count`-filter control failed both new steps.
- **Milestone 70k** (`storage-plugin` + `queue-plugin` + `worker-pool-plugin` + `common` +
  `runtime` + `cli` + `cloudflare-plugin` — storage, queue and worker operability). Eight X8 rows
  with one shape: the capability does the work and then cannot tell an operator what it did. **The
  package list is corrected from the ROADMAP's three** (the M70b/M70g/M70h precedent): `common`,
  `runtime` and `cli` are needed by rows the row itself assigns, and `cloudflare-plugin` joined at
  implementation time because `R2Storage` is the other in-repo `IStorage` implementor.

  **X8-7 is the one the ROADMAP deferred here from M45b, and its design was decided by probing four
  runtimes rather than by reading docs.** A worker that ends its own thread raises no error, so the
  task timeout was the ONLY thing that ever settled its task — and `taskTimeoutMs: 0`, a documented
  and reasonable choice for long CPU-bound work, removed it, wedging a `size: 1` pool forever.
  Measured: **Node** reports `'exit'` (also under Deno's `node:` compat layer); **Bun** reports its
  non-standard `'close'` — and `self.close` is `undefined` there, so an earlier probe that appeared
  to show a Bun self-close was actually an uncaught `TypeError`; **Deno emits NOTHING** — not
  `close`, `exit`, `error` or `messageerror` — and a later `postMessage` still resolves, so a
  self-terminated Deno worker is undetectable. Hence optional `IWorkerHandle.onExit?` plus
  `IWorkerHost.reportsExit?`, **omitted rather than shipped as a silent no-op** on Deno (the M70h
  `onSignal` precedent): absence means "this runtime cannot tell me a worker died", never "no worker
  has died". `TaskPool` settles with a new `WorkerExitError`, the health payload carries
  `exitDetection`, and `register()` warns once on the undetectable pairing — a warning rather than a
  throw, because refusing `0` would remove a released capability to fix an observability gap. **Deno
  CAN spawn through `node:worker_threads`** (probed, including a `.ts` module, with both channels
  present so `resolveTaskPort`'s web-first preference still holds), which would give it real
  detection; that is recorded in the plan as an evidenced option rather than taken, since it changes
  the primary runtime's worker implementation wholesale.

  **Two of the plan's own claims did not survive their negative controls, and both are corrected in
  the plan rather than left standing.** The `terminating` guard was planned as load-bearing against
  a live defect; removing it changes NO observable behaviour today, because `shutdown()` drains
  `pending` before it terminates anything and `onTimeout` nulls the slot's task first. What it
  actually buys is a LOCAL invariant instead of one spread across two other methods — probed, with
  the guard gone AND `shutdown()`'s drain moved after its `terminate()` calls, two queued tasks
  reject with `WorkerExitError` instead of the shutdown error. And X8-11's fix is NOT the
  discriminated union the register names: discriminating alone still reported `bucket` and `region`
  as `not assignable to type 'never'`, because the compiler keeps every arm's `options` type as a
  candidate for the nested literal once the direct match fails. Removing the memory arm's
  `Record<string, never>` is what yields exactly one error naming the offending key.

  **X8-3's suggested fix was partly unimplementable and is stated rather than faked.**
  `mapWebRequestToFrameworkRequest` calls `arrayBuffer()` on every request and `IRequest` exposes no
  body stream, so no middleware in this package can decline to read. What IS in its hands was
  inverted: `Math.max(maxSize * 2, 50 MB)` under a comment reading "cap at 50 MB" made 50 MB a
  FLOOR, so a 100 MB per-file limit raised the bound to 200 MB. It is now a real `Math.min` cap with
  an explicit `maxBodyBytes`, both size refusals answer **413**, and the README and `PUBLIC_API.md`
  say the bound covers parsing and not the read.

  **X8-4** ships three surfaces answering three different questions: `ProcessOptions.onFailed`
  (once, on the final attempt, before the dead-letter, guarded so a throwing callback cannot lose
  the job), `queue_jobs_total{name,outcome}` behind an OPTIONAL `CAPABILITIES.METRICS` (the M45b
  shape), and per-name `{ ready, processing, dead }` depths in the health payload — the durable view
  a per-process counter cannot give after a restart, implemented where the count is one cheap call
  and **omitted, never zeroed**, on RabbitMQ and SQS. Proven through a REAL kernel application with
  the real `MetricsPlugin` and `HealthPlugin`, not a recording double.

  **X8-9 became a startup failure rather than the documentation the register settled for**, because
  M70h landed the `setu add` the register said would be the right home: `LocalStorageProvider`
  proves its root writable at `connect()` and names `--allow-write` on Deno, its health probe stops
  reporting `up` for a root it can only READ, and `setu add storage` prints the note. The flag is
  NOT added to `denoPermissions` automatically — only the `local` provider needs it, and granting
  filesystem write to every project installing an S3-backed capability would trade a security
  regression for an ergonomics one.

  **X8-8's recurrence gate found two more doc defects than the row named.** The doc-fence gate
  covered ten `docs/` guides and no package README, which is why the storage Uploads example shipped
  broken three ways at once; extending it to the three READMEs this milestone rewrote immediately
  failed on the queue README's `queues: { default: 'tasks' }` — an option that does not exist — and
  its options table listed `region` and `queues`, neither of which is in `QueuePluginOptions`. The
  gate reproduces X8-8's exact compiler error (`Did you mean to write 'maxFiles'?`) when the defect
  is reintroduced.

  Contract-violating doubles were the recurring obstacle, as ever: the GCS fake spoke a two-argument
  `save` the real SDK does not have, the local-fs fake reported ENOENT for every directory, the
  worker fake materialized `onExit` as `undefined` on a handle that must OMIT it (fixed with a
  `declare` field), and `Object.create` could not stand in for a client missing a command because
  the fake's methods read private fields. Four negative controls were each observed failing and
  reverted; a fifth PASSED and is what produced the `terminating` correction above.

  **Verification and code review then found five defects that all four gates, both publish gates and
  the per-file bar had passed, and the two worst were introduced by this milestone.** (1) The X8-7
  exit handler double-disposed a crash: Node emits `'error'` and THEN `'exit'` for a worker that
  dies from an uncaught exception — a task module that throws at import, the commonest worker
  failure — and Bun's `'close'` follows its error the same way, so the handler re-ran the
  startup-failure branch `onWorkerError` had just run and ONE crashing worker rejected TWO queued
  tasks: the one it was starting for, and a bystander never dispatched anywhere, whose rejection
  named an exit code and so pointed at the wrong cause. Every pre-existing exit test emitted an exit
  in ISOLATION, which no runtime does after an error. `dropSlot` now reports whether the pool still
  owned the slot. (2) `deadLetterTtlMs` armed its `EXPIRE` on `queue:<name>:jobs` — the hash holding
  the payload of EVERY job for that name, not only dead ones. Measured against a real Redis 7: a
  key's TTL SURVIVES later `HSET`s, so every job enqueued after the first dead-letter inherited the
  countdown, and `reserve` moves a job whose payload is missing into the processing set and returns
  nothing — silent, permanent loss of queued work, caused by an option whose purpose is bounding
  DEAD payloads. The payload is now MOVED into `queue:<name>:dead:jobs` and only that key and the
  dead set are expired; the test that shipped asserted the defect by name ("TTL to BOTH the dead set
  and the jobs hash"). (3) The X8-9 write probe used a FIXED filename, so two replicas sharing one
  root — a ReadWriteMany volume, the ordinary deployment for this provider — raced, and whichever
  `rm` ran second failed with ENOENT and refused to boot a process whose root was perfectly
  writable; the name is now unique per connect and cleanup is best-effort, since the WRITE is what
  proves writability. (4) Depths were collected BEFORE the reachability check, so an outage cost one
  failing round trip per registered name on every probe interval, each one logged, saying nothing
  `reachable: false` did not. (5) `IAwsS3Client` was REMOVED rather than deprecated, though the
  replacement is an identical working shape — §9.2, the M14d precedent — so it is restored as a
  deprecated alias. Four plan claims were also corrected against the code rather than left stale:
  the depth member is `depths?`/`processing`, not the planned `stats?`/`delayed`; it does NOT ride
  `createCachedProbe` (that helper caches a `Promise<boolean>`, a different key and return type);
  `queue_jobs_in_flight` was planned and deliberately not shipped (the durable `processing` depth
  answers the same question cluster-wide); and the plan's type-level `runtime-contracts.test.ts`
  deliverable was unwritten — now four cases beside M55's `readStream` precedent. The storage
  barrel's type exports were pinned at compile time for the same reason M56 gives: dropping one left
  every runtime assertion in that file green — complete (PR #178)
- **Milestone 70i** (`packages/grpc-plugin` + `packages/graphql-plugin` +
  `packages/websocket-plugin` — gRPC and GraphQL viability. The ROADMAP deferred an explicit
  **repair-versus-withdraw** decision for `grpc-plugin` to this milestone; the answer is **REPAIR,
  with the native-gRPC claim withdrawn**. Measured evidence: 12 of 15 reference-client checks
  already passed — Connect and gRPC-Web, on both HTTP/1.1 and HTTP/2, for all three RPC kinds — and
  exactly one wire format failed. That failure is **architectural, not a bug**: native gRPC signals
  completion in HTTP/2 **trailers**, the fetch `Response` has no trailer mechanism, and M23
  deliberately moved the framework onto Hono's `fetch` entry, so "run it on Node or Bun" is not a
  remedy even now that M70e made the package load there. Withdrawing the package outright would have
  deleted working capability; a trailer-capable serve path is a `packages/runtime` change and a
  reversal of M23, so it is named as unowned rather than deferred to a letter. **X7-2:** `basePath`
  now defaults to the **root**, from one `DEFAULT_BASE_PATH` constant replacing two spellings of
  `'/grpc'`. A gRPC path comes from the fully-qualified method name alone and no native client —
  grpcurl, grpcui, `grpc-go`, `grpc-java` — has a prefix option, so the old default made the
  reflection service the README advertises "for grpcurl, grpcui" unreachable by both tools it names.
  Root mounting is safe for two independent reasons already in source: `dispatchRequest` falls
  through on a root miss rather than 404-ing, and post-M70a `claims()` at root reports only
  registered procedure paths, so the kernel consults it before route matching without shadowing an
  ordinary route. **X7-4:** a native `application/grpc` request is refused with a **Trailers-Only
  `UNIMPLEMENTED`** (`grpc-status: 12`) before the handler runs — the protocol's own way to report a
  status without trailers, since it lives in the header block, which is exactly what a `Response`
  can carry. Detection is **exact-match**, and that is the milestone's sharpest trap:
  `'application/grpc-web+proto'.startsWith('application/grpc')` is `true`, so a prefix test would
  have refused gRPC-Web — the format that carries its trailers in the body and is the standard
  browser answer — and a negative control pins it. The README's "the plugin correctly forwards
  `Response.trailers` when available" was **deleted**: `grep -rni trailer` over the plugin and
  runtime sources returns nothing, and `Response.trailers` is in no runtime's fetch implementation.
  **X7-1 / X6-2:** both packages' only documented registration APIs did not work. gRPC's README and
  `PUBLIC_API.md` resolved `CAPABILITIES.GRPC` before `app.start()`, and plugins register during
  `start()`, so the documented sequence was a hard startup crash; GraphQL's README and
  `PUBLIC_API.md` used `new Application()` / `app.use()`, and `@setu-ts/kernel` exports one value,
  `createApplication`. Both corrected, plus a one-sentence `createApplication` note in
  `PUBLIC_API.md` — the cheap generalization, since X7-1 and X6-5 are the same mistake in two
  packages and fixing only the READMEs guarantees a third. **X6-3 is where the plan did not survive
  contact.** It named two widenings — optional `toAST`, `parse` source to `unknown` — and measured
  against real `graphql@16.14.2` under `strict` + `exactOptionalPropertyTypes` the facades diverged
  in about **fifteen** members (`Maybe<T>` getters, `ReadonlyArray` plurals, a string-union
  `locations` rather than `number[]`, nullable `variableValues`), so the two named widenings were
  necessary and nowhere near sufficient. The committed **static** type fixture is what makes this
  stick: the package's five existing real-`graphql` tests all use a dynamic `import()` inside a test
  body, so `deno check` never compared the two type worlds, which is precisely why it shipped.
  **X6-4:** `FieldResolver` is generic with `unknown` defaults (existing all-`unknown` resolvers
  stay assignable) and `DefaultGraphqlContext` is typed against `common`, so a resolver no longer
  needs hand-written casts in a codebase whose guidelines forbid `any`. **X6-6:** `requestContext`
  is deliberately **not** synthesized over WebSocket. The register's stronger suggestion would hand
  resolvers a context that is dead by the time they run — M46 records the runtime closing the native
  request once the handshake response returns — so it is typed optional and absent over WS, with
  `connection.headers`/`.query` documented as where the upgrade request's data lives; the
  `Record<string, unknown>` escape that had let an undeclared `connection` member exist is gone.
  **X6-7:** APQ refusals now follow the documented media-type watershed from one owner, answering
  `200` under `application/json` — `PUBLIC_API.md` states the rule as "exactly three" exceptions and
  APQ was a fourth, while the rule's own rationale describes the APQ miss exactly, since
  `PersistedQueryNotFound` is the one error a client must read and retry. **X6-5:** the websocket
  README leads with the plugin-based form and names `setu generate plugin`; the `ws-route` schematic
  was declined with reason, so `cli` was dropped from the package list while `websocket-plugin` was
  added — the M70b/M70h list-correction precedent. The recurrence gate is two layers, because one
  alone would be wrong: the two owned READMEs were folded into M70k's
  `test/package-readme-fence-compiler.test.ts` rather than shipping the second gate this plan
  specified — §11.1, and M70k's own header warns against a second classifier. The fold was strictly
  stronger, not merely tidier: M70i's gate pinned 1 compilable fence in the gRPC README and 3 in
  GraphQL where the shared engine finds **2 and 6**, and **four** fences it never reached did not
  compile — including the `## Options` fence for the very plugin this milestone repairs. `docs-gate`
  rejects the nonexistent kernel API repo-wide — scoped to package READMEs and `PUBLIC_API.md`
  rather than a naive grep, since `docs/migration-{fastify,nestjs}.md` legitimately show `app.use(`
  as foreign-framework code the reader is migrating from. Also recorded: the ROADMAP's claim that
  X6-4 is a `common` widening did not survive source-checking — both types are plugin-local — so
  alpha.9 carries one fewer breaking `common` change than stated. `DOC_LINT_BASELINE` 775 → 760) —
  complete (PR #180)
- **Milestone 70m** (`common` + `validation-plugin` + `openapi-plugin` + `sdk` +
  `http-security-plugin` — SDK and OpenAPI, closing X11-3 through X11-9. **The package list is
  corrected from the ROADMAP's three** (the M70b/M70g/M70h/M70k precedent): `common` carries the
  cross-plugin brand without which X11-5 is unimplementable at all under §2.2, and
  `http-security-plugin` is the package X11-3's own row assigns.

  **X11-5 is the headline, and it made the generated client useless for writes**: a route carrying
  `validateBody(schema)` contributed nothing to the document, so the generated client for the API's
  only write took **no argument** and 400'd against the live server — while the Zod schema was
  already on the route. Fixed the way M57 fixed the identical shape for auth guards: a
  `Symbol.for`-keyed `VALIDATION_METADATA` + `RouteValidationMetadata` +
  `withValidationMetadata`/`validationMetadataOf` in `common`, which is the entire channel, since
  neither plugin may import the other. `Symbol.for` deliberately — a locally-created symbol misses
  on every read when two copies of `common` share a process. **Both entry points brand**, and
  branding only `createValidationMiddleware` is not enough: the five `validateXxx` helpers return a
  closure that resolves the service at REQUEST time, so the function a route actually holds is the
  helper's — a negative control confirms that half alone fails both suites. Derivation is **ON by
  default**, unlike `deriveSecurity`, because `ZodToOpenApi.transform` never throws and there is
  nothing for a caller to name; `deriveRequestSchemas: false` reproduces the previous document
  exactly. A **declared** value wins per field, the first brand per target wins, the derived `400`
  carries a description and no schema (the body shape depends on the validation plugin's
  `errorFormat`, which this plugin cannot see), and a `cookies` brand derives **nothing** for two
  independent source-verified reasons: `RouteSchema` has no `cookies` field, and `@setu-ts/sdk`'s
  generator refuses an `in: 'cookie'` parameter outright, so emitting one would turn a working
  document into a codegen failure for its consumers.

  **X11-6:** dedup was asymmetric — the FIRST use of a reused schema was inlined and never
  rewritten, so one shape appeared both inline AND as a `$ref` to a meaningless `Schema1`, and
  nested schemas were never counted at all. Now a counting pass and an emit pass share one additive
  `SchemaNodeHook` on `ZodToOpenApi`; every internal recursion already went through
  `this.transform`, so one hook reaches every node. Stopping descent on a re-sighting is
  load-bearing rather than an optimization: without it a nested primitive was hoisted and stole its
  parent's component name (probed — `GetOrdersByIdResponse4042`), so a structural-shape filter
  rejects primitives as well. **X11-8:** an `operationId` no longer carries the path's braces
  (`get-orders-by-id`), and operational routes are excluded by **owner**, not by path, because those
  paths are configuration — `HealthPlugin({ endpoints })` and `MetricsPlugin({ endpoint })` both
  take one, so a static list silently stops excluding a renamed endpoint. The integration test
  therefore RENAMES them, and the control proves it discriminates: a path list leaks four `/_ops/*`
  operations while the default-path case still passes.

  **X11-4** was this repository's own M51 lesson pointed back at itself:
  `export function createApi(...)` had an inferred return type — a JSR slow type that blocks `.d.ts`
  generation — in a file whose own header says "Do not edit manually". It now emits a named `Api`
  interface, claimed from ONE `TypeNameRegistry` alongside the component, `*Args` and `*Error`
  names, so a document cannot collide with a generated one. **X11-7:** `HttpClientError` gained
  `<TBody = unknown>`, so the bare name keeps meaning exactly what it did and every existing
  `instanceof` is unaffected, while a generated client narrows through its own per-operation guard —
  the throw site cannot know which operation it is serving.

  **X11-9's fix is two deletions, and those deletions ARE the recurrence gate**: the SDK fixtures
  were listed in `deno.json`'s `fmt.exclude`, which is the only reason generated output failing
  `deno fmt --check` was invisible. Making them pass forced the emitter to be written against what
  `deno fmt` actually produces, verified by round-tripping the committed fixtures: one
  `renderSignature` shared by the interface pass and the factory pass (the M70h `renderList` lesson
  — derive the prefix from the name you already have, never guess a width); multi-line error bodies
  hoisted to named aliases, because fmt rewrites a multi-line intersection into a leading-`&` block;
  a single-arm union emitted with neither `|` nor parens (probed — fmt strips both); and a long path
  emitted as `[…].join('')`, because fmt rewraps a long template literal unpredictably.

  **X11-3:** the `http-security-plugin` README's own CORS example blocked every JSON request.
  `allowedHeaders` defaulted to `[]` while `methods` defaulted to every standard verb, so the
  preflight advertised POST/PUT/PATCH/DELETE and then refused `content-type` — the one header a JSON
  body needs. Omitted now ECHOES the preflight's `Access-Control-Request-Headers`, and
  `undefined ≠ []`, so an explicit `[]` still allows none. It does not widen the security boundary:
  the ORIGIN allowlist is what decides, it is unchanged, a caller reaching that branch has already
  been admitted while asking for a header it is already sending, and a denied origin echoes nothing.
  The `Vary: Access-Control-Request-Headers` append is mandatory rather than decorative — the answer
  now depends on a request header, so without it a shared cache serves one caller's preflight
  response to a caller asking for different headers; dropping it fails exactly that assertion while
  the echo assertion and all 38 other steps pass.

  Six negative controls were each observed failing and reverted. The first records an honest nuance:
  swapping `Symbol.for` for `Symbol()` fails only the cross-copy unit test, because both plugins
  share one `common` instance in-process, so the integration test would have passed either way —
  which is precisely why that unit test exists. **Verification and code review then found five more
  defects, and the first is the milestone's own headline claim being false in the case its other
  deliverable creates.** Generated output does NOT satisfy `deno fmt` in general — only for the two
  committed sample documents. A multi-line object type was emitted at whatever indentation its use
  site happened to sit at, so an INLINE (non-`$ref`) schema produced `body: {` followed by members
  at the wrong depth, and `deno fmt --check` rejected the file. Both existing fixtures name every
  schema through `$ref`, which is exactly why neither could show it — and X11-5 makes the broken
  case the COMMON one, since a derived schema used once is not hoisted into `components` and
  therefore arrives inline. Measured across all three positions that render a type: a request body,
  a parameter, and a success response. The response is the one that settles the fix, because the
  SAME rendered string is written at TWO indentation levels (the `Api` signature and the
  `client.request<…>` argument), so threading a depth cannot be correct for it. Everything
  multi-line is therefore hoisted into an exported alias — which `getErrorArms` already did for
  error bodies, under a comment naming X11-9, so the technique was right and applied to one of four
  sites. `hoistMultiline` now owns that rule for all four and emission is ONE block, since splitting
  it per source is what let three of them drift from the fourth. A third committed fixture generated
  from an inline-schema document puts the case under the repo's own `fmt:check` and `check` gates
  permanently, which the deleted `fmt.exclude` entries alone could not do — they cover whatever
  fixtures exist, and neither existing one had the shape.

  Also fixed: the plan mandated a `@ts-expect-error` control proving a generated guard narrows to a
  PRECISE body type and it was never written, so an over-wide emitted arm would have satisfied every
  runtime assertion in the file (the directive is self-validating — an unused one is a compile
  error). Two JSDoc blocks were left describing the WRONG function, because the milestone's own
  insertions stacked a new block on top of an existing one: `toPascalCase` and `#deriveSecurity`
  were undocumented while their prose sat above `isStructuralShape` and `#isExcluded`.
  `SchemaNodeHook` was pinned by NOTHING but the README exports-table drift check — removing it left
  the whole suite AND `deno check` green — so both changed barrels now carry compile-time assertions
  declared against the barrel rather than the concrete module. And three doc sites promised that
  `deriveRequestSchemas: false` "reproduces the previous document exactly", which is false and was
  measured so: owner exclusion, the `operationId` format and schema deduplication are all
  unconditional, so with the flag off `/health` is still dropped and the id is still
  `post-orders-by-id`. `PUBLIC_API.md`'s CORS section had not been touched at all — it still
  documented `Access-Control-Allow-Headers` as emitted "when configured", the precise inverse of the
  new default, and mentioned neither the echo nor the mandatory `Vary` — and the CHANGELOG recorded
  the two default changes under **Added** with no breaking marker, so the entry that silently
  removes `getHealth`/`getLive`/`getReady`/`getMetrics` from every regenerated client never said a
  call site would stop compiling.

  **The end-to-end loop the register describes also surfaced a defect in nobody's diff.** Driving a
  real app's own `/openapi.json` through the real generator and then performing the write through
  the generated client — 200, with the validated body round-tripping, where the register recorded a
  400 — required reading the validated body, and the documented way to do that does not work.
  `validateBody` stores under `validated:${target}`, while `packages/validation-plugin`'s README,
  its module JSDoc (what jsr.io renders as the package page), `ARCHITECTURE.md` and five
  `PUBLIC_API.md` examples all said `validatedBody`/`validatedQuery`/`validatedParams` — so a route
  following any of them received `undefined` and answered with an empty body, with validation itself
  working and nothing failing loudly. 11 sites corrected, the released key untouched; every test in
  the package already used the real key, which is precisely why no gate could see it.

  Two things are recorded rather than fixed. The plan's `exclude-owners.test.ts` was folded into
  `derive-request-schemas.test.ts`, with all three of its assertions intact. And an object-schema
  QUERY parameter emits source that does not compile (`TS2322` — `ClientRequest.query` accepts no
  object), which predates this milestone and is unchanged by it: the generator already refuses
  `in: 'cookie'` and a path/template mismatch by name, so refusing this one belongs with them, but
  it is not an X11 row and is left unowned rather than quietly widened into scope.

  Developed in an isolated worktree, in parallel with M70l) — complete (PR #181)
- **Milestone 70l** (`cli` + `scheduler-plugin` + `messaging-plugin` + `metrics-plugin` +
  `cloudflare-plugin` — deployment and operations: nine register rows that share one shape, **the
  framework is correct on one machine and stops being correct once containerised, scaled, or
  scraped**. No `common` contract change and no new token — the one `common` edit is a JSDoc
  correction to a released `IScheduler.resume` statement.

  **X10-1** `docker compose up` on the CLI's own generated stack crash-looped two of three services:
  `messaging-plugin` declared every subscriber queue `{ durable: false }` — named, non-durable,
  non-exclusive, the exact trio RabbitMQ 4 refuses (`541 … transient_nonexcl_queues`). The fix is
  **communicating intent the code already computed**: `subscribe` had computed `isExclusive` since
  M14 and used it only for delete-on-unsubscribe bookkeeping, never passing it to `assertQueue`. A
  caller-supplied queue name is a consumer GROUP → `{ durable: true }`; an absent one is private →
  `{ exclusive: true, autoDelete: true }`. The image pin was rejected as the register's own
  last-resort option. Two traps: the RPC reply inbox supplies a queue NAME (its per-instance
  address), so the naive "named ⇒ durable" rule would leak a durable reply queue per instance —
  hence a package-internal `REPLY_INBOX_TRANSIENT` symbol on an `InternalSubscribeOptions`, never a
  `rr.inbox.` name-prefix match, since `SubscribeOptions.queue` reserves no prefix and a legitimate
  group named `rr.inbox.orders` must stay durable; and `declareOptions` is carried on the active
  consumer so the drive-mode replay re-asserts the SAME shape, because RabbitMQ refuses a
  re-declaration that disagrees. **Breaking against an existing broker**: a group queue created
  non-durable cannot be re-declared durable (`406 PRECONDITION_FAILED` closes the channel), so
  CHANGELOG carries the drain-and-delete migration. `queue-plugin` was unaffected — it already
  declared `{ durable: true }`. **CI's RabbitMQ service moved 3.13 → 4 in both workflows, and that
  bump is the gate**: on 3.13 the defect is invisible and the new suite passes vacuously, so
  `test/apps-gate.test.ts` pins major version 4.

  **X10-2** a scheduled job ran once per replica and `distributedLock` did not stop it. Two
  decisions, and the second is what makes the first work. **Two locks, not one**: the register's
  preferred single slot-lock silently drops the overlap protection `MemoryLock`'s own module doc
  promises (slot N+1 is a different key from slot N, so it cannot see a running slot N), so the
  never-released slot lock is added ALONGSIDE the existing handler mutex. And **`every` arms on an
  absolute epoch grid** — `(floor(now / interval) + 1) * interval` — because without it replicas
  started 0.7 s apart compute `nextRunAtMs` values 0.7 s apart forever and slot keys never collide:
  slot-keying alone would have shipped a mechanism that LOOKS like a fix while reducing duplicates
  by ~77 %. Keying on the INTENDED time rather than `runtime.now()` makes the slot immune to timer
  jitter. Grid alignment is **breaking** (the phase moves; the fire may come sooner than one full
  interval, never later — including at `resume`, which is why the `common` JSDoc is corrected), and
  `#armInterval` had to be DELETED rather than kept, since arming for a full interval against a
  grid-aligned target would fire every job one interval late. `MemoryLock` now sweeps every expired
  entry on `acquire`: slot keys are never released and never reacquired, so the lazy per-key delete
  could never reclaim them and the map grew one entry per job per fire, forever. `delay` is the
  exception — its slot is claimed at REGISTRATION keyed `scheduler:job:<name>:once` (a fire-time key
  on `nextRunAtMs` carries startup skew and never collides; the `:once` suffix is load-bearing,
  since a bare-name key would collide with the handler mutex and always lose to its own claim). That
  carries a **documented limitation**: a `delay` whose claiming replica leaves between registration
  and fire is lost, because `disconnect()` clears timers without releasing the slot and the loser
  never re-contends — proved with a two-service probe returning `runs === []`, and recorded in
  `#claimDelaySlot`'s JSDoc and `PUBLIC_API.md` rather than left to discovery.

  **X9-2** `SchedulerPlugin.register()` now throws `SchedulerUnavailableError` on Workers, following
  `messaging-plugin`'s `cloud-gate.ts` precedent — viable only because M59 fixed `detectRuntime()`,
  which until then answered `'node'` on real workerd and would have made the check silently dead.
  **X9-5** the register's preferred fix (default the sink to `console`) is **unavailable**:
  `no-console` binds every package outside `cli` and `scripts`, and a repo-wide grep found no real
  `console.` call in any plugin source (all six matches are `@example` blocks). So the platform's
  own reporting is the sink that needs no configuration — `dispatch` runs every handler to
  settlement (one failure still never abandons the others) and then throws an `AggregateError`,
  which `createScheduledHandler` propagates so Cloudflare counts the invocation failed.
  **Breaking**: `dispatch` previously never rejected. **X9-8** only a SUCCESSFUL boot is memoised
  now (`??=` cached the rejection, so one transient failure was permanent for the isolate's life),
  and boot failure and request failure are reported separately — folding both into one catch logged
  "failed to start" for a fault unrelated to startup and answered 503, a drain signal, for a single
  bad request.

  **X10-4/5/6** are CLI-generated-output rows. `lifecycle.preStop.sleep` (K8s 1.30+) now mirrors the
  repository's own chart, which shipped it while the generated manifest did not — drift between two
  committed artifacts, and the register moved the symptom both ways on that field alone (7 → 0 → 10
  failures over ~28k requests). The Dockerfile's `chown -R` folds into the `deno cache` RUN: a
  standalone recursive chown rewrites metadata on every file, so overlayfs copied the whole module
  cache into a second layer (563 MB → 362 MB measured). Prometheus annotations are gated on a NEW
  `WorkspaceMember.metricsEndpoint`, recorded at `generate app` exactly as `healthProbes` is, with
  absent meaning "unknown" and emitting nothing — annotating a member that serves no `/metrics`
  would make Prometheus report a permanently-down target. It gets its own field rather than reusing
  `healthProbes` because the two can diverge. **X10-7** the HTTP collector skips its own scrape
  endpoint and the health probes BEFORE touching any instrument (so an excluded request cannot even
  perturb `http_active_requests`); the health paths are literals because §2.2 forbids importing
  `health-plugin`, and `excludePaths` REPLACES them while the plugin's own endpoint is always
  excluded. The low-cardinality `route` label the register also suggests was declined — the
  middleware never receives the matched pattern, and it would change every existing series'
  identity.

  Seven negative controls were each observed failing and reverted, including the real-backend one
  (reverting `{ durable: false }` fails the RabbitMQ 4 suite with the register's own channel close),
  and the one that matters most: reverting grid alignment while KEEPING the slot key fails the dedup
  test plus four grid tests, which is the difference between a fix and a mechanism that looks like
  one. **Not verified against a real cluster** — X10-4/5/6 are asserted at the level the repository
  can gate, the emitted text; the register's kind measurements are not re-run here. Developed on a
  branch cut before M70m, so `origin/main` was merged in and the gates re-run against the merged
  tree before hand-off) — complete (PR #182)
- **Milestone 70n** (`decorator-plugin` + `validation-plugin` + `common` + `kernel` + `testing` +
  `static-plugin` + `auth-plugin` + `session-plugin` + `audit-plugin` + `react-router-plugin` +
  `realtime-backplane-plugin` + `sse-plugin` + `starters` — decorators, validation, and the alpha.8
  closeout. `@ValidateBody(schema)` validated NOTHING — it only fed OpenAPI, because
  `composeMiddleware` reads guards/interceptors/middleware/filters and never `route.schema` (E1) —
  and `@Body()` re-read the raw request, discarding every transform, default and coercion the schema
  beside it had just applied (E2). The decorator surface the framework advertises as its
  NestJS-familiar path therefore could not validate a request at all. E1 resolves
  `CAPABILITIES.VALIDATION` once at `register()` and appends `service.middleware(schema, target)`
  per present target — the SAME implementation `validateBody(...)` reaches, so a decorated route and
  a middleware-configured route share one error format — **appended LAST**, so a guard's `401`/`403`
  still precedes any `400` rather than a schema's field paths leaking to an unauthorised caller.
  E2's key is promoted to `common` as `validatedStateKey`, because two packages must agree on it
  byte-for-byte and §2.2 forbids the import that would let one read the other's constant (the M47
  frame-codec precedent); presence is tested with `state.has`, so a schema validating to `null` or
  `0` is still honoured. `@Header`/`@Cookie` are deliberately EXCLUDED: `headers.get` is
  case-INSENSITIVE while the validated record is a plain object keyed by `headers.entries()`, so
  preferring it would make `@Header('Content-Type')` case-sensitive — trading a discarded transform
  for a silent regression.

  **The ROADMAP's row list did not survive source-checking, and correcting it was half the
  milestone.** It assigned twenty rows and called them "mechanical documentation": **C1 and X8-8
  were already closed** (M70m PR #181, M70k PR #178), and **ten of the remaining seventeen were code
  changes** across thirteen packages, three widening a committed `common` contract
  (`validatedStateKey`, `SseMessage.data` to the union its own encoder already handled, and a
  REQUIRED `IResponse.html`). Only six were genuinely doc-only. X2-6 (broker trace propagation) is
  **recommended for reassignment** rather than landed — closing it means W3C `traceparent` across
  all seven `messaging-plugin` brokers plus a telemetry seam that works off Node, which is a
  milestone with its own design. The "Scope realities" bullet's claim that X4-7 is a `common`
  widening was also struck: `StoredAuditEntry`/`AuditQuery` are declared in `audit-plugin`'s own
  `interfaces/index.ts` and merely absent from its barrel, so the fix is two type exports.

  **Four breaking changes**, each with CHANGELOG migration text: enforcement is on by default
  (`enforceSchemas: false` restores the old inert behaviour, and a startup warning names every route
  whose schemas are unenforced when no validation capability is registered); the session cookie is
  renamed `hono_session` → `setu_session` in a framework that is not Hono; `IResponse` gains a
  required `html(body)`; and the `static-plugin` `cacheControl` callback receives a leading-slash
  path. `X4-5` was the sharpest of the closeout rows — `SessionPlugin({ csrf: {} })`, the
  registration `PUBLIC_API.md` itself shows, `403`d every JSON mutation forever because `headerName`
  had no default, so the CSRF feature was inoperative in its own documented configuration.

  **Code review then found a defect that the four gates, both publish gates and the per-file bar had
  all passed, and it was in the milestone's own review fix.** `clientBuildRoot` — added to derive
  the client-build root for X5-5 — chopped the last path segment unconditionally, so
  `assetsDir: './assets'` derived `'.'` and the public-file handler served the **whole process
  working directory**: driven against the real handler and real filesystem, `GET /.env` returned the
  session secret. The `realPath` containment guard cannot catch it, which is the instructive part —
  the derived root legitimately CONTAINS those files, so containment holds while the root itself is
  wrong — and `publicFiles` defaults on, so nothing had to be opted into. It survived because the
  suite only ever passed well-formed values (`/client`, `/srv/app/build/client/assets`) and never a
  degenerate one. Re-reviewing that fix then found the same class INSIDE it: the first version
  refused `''` and `'.'` but let `'..'` through, a root ABOVE the cwd. Now any all-dot-segment
  parent is refused and the plugin names the offending `assetsDir` instead of serving silently. Also
  corrected: the `IMMUTABLE_PATTERN` over-match caveat (the class spans hyphens, so
  `report-2024-01-15.pdf` would be cached for a year — the doc was sharpened rather than the regex,
  since base64url hashes legitimately contain `-`), and a "ten brokers" count that is seven) —
  complete (PR #183)
- **Milestone 71** (`kernel` + `common` + state-key consumers — kernel and contract boundary
  hardening): the application registry seals after `runBootstrap()` while child registries remain
  request-mutable; startup overrides log at `info` and successful unregisters at `warn`; request
  `user` and `tenant` accept one implicit write with explicit replacement escapes; and every
  `ctx.state` key follows `<owner-package>:<kebab-key>` behind a recurrence gate — complete (PR
  #190).
- **Milestone 72** (`packages/cli` — standalone broker selection and interactive scaffolding):
  `--broker <name>` and `--queue <name>` on a standalone `setu new`, derived from the SAME
  `TRANSPORT_SPECS` registry the workspace `--transport` flag reads; the selected arm rewrites the
  template's `MessagingPlugin`/`QueuePlugin` wiring, adds its connection variable to the generated
  dotenv pair, and emits a broker-only `docker/compose.yaml` so the scaffold boots. Each flag is
  REFUSED — never silently ignored — wherever it would be a no-op: Cloudflare Workers (the swap has
  already removed both wirings), starter-composed templates, templates registering no matching
  wiring, unknown or arm-less names, workspaces and `generate app`. Prompting is an OPTIONAL
  `ask?: Prompter` on `CliDependencies` supplied by `src/main.ts` only behind
  `Deno.stdin.isTerminal()`, with a `--yes` escape hatch; prompts rewrite FLAG VALUES before the
  ordinary pipeline runs, so every prompted value is expressible as a flag and `--dry-run` stays
  exact. The workspace transport overlay was refactored to compose the same
  `withBrokerArgs`/`withQueueArgs` helpers, pinned byte-identical on a pre-captured
  `--transport rabbitmq` member. Two stale ROADMAP claims were corrected in the same PR: the bare
  grep evidence for "the CLI prompts nowhere" (an emitted-source hit) and "the broker is not
  selectable at all" (true of a standalone project only) — complete (PR #191)
- **Alpha release `v0.1.0-alpha.9`** — on `release/v0.1.0-alpha.9`, published 2026-08-26 (PR #192,
  tag at the merge commit `3d8c83a4`; CI published it, one green `Publish to JSR` job). **47
  packages** — the list is unchanged from alpha.8, so no package published for the first time and
  neither `release:create-packages` nor `release:link-repos` was needed. Scope was M70a–M70n, M45b,
  M71 and M72, plus the release-tooling fixes in #187–#189. Verified after publishing by querying
  all 47 on the registry (none yanked), then installing `kernel` + `runtime` from JSR into a
  throwaway dir and serving a request (`200 {"ok":true}`); `common` resolved transitively at
  alpha.9, which is the only real evidence the cross-package specifier bump landed inside the
  published tarballs. The GitHub Release object was created by the workflow rather than by hand —
  the first one the automation from PR #189 produced. **Two CHANGELOG defects were caught while
  cutting the release, both of which would otherwise have shipped**: the `Unreleased` section
  carried two `### Fixed` headings, and its X8-7 known limitation still stated that
  `@setu-ts/common` declares no worker exit signal, which **M70k had shipped** — the fix was
  recorded seven entries above it in the same section. A release spanning many milestones needs the
  whole `Unreleased` section read for internal contradictions, not just for per-milestone coverage.
- **Milestone 73** (`packages/common` + `packages/session-plugin` + `packages/auth-plugin` +
  `packages/kernel` + `packages/websocket-plugin` + `packages/sse-plugin` — realtime authentication.
  A browser can send exactly **one** credential over an `EventSource` request or a `WebSocket`
  constructor: a cookie. `JwtStrategy` and `ApiKeyStrategy` both read a header, and
  `AuthPluginOptions` had no hatch through which an application could supply its own — so the two
  transports a browser can actually use for realtime work could not authenticate a browser at all:
  an `EventSource` behind `requireAuth()` was `401`ed, and a socket connected as anonymous with its
  cookie session unreadable in the very callback the websocket README nominates for the job. Closes
  X3-5, whose documentation half M70n closed.

  **The cookie is read through a new required `ISessionService.fromHeaders(headers)`** returning a
  read-only `SessionView` and committing nothing — `load(ctx)` needs an `IRequestContext` that a
  strategy authenticating an upgrade never has. Both entry points delegate to one `#readCookieValue`
  and one `#restore`, so they cannot observe a differently-named cookie or disagree about expiry and
  revocation (the one-capability-one-implementation rule, driven under a non-default configuration).
  **Breaking for implementors** — a required member, CHANGELOG'd, though the framework's own service
  is the only one in-repo.

  **`SessionStrategy` maps the opened view through a caller-supplied `toPrincipal`** rather than
  reading a conventional key, so the plugin never guesses where an identity lives in a payload. It
  is internal and deliberately NOT barrel-exported, configured only through the new
  `AuthPluginOptions.session` arm, and yields `null` — continuing the chain — for an absent cookie,
  an unopenable envelope, an expired or revoked session, or a `toPrincipal` reporting no identity.
  `AuthPluginOptions.strategies` is the caller hatch, appended in declaration order, and the
  assembled order is fixed at **jwt → api-key → session → caller-supplied** with the first non-null
  principal winning, so a request carrying both a bearer header and a cookie authenticates by the
  JWT. A duplicate strategy name **throws**: a name is a strategy's only identity, and the later
  entry would be unreachable to anything reasoning about the chain by name. A `session` arm without
  `SessionPlugin` fails at `register()` naming both plugins rather than with a per-request `401` —
  `optionalDependencies: [CAPABILITIES.SESSION]` orders the session plugin first and
  `ctx.services.has` decides once.

  **The WebSocket bridge carries a principal, not a context.** `WebSocketConnectionContext.user?` is
  populated by threading `ctx.request.user` through an optional second parameter on
  `IWebSocketService.routeUpgrade`, so a single-parameter implementation stays assignable (pinned by
  a type-level test) and an absent principal is **omitted** rather than `undefined`, per
  `exactOptionalPropertyTypes`. **`sse-plugin` needed no source change** — the strategy is the whole
  fix, and the SSE half is asserted in `auth-plugin`'s integration suite, where that strategy lives.
  **Per-WebSocket-route authorization is deliberately absent**: those routes are registered on
  `IWebSocketService.route`, not the kernel router, so they carry no route middleware. The two
  documented answers are a global guard in the authentication band and a `1008` close from `onOpen`,
  both driven by the e2e.

  **The real-socket e2e needed a hand-written RFC 6455 client, and that is a runtime fact rather
  than a preference**: Deno's `WebSocket` takes only `(url, protocols)`, exposes no way to attach a
  `Cookie` header, and shares no cookie jar with `fetch` (verified — a `Set-Cookie` captured from a
  `fetch` login is not replayed on a subsequent connect). Scenario (a) therefore performs the
  handshake on a raw `Deno.connect` socket, checks `Sec-WebSocket-Accept` against
  `base64(SHA-1(key + GUID))`, and answers the server's keep-alive pings with pongs — without which
  Deno closes a fresh socket before it can read anything. The refusal case uses **`app.fetch`, never
  the global `fetch`**, because the fetch algorithm strips `Upgrade`/`Connection` as forbidden
  headers, so a global fetch arrives as a plain GET and a plain GET on that path is a `404`, not the
  `401` the test exists to assert. Note that the package's own `test.permissions` block declares
  `net: true` only, so this file runs under the root `deno task test` (which grants `--allow-env` on
  the CLI) and NOT under a package-scoped
  `deno test -P --config packages/websocket-plugin/deno.json` — `RuntimePlugin` reads the
  environment at `start()`.

  Doc corrections shipped alongside: the stale claims in `common` and `ARCHITECTURE.md` that an
  upgrade bypasses the middleware pipeline (pre-M70a behaviour), and a `PUBLIC_API.md` line still
  describing gRPC as using the deprecated `IHttpAdapter.setRpcHandler?` seam) — complete (PR #197)
- **Milestone 74** (`packages/common` + `packages/websocket-plugin` + `packages/sse-plugin` —
  realtime registry reads and the SSE contract. Two committed contracts could only be read by
  writing to them, and a third advertised a guarantee its own type did not hold. `room(name)` and
  `channel(name)` are get-or-create with no counterpart, so a presence endpoint reporting `size` for
  a request-supplied name **allocated** one registry entry per distinct name polled — the register
  measured `roomCount` 3 → 53 across 50 read-only requests, with nothing reclaiming them until an
  unrelated socket disconnected. `peek(name)` is the non-allocating read, added as a **required**
  member on `IWebSocketService` and `ISseService` (breaking for an out-of-repo implementor,
  CHANGELOG'd): optional was rejected because a `peek?` returning `undefined` cannot distinguish "no
  such room" from "this implementation does not offer the read", the exact ambiguity M70k had to
  invent `IWorkerHost.reportsExit?` to resolve, and every in-repo stand-in is built with
  `as unknown as` so a required member cost nothing to add. `RoomRegistry.peek` is deliberately a
  bare map read that never touches `#neverJoined` in either direction — adding to it would mark a
  live room abandoned, reclaiming from it would make a read dispose rooms.

  **`ISseService.channelCount` closes an asymmetry the first implementation pass surfaced and the
  maintainer then directed be fixed here** (§10.2 approval for all three additions and both breaking
  changes is recorded in the ROADMAP section): `IWebSocketService` publishes `roomCount` and its
  indicator reports `rooms`, while the SSE indicator reported `connections` alone — so the
  never-reclaimed growth this milestone documents had no operator-visible signal, and the SSE
  integration guard had to read the registry through `peek` itself for want of a count. The number
  **only rises for the life of a running application** (shutdown discards every channel), which is
  what makes it worth watching rather than merely reporting; the health payload gains a `channels`
  field, additive for consumers.

  **`SseMessage.data` narrows to a new `JsonValue` in `common` (breaking).** Its object arm admits
  `undefined`, decided by probing rather than by taste: the strict form rejects
  `{ note: string | undefined }`, which `JSON.stringify` serializes correctly by dropping the key,
  while the chosen form still refuses `bigint` in both object and array positions. The same probe
  removed a cost the ROADMAP had assumed — a named `interface` is **already** unassignable to the
  old `Record<string, unknown>` arm, so the narrowing imports no new interface-ergonomics
  regression. Blast radius measured rather than predicted: `deno task check` broke in exactly ONE
  place repo-wide, a test fixture declaring `extends Record<string, unknown>`, which is precisely
  the migration an application following the old docs performs, so the repository's own fixture now
  performs it as the worked example.

  **Four committed-doc conflicts, two of them beyond what the ROADMAP named.** `PUBLIC_API.md`
  called the member "any JSON-serializable value" while its printed union admitted `bigint` — the
  narrowing makes the sentence true rather than aspirational (C1); its claim that M70n's widening
  fixed named-interface assignment is false and was measured so (C2); and **both** the SSE README
  and `PUBLIC_API.md` stated a never-published channel "is reclaimed only when another connection
  closes", while `grep` for `delete` in `packages/sse-plugin/src` finds only `#members.delete` — so
  **nothing reclaims an SSE channel before shutdown** (C3), making that side strictly worse than the
  WebSocket one, which at least sweeps on disconnection. Adding reclamation was **declined with
  cause rather than deferred silently**: the `#neverJoined` design carries a latent trap where a
  caller holding a reclaimed reference publishes into a detached object while a new one serves the
  name, which would convert the documented "hold a channel reference at startup" pattern into silent
  partial delivery.

  Each integration guard ships beside a control reproducing the defect through the same entry point
  — 50 requests through `peek` leave the registry at its starting size while the identical endpoint
  written with `room()`/`channel()` grows it to 50 — so the guards discriminate rather than merely
  pass. A separate test pins the runtime divergence the type removes: a non-serializable payload is
  swallowed per-member by `publishLocal` with no backplane, and throws synchronously out of
  `publish` with one, because the backplane publisher builds its frame with `JSON.stringify(msg)`
  outside any `try`. Developed in an isolated worktree off `main`, in parallel with M73, which it
  does not depend on) — complete (PR #196)
- **Milestone 75** (`packages/common` + `packages/telemetry-plugin` + `packages/messaging-plugin` —
  broker trace propagation. **The ROADMAP's premise did not survive source-checking, and correcting
  it was half the milestone.** It said `MessageMetadata.headers` "is declared and no broker
  populates it, so `headers` is `{}` on every delivered message"; measured per broker, RabbitMQ and
  Kafka DID populate it, four omitted it entirely (so the delivered value was `undefined`, never
  `{}`), and NATS populated it with the wrong object. And the gap was **two independent breaks**,
  not one: no broker injected a `traceparent` on publish, AND `TelemetryService.withSpan` never
  called `context.with`, so a span created anywhere inside a request handler was a fresh root.
  Closing only the broker half yields a correctly-linked producer→consumer pair floating in its OWN
  trace, disconnected from the request that caused it — which is what every fake-backed test in the
  package passes in. `TracerHost` gains an optional `activate?`, `withSpan` uses it, and the plugin
  registers an `AsyncLocalStorageContextManager` behind a literal lazy `npm:` import; failure is one
  `warn` and a degrade, never a throw. `contextPropagation: false` restores the flat shape. **Span
  nesting is a behaviour change to exported trace shape** and is CHANGELOG'd as one.

  **Four external facts were established by probe rather than inferred, and two changed the
  design.** OTel's default global context manager is `NoopContextManager`, whose `context.with`
  propagates **nothing at all** — not even synchronously — so activation is inert until a manager is
  registered; `AsyncLocalStorageContextManager` works on Deno across `await` and does **not** need
  `enable()` (its store is built in the constructor), which is why the shipped code deliberately
  omits that call. A real `MsgHdrs` cast to a plain object yields `undefined` for every key and
  `Object.keys` of `['_code','_description','headers']` — its internals — which is the D2 defect.
  And Pub/Sub `attributes` (string values only) plus Service Bus `applicationProperties` exist on
  both directions, so all seven brokers can carry a header and no payload envelope is needed —
  enveloping was refused because plain pub/sub is the cross-service surface and a foreign consumer
  would break (the M14d wire change was acceptable only because RPC is framework-internal).

  The trace-context codec is **promoted** to `common` and `telemetry-plugin` deletes its copies, so
  this removes a definition rather than adding one (not the M30b `pemToDer` case). One
  `TracedBroker` decorator owns all span work, so the seven brokers get transport plumbing only and
  RPC traces for free through `RequestReplyDeps.publish`. `MessageMetadata.headers` stays
  **optional** — requiring it breaks out-of-repo implementors without making any of them populate it
  — but becomes a populated contract, with `{}` meaning "read the channel, it was empty" and
  `undefined` meaning "no channel". `src/index.ts` gains nothing in `messaging-plugin`; a
  `barrel-exports` test pins that.

  **Verification found the headline deliverables asserted almost nothing, and one pre-existing hole
  that had hidden a whole code path.** `header-conformance.test.ts` was named for all seven brokers
  and drove `InMemoryBroker` alone — it would have passed with the other six broken; it now runs one
  table over all seven, and six of the seven passed on the first real run. `messaging-telemetry`
  asserted the consumer's parent traceId was `toBeDefined()` rather than that it MATCHED, so a span
  parented into the wrong trace satisfied it; the fixture could not express the assertion at all
  (`RecordedSpan` carried no span context) and now does. The pre-existing hole:
  `FakeRedisStreamsClient` returned XREADGROUP entries **unnested**, where real Redis nests them
  under `[streamName, entries]`, so `RedisStreamsBroker`'s entire delivery path — deserialize,
  metadata, handler, ack — had **never run in tests**, while the two tests that looked like they
  covered it asserted only that `xreadgroup` had been CALLED (one is titled "READ-BACK: message
  round-trip"). The fake also discarded every stream field except `payload`, which is the channel
  the header rides. Both fixed, both weak tests given real assertions. `NatsOptions.logger` was dead
  surface — set by the plugin, read by nothing — and is now the sink for the dropped-header report
  (`KafkaOptions.logger` is still dead; noted, not fixed, since finding it a use is outside this
  milestone). `registerContextManager` returned `setGlobalContextManager(m) || true`, a tautology
  that made the return value dead and 100% coverage vacuous; it now reports a discriminated outcome
  distinguishing "I registered it" from "the host already had one" (both usable) from a named
  failure. Its registration call is guarded too — found because my own test title claimed "never
  throws" while asserting the opposite. NATS also had a dead `resolveClient` lazy branch duplicating
  the connect logic; there is one connect path now.

  **The proof is real OpenTelemetry, and both halves are independently controlled.**
  `trace-continuity-real.test.ts` drives the real API, SDK and context manager and asserts the
  finished spans' parent chain: `POST /orders` → `publish` → `receive`, one trace. Removing
  activation makes it 2 traces. But a second case was needed and is the more instructive one:
  in-memory delivery runs INSIDE the producer's active context, so the consumer inherits the trace
  ambiently and the header is **not** load-bearing there — writing the header under a wrong name
  still passed. The cross-process case captures what the producer put on the wire and delivers it
  into a second broker from a clean context, which is what a real hop does; that case fails the
  moment the header is wrong. Real RabbitMQ 4 and Redis 7 round-trips are committed and guarded, and
  the Redis one was shown to discriminate against a live server. Also fixed: my own insertion split
  `TelemetryPlugin` from its JSDoc so the block documented the new function instead (the M70m
  stacked-docblock defect), caught by the M38 ratchet — which the previous commit had left failing
  at 769 against a 752 baseline) — complete (PR #201)
- **Milestone 76** (`decorator-plugin` + `openapi-plugin` + `starters/rest-starter` + `cli` +
  `apps/di-decorators` + docs — TC39 standard decorators, retiring `experimentalDecorators`. Every
  shipped decorator was the LEGACY form, and Deno deprecates the option the whole surface rests on,
  warning on every `check` and `lint` run. Three facts decided the shape, each re-established by
  probe on Deno 2.9.5 rather than taken from the ROADMAP: standard decorators already run with
  `deno.json` = `{}` and no `compilerOptions` key at all; the framework used none of them; and a
  **parameter** decorator without the flag is a **parse** error, not a type error — so the option's
  removal would not degrade `@Body`/`@Query`/`@Param`/`@Header`/`@Cookie`/`@CurrentUser`/`@Ctx`/
  `createParameterDecorator`, it would make them unparseable. The maintainer chose **full migration
  with the legacy form deleted**, over a dual surface or a documented pin.

  **Two enabling facts the ROADMAP did not record, both found by probe, and the design turns on
  them.** `Symbol.metadata` works in Deno 2.9.5: `context.metadata` is live at decoration time and
  readable off the class BEFORE any instance exists — which matters because a standard method
  decorator never receives the constructor and `context.addInitializer` runs **per instance**, long
  after `DecoratorPlugin.register()` has read the store. And member decorators run before the class
  decorator and share its metadata object, so the class decorator (which DOES get the constructor)
  can transfer the accumulation into the existing constructor-keyed store — meaning `IMetadataStore`
  in `common` is satisfied unchanged: **no `common` widening and no new token**. Metadata is also
  NOT prototype-chained in this implementation (measured), which matches the legacy
  constructor-keyed `Map`, so inheritance behaviour does not change.

  **Parameter injection is replaced by positional `@Params(...)`**, with the existing names kept and
  their KIND changed from parameter decorator to source descriptor, so every stale call site is a
  compile error rather than a silent behaviour change. It is strictly stronger than what it
  replaces: the declaration is type-checked against the handler's own signature (a mismatched
  parameter is rejected by name), where the legacy parameter decorators checked nothing at all.
  `createParameterDecorator` becomes `Custom(name, metadata?)`. Constructor injection collapses onto
  the class-position `@Inject(...)` list — which already shipped, so §9.2's "working replacement" is
  code that existed rather than new surface — with `Optional(token)` wrapping an entry. The two
  reconciliation throws that guarded the competing forms have no reachable input any more and are
  deleted with the form that caused them, along with the now-readerless `mergeCtorParam` and
  `ctorInject` store methods (M59's precedent).

  **The rewrite is pinned against a baseline captured from the legacy implementation before it was
  deleted** — a 3,136-line rewrite whose output another package consumes cannot otherwise tell
  "correct" from "consistently wrong". Controllers, route order, every non-parameter field, custom
  decorators and the class-position service record are byte-identical. Two divergences are asserted
  explicitly rather than papered over: `params` are compared as an index-keyed SET, because legacy
  stored them descending (parameter decorators evaluate in reverse) while the positional form stores
  them ascending, and order is not load-bearing — established by reading both consumers, since
  `resolveParameters` places by `param.index` and `openapi-plugin` reads the Zod `schema.params`,
  never this array; and a parameter-position `@Inject` list moves from `ctorInject` into
  `services.inject`, so the test asserts the tokens survived rather than that the location did.

  **The first bridge silently lost a behaviour, and the baseline is what caught it.** Legacy
  recorded routes for a class carrying member decorators but NO class decorator; deferring writes
  until a class decorator ran dropped them, and the bridge's own docstring asserted the opposite.
  The store now drains on read via `Symbol.metadata`, which needs no cooperation from any class
  decorator, while class decorators still drain eagerly through `context.metadata` — necessary
  because the runtime installs that object on the constructor only AFTER every decorator has run.
  The accumulator moved to its own module so the graph stays acyclic (§11.3).

  **A cross-runtime trap that would have shipped green.** `Symbol.metadata` is **`undefined` on
  Node**, and the generated project's own runner (`tsx`) installs the metadata object under
  `Symbol.for('Symbol.metadata')` instead — measured by reading the class's own symbol keys. So the
  `?? Symbol.for(...)` fallback is **load-bearing on Node, not defensive**: collapsing it would
  leave every Node project unable to find any decorator metadata while the Deno suite stayed green.
  It is a named seam with both arms tested, and its JSDoc says so. Node also still needs `tsx` for a
  reason unrelated to the retired flag — V8 has not shipped decorators, so plain `node` and
  `--experimental-strip-types` answer a STANDARD decorator with
  `SyntaxError: Invalid or unexpected token` (re-measured on v24) — and four doc sites that
  attributed it to `experimentalDecorators` are corrected.

  **All eight declaration sites lose the option**, not the four the ROADMAP named: the three package
  manifests, `apps/di-decorators`, both CLI template stamps, the generated Node `tsconfig.json`, and
  `test/fixtures/snippets/deno.json` — the last found only because it gated every guide fence.
  `deno
  task lint` now runs the whole repo with no deprecation warning. Nothing is added back:
  declaring ANY compiler option replaces Deno's default set (M63 D3), so a template needing none
  declares none.

  **Verified past the gates by BOOTING**, per M58's lesson that a test asserting decorator PRESENCE
  covered a controller that answered 500 on every request for five releases: a scaffolded
  `class-based` project with a generated module type-checks against the workspace and serves —
  `/greetings/ada` proves positional `@Params` binding, the injected service proves the
  class-position `@Inject`, and the generated module answers **201** through `Ctx()`. A mechanical
  transform had also placed `@Inject` on five classes with no constructor at all, producing a
  self-injection; all five were found by scanning for the shape rather than by the one failure that
  surfaced. Also fixed two pre-existing defects found in passing: a garbled doc paragraph at the
  tsconfig emitter, and a **duplicate `### Changed` heading in the CHANGELOG's `Unreleased`
  section** — the exact defect the alpha.9 release caught once already) — complete (PR #200)
- **Next milestone** — **M40** (final polish and release).

## Verification (run before declaring any work done)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

All four must pass. A milestone also requires 90%+ coverage (`deno task test:coverage`).

**A milestone that changes what `packages/cli` GENERATES ALSO boots a scaffolded project — the gates
above type-check generated output and stop there.** M63 repaired four defects that every one of the
four gates, both publish gates, and the per-file coverage bar passed over, and three of them are
invisible to a type-checker by construction: a scaffolded project could not `deno install` at all
(no `minimumDependencyAge`, and `setu new` pins the CLI's own just-published version); a stock
`--template rest` project answered **500 on `/health`** because its generated `start` task never
requested `--allow-sys`; and a fresh scaffold failed `deno fmt --check` on 62 of 74 files the CLI
itself had just written. `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` is the gate — it formats,
lints, installs, type-checks and BOOTS each template, then requests the endpoints the project
advertises. Its boot deliberately does not use `-A`: a permission the generated task forgot to ask
for is unobservable under a blanket grant.

**A milestone that adds or changes a package ALSO runs the two publish gates — the four above cannot
see a publish-blocking defect.**

```bash
deno task publish:check              # deno publish --dry-run, on a COMMITTED tree
deno task release:verify <version>   # version agreement, specifier resolvability, workspace
                                     # coverage, no stub in the list, @module-first
```

M51 shipped three separate defects that every one of the four gates and the per-file coverage bar
passed over, each of which would have stopped the package reaching JSR:

- **A slow type.** `createDepthLimitRule` was exported from the barrel with an inferred return type.
  JSR rejects that because it blocks automatic `.d.ts` generation — and the CI comment is explicit
  that the generated `.d.ts` is what the Node and Bun compat jobs consume, so the dry run gates
  both. Every exported function needs a written-out return type; `deno check` does not care.
- **A package in neither release list.** `packages/graphql-plugin` was a workspace member absent
  from both `PUBLISHED_PACKAGES` and `UNPUBLISHED_PACKAGES`, so it would simply never have
  published. Only `release:verify` looks for this.
- **A README suppressed on jsr.io.** `src/index.ts` opened its module JSDoc with the description
  instead of `@module`, which makes JSR render that blurb as the whole package page instead of the
  README. The README still ships in the tarball, so nothing else can see the loss — `release:verify`
  check 5 exists precisely for it.

`publish:check` refuses a dirty tree (`--allow-dirty` is deliberately not passed), so run it AFTER
committing — a "failure" that turns out to be uncommitted changes is not a result. Note also that a
green `--dry-run` does NOT prove a real publish works: it skips the already-published check, which
is what needs `--allow-net` (see the `alpha.2` entry above).

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
- **Run the two publish gates on the committed tree.** `deno task publish:check` and
  `deno task release:verify <version>` — see the Verification section for the three M51 defects that
  every other gate passed over. A milestone whose package cannot publish is not done, and CI's
  `JSR publish dry-run` job will say so on the PR after you have handed it back.
- **Report the evidence.** When handing back, paste the ANSI-stripped per-file coverage table, the
  grep result, and the exit status of both publish gates. "Done" without that evidence is not done.
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
  staged, `git rm --cached` (or delete) it. **A completed milestone's plan is ARCHIVED, never
  deleted** — move it to `plans/archive/milestone-<N>-<desc>.md` in the same PR that flips the
  status, so `plans/` root holds only the plan being built. Deleting a plan is the maintainer's call
  and theirs alone: do not remove one unless asked, even when the milestone has shipped. (A previous
  revision of this file mandated `git rm` here, on the reasoning that a shipped plan is a fourth
  copy of what the code, tests, ROADMAP and CHANGELOG already say, and that
  `git log --diff-filter=D --name-only -- plans/` recovers it. That reasoning is superseded: an
  archived plan stays readable without an archaeology step.)

## Key conventions

- Plans: one committed plan per milestone (`plans/milestone-<N>-<desc>.md`), moved to
  `plans/archive/` on completion in the milestone's own PR — archived, never deleted; removal is the
  maintainer's call. All other prompts/notes are scratchpad only and never committed (see the
  plan-cleanup rule in "Before reporting a task done").
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
  already-merged `main`; `docs/[description]` is for a documentation-only change that is not a
  milestone's implementation work — opening a new ROADMAP milestone, correcting a committed doc,
  amending these conventions. Use `docs/…` rather than `feat/…` for those: a `feat/[milestone]-…`
  branch asserts that the milestone is being BUILT on it, so `feat/37c-…` carrying only a ROADMAP
  section is a lie about the branch's contents (M37c was opened this way, PR #124). A maintainer may
  approve `chore/[description]` for a cross-cutting repository concern that is neither a milestone,
  a defect in merged code, nor documentation-only work (for example, CI/release reproducibility
  across several packages). Record that approval and the scope in the PR; do not silently invent a
  `chore/…` branch type. A doc edit that belongs to a milestone still ships on that milestone's own
  `feat/…` branch — the status flip, the PUBLIC_API correction, and the plan archival are part of
  the milestone, not separate work. Commits: conventional format (`feat(scope): subject`); **no
  commit message may exceed 100 words** in total (AI_GUIDELINES §15.1) — the plan, the PR body, and
  the code comments are where the long reasoning goes; no direct commits to `main`.
- **Pushing and opening the PR are yours to do — but only when asked.** Remote credentials ARE
  available (`gh auth status` reports a logged-in account; SSH for git operations), so `git push`
  and `gh pr create` work. This bullet previously said the opposite — that no credentials existed
  and any attempt would fail and waste time — which was stale: PRs #123 and #124 were pushed and
  opened this way. Do not push or open a PR unprompted, though: finish the milestone, report the
  evidence, and wait for the human to ask. Publishing a branch is outward-facing and their call to
  time.
- **Automated review comments get one reply per thread, never a bundled summary.** CodeRabbit and
  the code-quality bot anchor findings to lines; answer in the thread
  (`gh api repos/<owner>/<repo>/pulls/<pr>/comments/<id>/replies -f body='…'`), stating fixed (with
  the commit), refuted (with the evidence), or deferred (with the owning milestone). Verify before
  agreeing — several such findings have been correct about the defect and wrong about the mechanism,
  and one was wholly refuted. **A finding whose entire subject is an ARCHIVED plan
  (`plans/archive/`) is DECLINED** — it is a design record, not a spec the code is checked against —
  unless the finding ALSO lands on the implementation, in which case the implementation half is
  fixed and the plan is left alone. A plan still at `plans/` root belongs to a milestone under
  construction and is corrected normally. AI_GUIDELINES §16.5 is canonical and binds every agent
  (Claude, ChatGPT/Codex, Roo).
- **Record the PR number in the same PR.** The CLAUDE.md "Current status" entry needs the number,
  which does not exist until the PR does, so the order is: commit the status entry as "complete (PR
  pending)" → push → `gh pr create` → edit the entry to the real number → commit and push again.
  That second commit lands on the same branch before merge, so the merged history never carries "PR
  pending". Same for the ROADMAP row and the plan archival — all of it ships in the milestone's own
  PR (see "Before reporting a task done").
