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
  `defineWorkerTask` ships as a new `@hono-enterprise/runtime/worker` subpath (its sole export);
  host↔worker envelope protocol (`WorkerReadySignal`/`WorkerTaskRequest`/`WorkerTaskReply` + three
  guards) lives in `common` so both runtime (worker side) and plugin (host side) read it without a
  plugin importing another plugin. Internal `TaskPool` (one per specifier, lazy; spawn-on-demand to
  size, idle reuse, bounded FIFO queue): handler-error → `WorkerTaskError` + worker retained; worker
  crash → drop + re-dispatch queued work; timeout → `WorkerTaskTimeoutError` + terminate & replace;
  queue overflow → `WorkerQueueFullError`. `worker-pool` health indicator (`{ available, pools }`) +
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
  the 11 explicit `jsr:@hono-enterprise/{common,kernel}@^0.1.0` specifiers bumped alongside, because
  a `^0.1.0` range does NOT match a prerelease and `deno publish` does not warn. **35 implemented
  packages publish; the 5 stubs (`cli`, `sdk`, three starters) do not** — `deno publish` from the
  workspace root would push all 40, so releases go through `scripts/publish-packages.ts`, which
  walks an explicit dependency-ordered allow-list in `scripts/release-packages.ts` one package at a
  time. `deno task release:verify <version>` guards the four things the gates cannot see (version
  agreement, specifier resolvability, full workspace coverage, no stub in the list). Added a
  `CHANGELOG.md`, a tag-triggered `.github/workflows/release.yml`, and the 23 missing package
  READMEs. **JSR versions are immutable** — yankable, never deletable or replaceable.
- **Alpha release `v0.1.0-alpha.2`** — on `release/v0.1.0-alpha.2`, published 2026-07-28. **36
  packages** (adds `cli`); only `sdk` and the three starters remain unpublished. The whole scope
  moves as ONE version because the CLI forces it: `honoe new` stamps generated projects with the
  CLI's OWN version as the range for `kernel`/`runtime`/`common`/every template plugin, so a CLI at
  `alpha.2` beside a framework at `alpha.1` would scaffold projects pinning versions that do not
  exist. Also fixed 44 relative links across 28 package READMEs — JSR resolves a README's relative
  links against `jsr.io/@hono-enterprise/`, so `../../PUBLIC_API.md` returned a 400
  `malformedRequest` on every package page; package READMEs must use absolute GitHub URLs. **This
  was the first release CI published.** `alpha.1` went out by hand because the workflow failed every
  time, in three distinct ways, none reproducible locally: (1) the publish step lacked
  `--allow-env`, because the workflow inlined its own `deno run` instead of calling the
  `release:publish` task and the copy drifted — it now calls the task; (2) it also lacked
  `--allow-net`, needed by the already-published check, which `--dry-run` SKIPS, so a green dry run
  proves nothing about a real run; (3) no package was linked to the GitHub repo, which tokenless
  OIDC requires and token publishing does not — hence `alpha.1` never hit it.
  `deno task
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
- **Milestone 34** (`packages/cli` — the `honoe` CLI: `new` project scaffolding and plugin-aware
  `generate` code generation. `runCli(argv, deps)` returns an exit code and never calls `Deno.exit`;
  `src/main.ts` is the sole process boundary (`Deno.args`, `Deno.cwd()`, `console`, the Deno
  filesystem, the one `Deno.exit`) and `CliDependencies` deliberately has NO default — a defaulted
  `fs` is exactly what let the first draft ship a CLI that printed "Created README.md" while writing
  nothing. Zero-dependency `parseArgs` supporting `--key=value` AND `--key value` for the declared
  value flags (`--dir`, `--runtime`); one `deriveNames` producing five casings that all 13
  schematics share; schematics are PURE `(names, options) => GeneratedFile[]` so `--dry-run` is
  exact and the overwrite check ("check every planned path, then write") lives in one place.
  Registry is a `Map`, not an object literal, so `honoe g constructor x` misses cleanly instead of
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
    `experimentalDecorators`. Doc deliverables C1–C6 shipped: `honoe` everywhere, ARCHITECTURE deps
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
- **Milestone 34b** (`packages/cli` — `honoe new --template rest|microservice`, a `honoe.config.ts`
  application seam, and discovery/dispatch of plugin-contributed CLI commands via
  `ICliApi`/`CAPABILITIES.CLI_COMMAND`, committed since M1 with no reader until now. Every
  scaffolded project — templated or not — exports `createApp()` from `honoe.config.ts`; `main.ts`
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
  disagreement with HEAD, not with a published snapshot) and necessary: `honoe new` pins generated
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
  JSDoc. **(C)** `honoe new --template nest`, the showcase: REST set + `DiPlugin` + an `@Injectable`
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
  **(A)** `honoe new --template full-stack` emits a React Router **8** framework-mode skeleton: the
  `routes → features → services → models` layering, `flatRoutes` `_app`/`_auth` groups each wrapped
  in their own `layout()`, the `~/*` alias, the `.server.ts` convention, one worked feature, and the
  Vite/npm build files. ROADMAP said the app structure was owned by the full-stack STARTER; that is
  impossible and was corrected — a starter is a JSR **library** and cannot write `app/routes.ts`
  into a user's project, so the CLI owns the file layout and the starter owns the plugin composition
  the generated `honoe.config.ts` calls. The deliverable that distinguishes this from
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
  emitting `import { env } from 'cloudflare:workers'` into `honoe.config.ts`, because `honoe` itself
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
  `honoe new --template microservice` got messaging, queues, resilience and telemetry — the four
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
  the Deno workspace and each carries its own `deno.json` mapping `@hono-enterprise/*` at
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
  runs there, and `apps/cloudflare/.wrangler/` is gitignored so `check:apps` no longer dirties the
  tree ahead of `publish:check`. `apps/compiled-binary` moved off its hardcoded port 4317 to
  `unusedPort()`) — complete (PR pending)
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
  Redis stopped), which is the real bar — 1058 passed each way) — complete (PR pending)
- **Next milestone** — **M38** (documentation), then M39–M40. **M54** (cloud message brokers —
  `MessagingBrokerType` is a closed switch with no `'custom'` arm, so SQS/SNS, GCP Pub/Sub and Azure
  Service Bus are not merely absent but inexpressible) remains queued behind those.

## Verification (run before declaring any work done)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

All four must pass. A milestone also requires 90%+ coverage (`deno task test:coverage`).

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
