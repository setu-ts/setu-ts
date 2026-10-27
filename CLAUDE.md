# Setu-TS — Session Instructions

Plugin-first enterprise backend framework, published to **npm** under `@setu-ts`, with Node, Deno
and Bun supported as runtimes. Package and root tooling tests run on Node 24 with pnpm and Vitest.
Repository scripts run on Node; the named native-adapter lane retains Deno proofs.

The React Router SSR plugin (M44) uses Vite on the Node/npm toolchain for application frontend
builds. Vite is an app-level, build-time `devDependency`; it is never imported by a plugin and never
appears in any published package's dependency graph (see AI_GUIDELINES §12.2).

## Starting a new milestone — READ THESE FIRST (mandatory)

**Step 0 — be on the milestone's feature branch, in its own worktree, before you touch anything.**
`develop` and `main` are both protected; never work on either and never commit to either directly
(AI_GUIDELINES §15.3). `develop` is the integration branch every PR targets except release and
hotfix PRs; `main` holds only the last release, is the repository's default branch (so
`gh pr create` needs `--base develop`), and changes only through a release or hotfix PR (see
"Branches" under Key conventions). A milestone gets exactly ONE feature branch —
`feat/[milestone]-[description]` (e.g. `feat/m4-logger-plugin`) — and ALL work for that milestone
lives on it: the initial implementation AND every follow-up fix, review change, or bug repair, right
up until the branch is merged. Every new task — milestone or not — starts in a NEW git worktree at
`.claude/worktrees/<name>`, never in the main checkout, which stays on `develop` (AI_GUIDELINES
§15.4). Your FIRST action is:

```bash
git worktree list                    # does the branch already have a worktree?
# If it does (work in progress) → cd into it and continue there.
# If the branch exists but has no worktree:
git worktree add .claude/worktrees/[milestone]-[description] feat/[milestone]-[description]
# If it does not exist yet, start it fresh in a new worktree:
git fetch origin && git worktree add -b feat/[milestone]-[description] \
  .claude/worktrees/[milestone]-[description] origin/develop
cd .claude/worktrees/[milestone]-[description] && git branch --show-current
```

Do NOT open a new `fix/…` branch for defects in a milestone that is not yet merged — those fixes
belong on the milestone's own `feat/…` branch (a `fix/…` branch is only for a defect in
already-merged code on `develop`). If `git branch --show-current` prints `develop` or `main` at any
point during a milestone, stop and switch to the feature branch before doing anything else. The
branch merges to `develop` via a single PR once the milestone is complete; it reaches `main` only
with the next release.

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
`plans/milestone-<N>-<desc>.md`, fill every `<FILL: …>`, and run `pnpm run check:plan`. It
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
  RUNTIME package (`@prisma/client` — `prisma` is the CLI and the plan had it wrong), and whether
  the library's API actually fits the contract being implemented (Prisma has only callback-style
  `$transaction` with a ~5s default timeout — no imperative begin/commit; bridging that is a design
  decision, not an implementation detail). A plan naming a lazy import must state exactly what it
  loads, when it can succeed, and the error when it cannot.
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

One line per entry. The full account of each entry — what shipped, what verification and review
found, and every recorded decision — is in
[`plans/archive/status-history.md`](plans/archive/status-history.md), unchanged from the text that
stood here until 2026-10-24.

Write a new entry the same way: one or two lines naming the packages, the change and the PR. The
long account of what verification and review found belongs in the milestone's PR description, not
here.

- **Milestone 0** (monorepo foundation) — complete (PR #1).
- **Milestone 1** (`packages/common`) — complete (PR #2).
- **Milestone 2** (`packages/kernel` — plugin kernel, service registry, pipeline, router,
  application lifecycle) — complete (PR #3).
- **Milestone 3** (`packages/runtime` — runtime services for Node/Deno/Bun, detection,
  RuntimePlugin) — complete (PR #4).
- **Milestone 4** (`packages/logger-plugin` — structured logging) — complete (PR #5).
- **Milestone 5** (`packages/config-plugin` — configuration with env loading, variable expansion,
  and Zod-compatible validation) — complete (PR #7).
- **Milestone 6** (`packages/validation-plugin` — Zod-based validation) — complete (PR #8).
- **Milestone 7** (`packages/exceptions` — exception hierarchy, error handler middleware, RFC 7807
  support) — complete (PR #15).
- **Milestone 8** (`packages/di-plugin` — optional dependency injection container with
  singleton/scoped/transient lifecycles, constructor injection, circular dependency detection,
  hierarchical scopes, and…) — complete (PR #16).
- **Milestone 9** (`packages/decorator-plugin` — optional decorators and reflection: `@Controller`,
  `@Get`/`@Post`/…, `@Body`/`@Query`/`@Param`/…, `@Injectable`/`@Inject`, `@Roles`/`@Permissions`/…)
  — complete (PR #20).
- **Milestone 10** (`packages/database-plugin` — DatabasePlugin with repository pattern, Unit of
  Work, ORM adapters for Prisma/Drizzle/Memory) — complete (PR #21).
- **Milestone 11** (`packages/cache-plugin` — CachePlugin with Memory, Redis, Noop stores;
  CacheService; cacheMiddleware for transparent response caching) — complete (PR #22).
- **Milestone 12** (`packages/events-plugin` — EventsPlugin, InMemoryEventBus, DomainEvent,
  IntegrationEvent, defineDomainEvent, IEventHandler, subscribeHandler; in-memory event bus with
  publish/publishBatch/subscribe…) — complete (PR #24).
- **Milestone 13** (`packages/cqrs-plugin` — CqrsPlugin, CommandBus/QueryBus, ICqrsFacade under
  `CAPABILITIES.CQRS`, internal RequestBus + composePipeline behavior pipeline,
  HandlerNotFoundError; CQRS contracts in…) — complete (PR #25).
- **Milestone 14** (`packages/messaging-plugin` — MessagingPlugin, InMemoryBroker,
  RedisStreamsBroker, JsonSerializer/ISerializer, EventsMessagingBridge; broker contracts in
  `common/services/messaging.ts`: IMessageBroker…) — complete (PR #26).
- **Milestone 14b** (`packages/messaging-plugin` — RabbitMQ, NATS and Kafka brokers added through
  the internal adapter seam) — complete (PR #27).
- **Milestone 14c** (`packages/messaging-plugin` — brokered request-reply (RPC) added to the
  existing MessagingPlugin: `request<TReq,TRes>()`/`respond<TReq,TRes>()` on the committed
  `IMessageBroker` (flagged `common`…) — complete (PR #60).
- **Milestone 14d** (`packages/messaging-plugin` — reply-transport seam + Kafka RPC: restores the
  per-broker `openInbox` seam the M14c plan specified but whose implementation collapsed into a…) —
  complete (PR #94).
- **Milestone 15** (`packages/queue-plugin` — QueuePlugin with MemoryQueue and RedisQueue adapters,
  QueueService for job processing with retries/backoff, recurring job scheduling via cron, job
  processor registration with…) — complete (PR #28).
- **Milestone 15b** (`packages/queue-plugin` — `RabbitMqQueue` adapter added to the existing
  QueuePlugin via the internal `QueueAdapter` seam; `basicGet` polling for `reserve`, per-message
  TTL with a dead-letter-exchange…) — complete (PR #32).
- **Milestone 41** (`packages/runtime` — HTTP server adapters taken out of order, before M16:
  `DenoHttpAdapter`/`NodeHttpAdapter`/`BunHttpAdapter` implementing `IHttpAdapter`, registered under
  `CAPABILITIES.HTTP_ADAPTER`…) — complete (PR #34).
- **Milestone 16** (`packages/auth-plugin` — AuthPlugin registering `IJwtService` under `jwt`,
  `IAuthService` under `authentication`, and `IAuthorizationService` under `authorization`; JWT
  HS256/RS256 via Web Crypto…) — complete (PR #35).
- **Milestone 16b** (`packages/auth-plugin` — refresh tokens & rate limiting as pure additions, no
  `common` change, no new capability token, `AuthPlugin` options untouched: `RefreshTokenService`
  (app-instantiated…) — complete (PR #36).
- **Milestone 17** (`packages/http-security-plugin` — CORS, security headers, CSRF, request-size,
  ip-security) — complete (PR #38).
- **Milestone 18** (`packages/scheduler-plugin` — SchedulerPlugin registering an `IScheduler` under
  `CAPABILITIES.SCHEDULER`; zero-dependency 5-field UTC cron parser, fixed-interval `every` and
  one-shot `delay` jobs, retry…) — complete (PR #40).
- **Milestone 19** (`packages/metrics-plugin` — Prometheus metrics collection: MetricsPlugin
  registering `IMetricsService` under `CAPABILITIES.METRICS`; counter/gauge/histogram/summary
  instruments over a shared…) — complete (PR #42).
- **Milestone 20** (`packages/health-plugin` — Health checks and readiness probes) — complete (PR
  #44).
- **Milestone 21** (`packages/openapi-plugin` — OpenAPI 3.1 spec generation from routes, Swagger UI
  serving, Zod-to-OpenAPI schema transformer, schema deduplication) — complete (PR #46).
- **Milestone 22** (`packages/kernel` — kernel routing on Hono: delegates `Router.match()` to
  `jsr:@hono/hono` with `LinearRouter`, preserves custom middleware pipeline, static-over-param
  precedence, and `inject()` parity) — complete (PR #47).
- **Milestone 23** (`packages/runtime` — runtime serve on Hono + Cloudflare Workers: replaces M41
  socket adapters with Hono's `fetch` entry, changes `IHttpAdapter` to
  `setHandler`/`fetch`/`listen`/`close`) — complete (PR #48).
- **Milestone 24** (`packages/telemetry-plugin` — TelemetryPlugin registering `ITelemetryService`
  under `CAPABILITIES.TELEMETRY`; `TelemetryService`/`NoopTelemetryService`; request-span middleware
  at priority 30 with W3C…) — complete (PR #49).
- **Milestone 24b** (`packages/telemetry-plugin` — auto-instrumentation added to the M24 plugin: a
  public per-instrumentation `instrumentations` option
  (`http`/`fetch`/`ioredis`/`amqplib`/`kafkajs`, each `true |…) — complete (PR #50).
- **Milestone 24c** (telemetry — OTel Collector **trace fan-out**: config + docs only, no code
  package) — complete (PR #51).
- **Milestone 25** (`packages/secrets-plugin` — SecretsPlugin registering an `ISecretManager` under
  `CAPABILITIES.SECRETS`; `SecretsService` wrapping an internal `SecretProvider` port with a
  monotonic-clock read-through…) — complete (PR #56).
- **Milestone 42** (`packages/common` — `IResponse.stream(ReadableStream<Uint8Array>)`, widened
  `snapshot()` returning a discriminated union `{ streaming: false, body: Uint8Array|string|null }`
  / `{ streaming: true, body…) — complete (PR #53).
- **Milestone 43** (`packages/sse-plugin` — Server-Sent Events plugin with frame encoding, named
  channels, heartbeat, `Last-Event-ID`) — complete (PR #55).
- **Milestone 44** (`packages/react-router-plugin` — React SSR + file-based routing by embedding
  React Router v7 framework mode as a plugin over a kernel catch-all handler; `ReactRouterPlugin`
  registering `SsrService`…) — complete (PR #57).
- **Milestone 26** (`packages/audit-plugin` — AuditPlugin registering an `IAuditLogger` under
  `CAPABILITIES.AUDIT`, backed by a pluggable internal `IAuditStorage` port; `AuditService.log()`
  stamps each `AuditEntry` with an…) — complete (PR #58).
- **Milestone 27** (`packages/resilience-plugin` — ResiliencePlugin registering an
  `IResilienceService` under `CAPABILITIES.RESILIENCE`; a zero-dependency `ResilienceService.wrap`
  composing four pure in-process patterns —…) — complete (PR #59).
- **Milestone 28** (`packages/storage-plugin` — StoragePlugin registering `IStorage` under
  `CAPABILITIES.STORAGE`; five pluggable providers — `MemoryProvider` (zero-dep default),
  `LocalStorageProvider` (over `runtime.fs`)…) — complete (PR #63).
- **Milestone 29** (`packages/mail-plugin` — MailPlugin registering an `IMailer` under
  `CAPABILITIES.MAIL`, backed by a pluggable internal `MailProvider` port; four backends —
  `LogProvider` (zero-dependency default…) — complete (PR #61).
- **Milestone 45** (`packages/worker-pool-plugin` — WorkerPoolPlugin registering an `IWorkerPool`
  under a new `CAPABILITIES.WORKER_POOL = 'worker-pool'` token; runs CPU-bound work on real worker
  threads off the event loop) — complete (PR #64).
- **Milestone 30** (`packages/notification-plugin` — NotificationPlugin registering an `INotifier`
  under `CAPABILITIES.NOTIFICATION`, backed by a two-layer channel → transport design: four channels
  own address extraction…) — complete (PR #65).
- **Milestone 30b** (`packages/notification-plugin` — FCM HTTP v1: M30's `FcmProvider` posted to
  `POST /fcm/send` with `Authorization: key=<serverKey>`, the API Google switched off in 2024, so
  the push channel could never…) — complete (PR #96).
- **Milestone 46** (`packages/websocket-plugin` — WebSocketPlugin registering an `IWebSocketService`
  under a new `CAPABILITIES.WEBSOCKET = 'websocket'` token; full-duplex bidirectional messaging,
  completing the real-time…) — complete (PR #66).
- **Milestone 31** (`packages/feature-flags-plugin` — FeatureFlagsPlugin registering the committed
  synchronous `IFeatureFlags` under `CAPABILITIES.FEATURE_FLAGS`, backed by an exported
  `FlagProvider` port whose…) — complete (PR #67).
- **Milestone 32** (`packages/multi-tenancy-plugin` — MultiTenancyPlugin factory; four resolvers:
  Subdomain/Header/Path/Jwt; three isolation strategies: Column/Schema/Database; `ITenantDataStore`
  port +…) — complete (PR #71).
- **Milestone 33** (`packages/testing` — test utilities; depends on `common` + `kernel` only, no
  plugin and no npm dep) — complete (PR #78).
- **Alpha release `v0.1.0-alpha.1`** — the first JSR release, published by hand.
- **Alpha release `v0.1.0-alpha.2`** — published 2026-07-28; the first release CI published.
- **Milestone 34** (`packages/cli` — the `setu` CLI: `new` project scaffolding and plugin-aware
  `generate` code generation) — complete (PR #88).
- **Milestone 34b** (`packages/cli` — `setu new --template rest|microservice`, a `setu.config.ts`
  application seam, and discovery/dispatch of plugin-contributed CLI commands via
  `ICliApi`/`CAPABILITIES.CLI_COMMAND`…) — complete (PR #89).
- **Milestone 47** (alpha-3 limitation closeout — the three `CHANGELOG.md` "Known limitations" from
  `v0.1.0-alpha.1` that were real capability gaps rather than wording problems) — complete (PR #97).
- **Milestone 35** (`packages/sdk` — client SDK) — complete (PR #98).
- **Milestone 36** (`packages/starters/rest-starter`, `packages/starters/microservice-starter`,
  `packages/starters/full-stack-starter` — opinionated plugin composition libraries:
  `createRestApp`, `createMicroserviceApp`…) — complete (PR #106).
- **Alpha release `v0.1.0-alpha.3`** — published 2026-07-30 (PR #99); 38 packages.
- **Milestone 48** (`packages/session-plugin` — cookie sessions and form CSRF: `SessionPlugin`
  registering an `ISessionService` under a new `CAPABILITIES.SESSION` token, the capability the
  framework had none of —…) — complete (PR #105).
- **Milestone 36b** (`packages/starters/*` + `packages/decorator-plugin` + `packages/cli` — starter
  integration: realtime, DI, and NestJS familiarity) — complete (PR #107).
- **Milestone 36c** (`packages/cli` + `packages/starters/*` + `packages/config-plugin` +
  `packages/runtime` — React Router app skeleton and config-driven composition) — complete (PR
  #108).
- **Milestone 50** (`packages/service-discovery-plugin` — the capability the framework had none of:
  it can be _found_ by an orchestrator but cannot _find_ anything) — complete (PR #109).
- **Milestone 49** (`packages/grpc-plugin` — co-serving the gRPC family (gRPC, Connect, gRPC-Web) on
  the SAME port and fetch handler as ordinary Hono routes, registering an `IGrpcService` under a new
  `CAPABILITIES.GRPC =…) — complete (PR #110).
- **Milestone 51** (`packages/graphql-plugin` — GraphQL plugin: schema-first and code-first arms,
  GraphQL-over-HTTP transport with media-type negotiation and status-code watershed, bounded
  parse+validate document cache…) — complete (PR #116).
- **Milestone 51b** (`packages/graphql-plugin` + `websocket-plugin` + `common` — GraphQL
  subscriptions over WebSocket and SSE, request batching, Automatic Persisted Queries, custom scalar
  resolvers) — complete (PR #117).
- **Milestone 52** (`packages/cloudflare-plugin` — Workers platform bindings: KV, R2, D1, queues,
  service bindings, Durable Objects, `vars` and `waitUntil`) — complete (PR #111).
- **Milestone 52b** (`packages/cloudflare-plugin` — Cloudflare Queues, Cron Triggers, and the Cache
  API: the three platform features that need a **module-level handler export** from the
  application's Worker rather than…) — complete (PR #113).
- **Milestone 52c** (`packages/common` + `packages/database-plugin` + `packages/cloudflare-plugin` —
  D1 as a first-class backend, gated on promoting the data-access port) — complete (PR #114).
- **Milestone 52d** (`packages/cloudflare-plugin` — Durable Objects: a DO-backed realtime backplane
  and distributed lock) — complete (PR #115).
- **Milestone 50b** (`packages/cli` — wiring service discovery into the microservice template) —
  complete (PR #120).
- **Milestone 37** (`apps/*` — runnable example applications and the `check:apps` gate that keeps
  them working) — complete (PR #122).
- **Milestone 37b** (`apps/*` — DI/decorators and memory-database examples, plus a microservices
  correction) — complete (PR #122).
- **Milestone 53** (`.github/workflows/ci.yml` + `scripts/check-apps.ts` + guarded Redis tests —
  real-backend CI: making the proofs that matter actually run on every pull request) — complete (PR
  #123).
- **Milestone 37c** (`apps/full-stack` — the runnable React Router example the framework's largest
  capability had none of) — complete (PR #126).
- **M54** (cloud message brokers — SQS/SNS via `SqsQueue`/`SnsPublisher` in `queue-plugin`, GCP
  Pub/Sub and Azure Service Bus via `GcpPubSubBroker`/`ServiceBusBroker` in `messaging-plugin`,
  `'custom'` arm on…) — complete (PR #128).
- **Milestone 55** (`packages/static-plugin` — static file serving as a capability rather than a
  side effect of SSR) — complete (PR #132).
- **Milestone 56** (`packages/exceptions` + `packages/validation-plugin` + the three starters — RFC
  9457 Problem Details, retiring a withdrawn specification) — complete (PR #135).
- **Milestone 57** (`packages/common` + `packages/auth-plugin` + `packages/openapi-plugin` — derived
  OpenAPI security) — complete (PR #137).
- **Milestone 58** (`packages/cli` — `setu g module`, the first aggregate schematic and the first
  managed file) — complete (PR #139).
- **Milestone 60** (`packages/cli` + `cqrs-plugin` + `events-plugin` + `metrics-plugin` — generated
  code that is wired) — complete (PR #141).
- **Milestone 61** (`packages/cli` — decorators and DI as real choices in the generator) — complete
  (PR #142).
- **Milestone 38** (`docs/*` + `scripts/*` + `test/*` — documentation hub and tooling) — complete
  (PR #143).
- **Milestone 62** (`packages/cli` — monorepo support: more than one deployable service in a
  repository) — complete (PR #144).
- **Milestone 59** (`packages/cloudflare-plugin` + `packages/cli` — Workers-native messaging, the
  last edge capability gap) — complete (PR #145).
- **Milestone 39** (`docker/` + `k8s/` + `scripts/` + `docs/` — containerization and orchestration)
  — complete (PR #149).
- **Milestone 63** (`packages/cli` — scaffold repairs) — complete (PR #153).
- **Milestone 64** (`packages/decorator-plugin` — `@Ctx()`, the built-in parameter decorator that
  resolves the live `IRequestContext`, so a decorated handler can set a status code, add a header,
  or stream without dropping…) — complete (PR #154).
- **Milestone 65** (`packages/cli` — functional default and `class-based` opt-in) — complete (PR
  #155).
- **Milestone 66** (`packages/database-plugin` — executable Prisma v7 and Drizzle adapters) —
  complete (PR #156).
- **Milestone 67** (`packages/cli` + `packages/starters/rest-starter` + `packages/config-plugin` —
  scaffold defaults and workspace ergonomics: the five alpha.7 findings that each cost a hand-edit)
  — complete (PR #157).
- **Milestone 68** (contract gaps: `common` + `kernel` + `auth-plugin` + `database-plugin` +
  `cloudflare-plugin` — the four alpha.7 smoke findings that touch committed contracts) — complete
  (PR #158).
- **Milestone 69** (`packages/database-plugin` — typed Drizzle query seam) — complete (PR #162).
- **Milestone 70h** (`packages/cli` + `packages/common` + `packages/runtime` — the CLI scaffold
  batch of the alpha.8 smoke programme: **23 register rows** closed on one branch, because they
  share one shape — **a generated…) — complete (PR #166).
- **Milestone 70a** (`common` + `kernel` + `runtime` + `grpc-plugin` + `websocket-plugin` — the
  pipeline bypass, first of the M70 alpha-8 defect closeout) — complete (PR #167).
- **Milestone 70b** (`cache-plugin` + `multi-tenancy-plugin` + `session-plugin` and 4 more — tenant
  isolation and data exposure) — complete (PR #168).
- **Milestone 45b** (`packages/worker-pool-plugin` — `TaskPoolStats` as a Prometheus signal) —
  complete (PR #170).
- **Milestone 45c** (`packages/worker-pool-plugin` — service-wide worker pool sizing) — complete (PR
  #433).
- **Milestone 70c** (`messaging-plugin` + `realtime-backplane-plugin` + `storage-plugin` and 4 more
  — health signals that describe lifecycle, not reachability) — complete (PR #172).
- **Milestone 70d** (`cli` + `common` + `health-plugin` + `cqrs-plugin` + `events-plugin` +
  `di-plugin` — the no-argument registration seams, closing the register's "single most repeated
  defect") — complete (PR #173).
- **Milestone 70e** (`sdk` + `grpc-plugin` + `telemetry-plugin` — the default branches of injectable
  seams, closing X11-1 and X7-3) — complete (PR #174).
- **Milestone 70f** (`storage-plugin` + `kernel` + `exceptions` and 13 more — error format and error
  visibility) — complete (PR #176).
- **Milestone 70g** (`kernel` + `cli` — routing collisions; docs in `react-router-plugin` and
  `static-plugin`, and the end-to-end gate in `apps/full-stack`) — complete (PR #175).
- **Milestone 70j** (`packages/database-plugin` — database adapter correctness) — complete (PR
  #177).
- **Milestone 70k** (`storage-plugin` + `queue-plugin` + `worker-pool-plugin` + `common` +
  `runtime` + `cli` + `cloudflare-plugin` — storage, queue and worker operability) — complete (PR
  #178).
- **Milestone 70i** (`packages/grpc-plugin` + `packages/graphql-plugin` +
  `packages/websocket-plugin` — gRPC and GraphQL viability) — complete (PR #180).
- **Milestone 70m** (`common` + `validation-plugin` + `openapi-plugin` + `sdk` +
  `http-security-plugin` — SDK and OpenAPI, closing X11-3 through X11-9) — complete (PR #181).
- **Milestone 70l** (`cli` + `scheduler-plugin` + `messaging-plugin` + `metrics-plugin` +
  `cloudflare-plugin` — deployment and operations: nine register rows that share one shape, **the
  framework is correct on one machine…) — complete (PR #182).
- **Milestone 70n** (`decorator-plugin` + `validation-plugin` + `common` and 10 more — decorators,
  validation, and the alpha.8 closeout) — complete (PR #183).
- **Milestone 71** (`kernel` + `common` + state-key consumers — kernel and contract boundary
  hardening) — complete (PR #190).
- **Milestone 72** (`packages/cli` — standalone broker selection and interactive scaffolding) —
  complete (PR #191).
- **Alpha release `v0.1.0-alpha.9`** — published 2026-08-26 (PR #192); 47 packages.
- **Milestone 73** (`packages/common` + `packages/session-plugin` + `packages/auth-plugin` and 3
  more — realtime authentication) — complete (PR #197).
- **Milestone 74** (`packages/common` + `packages/websocket-plugin` + `packages/sse-plugin` —
  realtime registry reads and the SSE contract) — complete (PR #196).
- **Milestone 75** (`packages/common` + `packages/telemetry-plugin` + `packages/messaging-plugin` —
  broker trace propagation) — complete (PR #201).
- **Milestone 76** (`decorator-plugin` + `openapi-plugin` + `starters/rest-starter` + `cli` +
  `apps/di-decorators` + docs — TC39 standard decorators, retiring `experimentalDecorators`) —
  complete (PR #200).
- **Milestone 77** (`scripts` + `test` + documentation rules — executable prose assertions) —
  complete (PR #205).
- **Alpha release `v0.1.0-alpha.10`** — published 2026-08-28 (PR #202); 47 packages.
- **Release `v0.2.0`** — published 2026-09-02 (PR #223); 47 packages.
- **Milestone 78** (native MongoDB backend for `database-plugin` + including the `'mongodb'`
  configuration arm + native query translation and 3 more — complete (PR #208) — complete (PR #208).
- **Milestone 83** (`@Module` declarations, generated module activation, and the default REST
  functional greeting example — complete (PR #213) — complete (PR #213).
- **Milestone 84** (first-party SSE/WebSocket SDK clients, realtime CLI starting points, and the
  four-runtime client smoke exercise — complete (PR #214) — complete (PR #214).
- **Milestone 85** (`packages/cli` — full-stack gRPC workspace members: renders the existing
  `GrpcPlugin()` transport contribution as `app.register(...)` after
  `createFullStackAppFromConfig()` returns, while retaining the…) — complete (PR #215).
- **Milestone 89a** (`decorator-plugin` + `multi-tenancy-plugin` + `cli` — declarations that enforce
  nothing) — complete (PR #235).
- **Milestone 79** (`common` + `database-plugin` + `cloudflare-plugin` — portable data-access
  contract: composite keys, nested field paths and keyset cursor pagination, implemented across all
  **five** shipped adapters) — complete (PR #217).
- **Milestone 80** (`database-plugin` — DynamoDB backend: the fifth built-in arm,
  `DatabasePlugin({ type: 'dynamodb', options })`, served by `DynamoAdapter` over AWS SDK v3 loaded
  lazily…) — complete (PR #221).
- **Milestone 81** (`packages/database-plugin` — Azure Cosmos DB backend) — complete (PR #220).
- **Milestone 82** (`packages/database-plugin` — Cloud Bigtable backend, the wide-column half of the
  gap M78 named and only half closed) — complete (PR #222).
- **Milestone 87** (`packages/common` + `packages/kernel` + `packages/runtime` — request-path
  performance) — complete (PR #227).
- **Milestone 88** (`packages/common` + `packages/kernel` + `packages/runtime` — response-path
  performance) — complete (PR #233).
- **Milestone 86** (`common`, `cqrs-plugin`, `websocket-plugin`, `queue-plugin`, `scheduler-plugin`,
  `messaging-plugin` — non-HTTP ingress registration and behaviours: the shared
  `IngressContext`/`IIngressBehavior`…) — complete (PR #228).
- **Release `v0.3.0`** — published 2026-09-03 (PR #229); 47 packages.
- **Milestone 89b** (`common` + `exceptions` + `database-plugin` + `auth-plugin` — caller errors
  that read as server faults) — complete (PR #236).
- **Milestone 89c** (`messaging-plugin` + `common` + `multi-tenancy-plugin` — the `0.3.0` ingress
  surface, closing the last two smoke findings) — complete (PR #240).
- **Release `v0.4.0`** — published 2026-09-04 (PR #242); 47 packages.
- **Milestone 90a** (`common` + `auth-plugin` + `http-security-plugin` and 5 more — abuse control
  that actually protects) — complete (PR #247).
- **Milestone 90b** (`packages/secrets-plugin` + `packages/cache-plugin` +
  `packages/realtime-backplane-plugin` and 4 more — health that tells the truth, bounded) — complete
  (PR #249).
- **Milestone 90c** (`auth-plugin` — credential revocation and token type) — complete (PR #248).
- **Milestone 90d** (`packages/messaging-plugin` — the two brokers that cannot start) — complete (PR
  #256).
- **Milestone 90f** (`common` + `runtime` + `kernel` + `testing` + `database-plugin` +
  `secrets-plugin` + `resilience-plugin` — caller errors reach the client correctly) — complete (PR
  #259).
- **Milestone 90h** (docs + `packages/auth-plugin` + `packages/database-plugin` and 2 more —
  documentation that survives contact) — complete (PR #261).
- **Milestone 90i** (`common` + `queue-plugin` + `telemetry-plugin` + `logger-plugin` +
  `cloudflare-plugin` — observability that joins up) — complete (PR #260).
- **Release `v0.5.0`** — published 2026-09-09 (PR #265); 47 packages.
- **Milestone 91** (`packages/kernel` + `packages/testing` — a test app that composes like the real
  one) — complete (PR #278).
- **Milestone 92** (`packages/common` + `packages/decorator-plugin` + `packages/view-plugin` (new) —
  view plugin: server-rendered HTML as a capability) — complete (PR #284).
- **Milestone 93a** (`packages/events-plugin` — aggregate-local domain event recording) — complete
  (PR #285).
- **Milestone 93b** (`packages/messaging-plugin` — versioned integration-event contracts over the
  existing messaging capability: `defineIntegrationEvent` (enforcing the `.v<version>` topic suffix
  at definition time), the…) — complete (PR #287).
- **Milestone 95a** (`packages/cli` + `docs/` — a generated deployment cannot start) — complete.
- **Milestone 95b** (`packages/common` + `packages/database-plugin` + `packages/messaging-plugin` —
  reachability that fails open: all three rows closed) — complete (PR #319).
- **Milestone 95c** (`packages/common` + `packages/database-plugin` + `packages/kernel` and 2 more —
  a contract its own implementation does not honour: five documented contracts the code disagreed
  with, two at the boundary…) — complete (PR #322).
- **Milestone 95d** (`docs/` + `packages/common` + `packages/view-plugin` + `scripts/` —
  documentation that survives contact: four findings where the code is correct and a reader
  following the documentation still ends up…) — complete (PR #332).
- **Milestone 96** (`packages/common` + `packages/logger-plugin` + `packages/telemetry-plugin` +
  `packages/audit-plugin` — one redaction seam for every egress path) — complete (PR #324).
- **Milestone 97b** (`packages/decorator-plugin` + `packages/common` + `packages/openapi-plugin` —
  response shaping for decorated handlers) — complete (PR #328).
- **Milestone 99c** (`packages/sdk` + `packages/kernel` — two first-party components that must
  agree, and do not) — complete (PR #353).
- **Milestone 99d** (`packages/decorator-plugin` and `packages/secrets-plugin` — a composition the
  framework silently declines to give you) — complete (PR #358).
- **Milestone 98d** (`packages/common` + `packages/health-plugin` + `packages/diagnostics-plugin` —
  minimized health observations) — complete (PR #363).
- **Milestone 99e** (`packages/cli` + `docs` — a template axis that forces one style) — complete (PR
  #364).
- **Milestone 98f** (`packages/common` + `packages/queue-plugin` + `packages/diagnostics-plugin` —
  queue attempt, outcome and depth observations) — complete (PR #365).
- **Milestone 98e** (`packages/config-plugin` + `packages/common` + `packages/diagnostics-plugin` —
  value-free configuration provenance) — complete (PR #366).
- **Milestone 98g** (`packages/telemetry-plugin` + `packages/common` + `packages/diagnostics-plugin`
  — minimized distributed tracing and correlation) — complete (PR #369).
- **Milestone 98i** (`packages/cache-plugin` + `packages/common` + `packages/diagnostics-plugin` —
  cache operation counters) — complete (PR #374).
- **Milestone 98h** (`packages/auth-plugin` + `packages/common` + `packages/kernel` +
  `packages/diagnostics-plugin` — authorization decision explanations) — complete (PR #376).
- **Milestone 98j** (`packages/events-plugin` + `packages/common` + `packages/diagnostics-plugin` —
  event dispatch observations) — complete (PR #375).
- **Milestone 98k** (`packages/scheduler-plugin` + `packages/common` + `packages/diagnostics-plugin`
  — scheduler execution observations) — complete (PR #379).
- **Milestone 98l** (`packages/websocket-plugin` + `packages/sse-plugin` +
  `packages/realtime-backplane-plugin` and 2 more — realtime lifecycle observations) — complete (PR
  #377).
- **Milestone 98n** (`packages/sdk` + `packages/common` + `packages/diagnostics-plugin` — outbound
  HTTP attempt observations) — complete (PR #380).
- **Milestone 98m** (`packages/storage-plugin` + `packages/common` + `packages/diagnostics-plugin` —
  storage operation counters) — complete (PR #383).
- **Milestone 100a** (`packages/auth-plugin` + `packages/starters/*` — authentication composition) —
  complete (PR #384).
- **Milestone 100b** (`packages/auth-plugin` + `packages/cli` — tokens from an outside issuer) —
  complete (PR #385).
- **Milestone 100c** (`packages/auth-plugin` + `packages/common` — sign-in with an outside provider)
  — complete (PR #386).
- **Milestone 100d** (`packages/auth-plugin` + `packages/common` — multi-factor authentication
  (TOTP) and step-up) — complete (PR #388).
- **Milestone 100e** (`packages/auth-plugin` — passkeys (WebAuthn)) — complete (PR #391).
- **Milestone 100f** (`packages/auth-plugin` — SAML 2.0 service provider) — complete (PR #393).
- **Milestone 98o** (`packages/diagnostics-plugin` + `packages/cli` — diagnostics session renewal) —
  complete (PR #392).
- **Milestone 101d** (`packages/sdk` + `packages/telemetry-plugin` +
  `packages/react-router-plugin` + `packages/starters/full-stack-starter` — aligned both sides of
  five first-party call contracts) — complete (PR #403).
- **Release `v0.8.0`** — cut 2026-10-03 (PR #394); 49 packages.
- **Milestone 101a** (`common` + `messaging-plugin` + `database-plugin` and 4 more — health that
  reports healthy, and calls that hang, when a dependency fails) — complete (PR #401).
- **Milestone 102** (`packages/mail-plugin` — mail bodies rendered through the view engine) —
  complete (PR #400).
- **Milestone 101b** (`packages/messaging-plugin` — message transports that fail against the real
  broker) — complete (PR #404).
- **Milestone 103** (`packages/localization-plugin` (new) + `packages/common` +
  `packages/cache-plugin` and 3 more — localization) — complete (PR #405).
- **Milestone 101e** (`packages/cli` — write safety) — complete (PR #412).
- **Milestone 101c** (`packages/session-plugin` + `packages/common` +
  `packages/multi-tenancy-plugin` and 3 more — tenancy and identity features that do not compose;
  V8-7, V8-8, V8-9, V8-25) — complete (PR #411).
- **Milestone 101f** (`packages/cli` + `packages/common` + diagnostics sources — devtool lifecycle)
  — complete (PR #414).
- **Milestone 101g** (`packages/cli` + the full-stack template — wired scaffolds) — complete (PR
  #415).
- **Milestone 101i** (`packages/cli` + `packages/kernel` + `packages/di-plugin` and 5 more —
  first-run repairs; no ROADMAP entry, by the maintainer's direction) — complete (PR #426).
- **Milestone 106** (`packages/common` + `packages/messaging-plugin` +
  `packages/cloudflare-plugin` + `packages/queue-plugin` — publish options) — complete (PR #427).
- **Milestone 107** (`packages/messaging-plugin` + `packages/common` + `packages/database-plugin` +
  `packages/telemetry-plugin` — transactional outbox) — complete (PR #431).
- **Milestone 109a** (`packages/idempotency-plugin` (new) + `packages/common` +
  `packages/decorator-plugin` and 4 more — idempotency core) — complete (PR #434).
- **Milestone 108** (`packages/messaging-plugin` + `packages/common` + `packages/database-plugin`
  and 1 more — consumer inbox) — complete (PR #436).
- **Milestone 109b** (`packages/idempotency-plugin` + `packages/common` +
  `packages/database-plugin` + `packages/sdk` — idempotency tier C and the SDK key) — complete (PR
  #438).
- **Milestone 105** (`packages/common` + `packages/database-plugin` + `packages/cloudflare-plugin` —
  conditional writes on `IRepository`) — complete (PR #439).
- **Milestone 110a** (`packages/common` + `packages/auth-plugin` + `packages/decorator-plugin` —
  authorization policies) — complete (PR #440).
- **Milestone 107b** (`packages/messaging-plugin` + `packages/common` + `packages/database-plugin` —
  outbox relay fencing and multi-relay sweeping) — complete (PR #441).
- **Milestone 110b** (`packages/common` + `packages/auth-plugin` + `packages/decorator-plugin` +
  `packages/database-plugin` — scoped RBAC) — complete (PR #444).
- **Milestone 101h** (`packages/common` + the READMEs of `common` + `storage-plugin` and 8 more —
  documentation, plus the one additive redaction change) — complete (PR #445).
- **Milestone 111a** (every member + `scripts/` + CI — a Node build for every package) — complete
  (PR #446).
- **Milestone 111b** (every member + `scripts/` + CI — the test suite on Node under Vitest) —
  complete (PR #447).
- **Milestone 111c** (every member + `scripts/` + CI — npm publishing machinery, proven by dry runs;
  the `v0.9.0` cut follows M111d) — complete (PR #448).
- **Milestone 111d** (`packages/cli` + new `packages/create` + `scripts/` + docs — the CLI goes
  Node-first) — complete (PR #450).
- **Release `v0.9.0`** — cut 2026-10-12 (PR #451); 52 packages.
- **Milestone 111e1** (repository tooling — Prettier and ESLint replace `deno fmt` and `deno lint`)
  — complete (PR #455).
- **Milestone 111e2** (repository tooling — scripts and root tests on Node) — complete (PR #458).
- **Milestone 111e3** (repository tooling — CI, examples and website on Node and pnpm; root
  `deno.json` and `deno.lock` removed) — complete (PR #459).
- **Milestone 111f** (governing documents, docs and `scripts/` — the JSR sunset) — complete (PR
  #460).
- **Milestone 113a** (`packages/messaging-plugin` — brokers that report healthy while down, and
  publishes with no bound; V9-35, V9-36, V9-37, V9-3) — complete (PR #462).
- **Milestone 113b** (`service-discovery-plugin` + `health-plugin` docs + `scheduler-plugin` and 10
  more — readiness that does not describe the dependency; V9-2, V9-19, V9-32, V9-44) — complete (PR
  #463).
- **Milestone 113c** (`queue-plugin` + `runtime` + `common` and 2 more — connections and jobs that
  never recover, and a shutdown with no bound; V9-18, V9-64, V9-71, V9-76, V9-31) — complete (PR
  #466).
- **Milestone 113d** (`common` + `react-router-plugin` + `cloudflare-plugin` + `cli` + the loaders
  of 14 published packages — Workers builds and the edge cache; V9-1, V9-23, V9-4) — complete (PR
  #465).
- **Milestone 113e** (`packages/auth-plugin` + `packages/session-plugin` — identity and session
  semantics a client cannot predict; V9-28, V9-27, V9-46, V9-50; every option the recommended one,
  maintainer decision 2026-10-17) — complete (PR #467).
- **Milestone 113f** (`packages/exceptions` + `packages/logger-plugin` + `packages/database-plugin`
  and 6 more — what reaches logs and public endpoints; V9-45, V9-47, V9-43, V9-80, V9-82, V9-41,
  V9-49) — complete (PR #468).
- **Milestone 113j** (`packages/messaging-plugin` + `packages/database-plugin` + `scripts/` + docs —
  outbox and inbox signals; V9-20, V9-21, V9-22 and V9-10's `npm:zod` half) — complete (PR #469).
- **Milestone 113g** (`packages/database-plugin` + `packages/common` + `packages/cloudflare-plugin`
  — database calls and errors under faults and edge inputs; V9-25, V9-26, V9-33, V9-34, V9-48) —
  complete (PR #470).
- **Milestone 113m** (`packages/scheduler-plugin` + `packages/auth-plugin` — time the framework does
  not honour; V9-63, V9-70) — complete (PR #471).
- **Milestone 113n** (`packages/http-security-plugin` + `packages/runtime` + `packages/common` and 3
  more — security behind a reverse proxy; V9-65, V9-66, plus the RFC 7239 `Forwarded` header,
  `Secure` cookies and public…) — complete (PR #473).
- **Milestone 113o** (`database-plugin` + `cli` + `service-discovery-plugin` — schema-aware and
  stale-cache readiness; V9-68 and the discovery stale-cache case) — complete (PR #475).
- **Milestone 113k** (`packages/sdk` + docs in `idempotency-plugin`, `http-security-plugin`,
  `database-plugin` — the idempotency key from client to server; V9-14, V9-15, V9-16) — complete (PR
  #476).
- **Milestone 113h** (`cli` + `runtime` + `kernel` — generated output that is wrong; V9-8, V9-17,
  V9-38, V9-39, V9-9, V9-11, V9-42, V9-67, V9-81, on one `fix/` branch) — complete (PR #477).
- **Milestone 113i** (`cli` — CLI commands whose refusals and guidance mislead; V9-5, V9-12, V9-13,
  V9-30, V9-40, V9-60, V9-61, V9-62, V9-75, on one `fix/` branch) — complete (PR #479).
- **Milestone 114** (`packages/cli` + `packages/validation-plugin` + `packages/common` +
  `packages/decorator-plugin` — self-contained feature modules; V9-79) — complete (PR #480).
- **Milestone 113l** (documentation that does not match the code, or is missing; twenty V9 rows) —
  complete (PR #483).
- **V9-77** (`secrets-plugin` — environment secrets fall back to config, 0.10.0) — complete (PR
  #485).
- **`@ApiOperation` operation ids** (`common` + `decorator-plugin` + `openapi-plugin` — declared
  OpenAPI metadata reaches the document, 0.10.0) — complete (PR #487).
- **Milestone 116** (`packages/cli` + every published library package + `scripts/` — agent briefs) —
  complete (PR #484).
- **The `v0.6.0` closeout** — the regression run and Part 11 (X46–X51) folded together by defect
  shape into M95a–M95d.
- **Milestone 97** (ingress decorators, response shaping, typed config sections) — complete: 97a (PR
  #327), 97b (PR #328), 97c (PR #330).
- **Milestone 95** (`cli` + `messaging-plugin` + `common` + `session-plugin` + `static-plugin` +
  `docs/` — the `v0.6.0` smoke defect closeout) — open; letters M95a–M95d.
- **Milestone 94a** (`packages/exceptions` — application-owned caught-error responses) — complete
  (PR #288).
- **Milestone 94b** (`packages/common` + `packages/runtime` + `packages/kernel` and 3 more — one
  form-body abstraction) — complete (PR #290).
- **Milestone 94c** (`packages/session-plugin` — CSRF token field helper) — complete.
- **Milestone 98a** (`packages/kernel` + `packages/common` — optional read-only kernel diagnostics)
  — complete (PR #345).
- **Milestone 98b** (`packages/runtime` + `packages/common` + new `packages/diagnostics-plugin` —
  the authenticated local diagnostics connector) — complete (PR #347).
- **Milestone 98c** (`packages/cli` — devtool scaffolding) — complete (PR #352).
- **Milestone 99a** (`packages/logger-plugin` + `packages/common` + `packages/messaging-plugin` — a
  control that reports safe for what it does not cover) — complete (PR #350).
- **Milestone 99b** (`packages/cli` + `docs` — generated output is usable) — complete (PR #346).
- **Milestone 115** (no packages — the `v0.10.0` client-brief run: Relaymark built by three agents,
  X74 in both forms; findings V10-49…V10-63, see `smoke/M115-FINDINGS.md`) — complete.
- **Milestone 119a** (`packages/messaging-plugin` — shared queue-less NATS groups, an ephemeral
  reply inbox and reaped leaked consumers, the Kafka first-join seek rule, and `PublishTimeoutError`
  with Redis Streams/NATS publish bounds; V10-13, V10-2, V10-21, V10-30, V10-5) — complete (PR
  #498).
- **Milestone 119b** (`common` + `kernel` + `health-plugin` + `mail-plugin` and 4 more —
  per-indicator readiness membership with an app override, mail out of readiness by default, bounded
  backplane and RabbitMQ queue probes, gRPC health on readiness, migration readiness on a reachable
  connection; V10-49, V10-20, V10-22, V10-31) — complete (PR #499).
- **Milestone 119g** (`auth-plugin` + `common` + `idempotency-plugin` + `service-discovery-plugin` —
  failure reasons at `warn` once per state change, `describeError` in `common`, a named discovery
  503; V10-62, V10-63, V10-34) — complete (PR #500).
- **Milestone 119c** (`cli` + `http-security-plugin` + `service-discovery-plugin` and docs — safe
  framework, broken default: `TRUSTED_PROXIES` in the full-stack template, CSRF `Origin: null` with
  `Sec-Fetch-Site: same-origin` plus an opt-out, exact `swagger-ui-dist` pin, telemetry peers and
  Redis arms from `setu add`, forced test exit, named Kubernetes token fault; V10-17, V10-1, V10-3,
  V10-36, V10-6, V10-29, V10-44, V10-14, V10-41) — complete (PR #501).
- **Milestone 119d** (`packages/http-security-plugin` — a malformed `Forwarded` element is a
  boundary the trust walk never crosses, bounds read from the right, one address normalizer; V10-19,
  V10-28) — complete (PR #503).
- **Milestone 119e** (`database-plugin` + `common` + `cloudflare-plugin` — the tenant column
  resolved to its Drizzle property, entity-bound cursor fingerprints, unknown fields refused on
  every SQL adapter, a refused value as a named 400, a named missing-key-column error checked at
  connect, and a reporting pool `'error'` listener; V10-4, V10-32, V10-33, V10-37, V10-45, V10-61) —
  complete (PR #504).
- **Milestone 119h** (`packages/cli` — inactive-module report, workerd-backed Workers tests,
  `setu agents --check --strict`, dry-run parity and symlinked-member refusal, fixed module 404,
  Worker name rule, interrupted `adopt` re-read, version-tagged links; V10-18, V10-23…V10-27,
  V10-35, V10-9, V10-10, V10-11, V10-42) — complete (PR #506).
- **Milestone 119f** (`common` + `cli` + the 16 packages with optional peers — optional peers in an
  npm workspace: the load error names who loads the peer and that it belongs where that package is
  installed, and `setu add` in an npm/Bun workspace member also records peers in the root; V10-50,
  V10-58) — complete (PR #505).
- **Milestone 125** (`di-plugin` + `common` + `kernel` + `decorator-plugin` + `testing` — a compiled
  container and a request scope: typed tokens, boot-time graph validation, `forRequest` kept in
  `ctx.slot` and disposed through `ctx.defer`, the singleton-captures-scoped fix) — complete (PR
  #508).
- **Milestone 118** (`packages/cli` — `setu check`, a read-only wiring gate run by every generated
  `check` script, plus `setu sync`, stable finding ids and `.setu-ts/check.json` silencing) —
  complete (PR #510).
- **Milestone 120** (`packages/cli` — `setu build` (esbuild after the `setu check` gate), compiled
  Node starts with `start:dev`/`start:debug`, multi-stage production images for Node, Bun and Deno,
  Bun's hoisted linker for workspace libraries, Deno read-only start under `nodeModulesDir: "auto"`)
  — complete (PR #515).
- **Next milestone** — M119i (documentation that does not match the code, or is missing). M121–M123
  are open in the ROADMAP.

## Verification (run before declaring any work done)

```bash
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
```

These are the Node formatting, lint, type and root tooling gates. Package changes also require
`pnpm test` and `pnpm test:coverage` on Node 24, plus `pnpm run test:deno-lane` for the retained
Deno runtime proofs. `pnpm run test:tooling:coverage` measures root tooling. Every measured source
file must reach 90% branch/function/line. Root scripts and root tests share the `tooling` Vitest
coverage report; its per-file thresholds enforce the bar with a nonzero exit. The named Deno lane
enforces its own bar. Read the per-file tables as evidence.

For the edit loop, `pnpm test:coverage <members…>` measures those members and the Node tooling
target. Each member owns its source coverage, so a targeted failure is authoritative. A milestone
hands back the complete Node, Deno-lane, and root coverage reports.

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
pnpm run release:publish --dry-run  # pack, packed-manifest rules, npm lookup and publish dry run
pnpm run release:verify <version>  # versions, source workspace ranges, metadata, release contracts
```

M51 shipped three separate defects that every one of the four gates and the per-file coverage bar
passed over, each of which would have stopped the package being published. Each still has a gate:

- **A slow type.** `createDepthLimitRule` was exported from the barrel with an inferred return type,
  which blocks `.d.ts` generation. `isolatedDeclarations` in the `tsc -b` build now refuses it;
  every exported function needs a written-out return type.
- **A package in neither release list.** `packages/graphql-plugin` was a workspace member absent
  from both `PUBLISHED_PACKAGES` and `UNPUBLISHED_PACKAGES`, so it would simply never have
  published. Only `release:verify` looks for this.
- **A README suppressed on jsr.io.** A description-first module JSDoc replaced the README on the JSR
  page. npm always renders `README.md`, so M111c retired that check (`release:verify` check 5) in
  favour of "the README exists and is non-empty"; it still applies to versions on JSR.

Run both on a committed tree. M111c replaces the JSR publish dry run: `tsc -b` with
`isolatedDeclarations` covers its slow-type rule; non-empty README validation replaces JSR's
`@module`-first rendering rule. The publisher checks the exact tarball it hands to npm, including
internal dependency ranges, repository metadata, public access, and shipped sources and licence. Its
dry run also performs the packument lookup: the old dry run skipped it, which hid the missing
network permission that stopped `v0.1.0-alpha.2`. A green dry run still cannot prove OIDC or live
provenance; that proof belongs to the first npm cut after M111d.

**A milestone whose plan names a committed-tree security audit — or whose diff crosses a trust
boundary — is ALSO security-audited before it merges**, following
`.roo/skills/security-audit/SKILL.md` (Roo's `security-audit` mode runs it; Claude's local skill
points at the same file). It runs after verification and code review, on the exact commit the PR
will merge, in a context that did not implement or fix the milestone — a fresh Roo `new_task`
subtask or a freshly spawned Claude agent, handed only the milestone, branch, commit, plan and
existing reports; an audit run in the implementing context does not satisfy the gate — and it
produces the audit record the plan requires in the PR. The gates above cannot see what it checks:
every open M98 plan (98d–98n) requires one, and M98b shipped with its review explicitly unclaimed
because nothing defined what one was.

## Common pitfalls (these fail the gates)

- `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional property — omit it.
- The ESLint `@typescript-eslint/consistent-type-imports` rule requires `import type { … }` for
  type-only imports.
- `no-console` applies everywhere except `packages/cli` and `scripts/` (scripts use
  `/* eslint-disable no-console -- reason */`).
- Unused variables fail lint — delete them; do not underscore-prefix.
- Run `pnpm run fmt` before `pnpm run fmt:check`; it also reformats markdown — never hand-wrap
  tables.
- Coverage is per file, across branch, function, and line. The Node runner uses Vitest V8
  thresholds; Deno-only sources use the named Deno-lane gate; root tooling uses the `tooling`
  member's Vitest thresholds over the frozen script inventory. Inspect the reports before claiming
  completion.
- Use web-standard APIs in contracts (`Headers`, `SubtleCrypto`); runtime-specific shapes live
  behind `IRuntimeServices` only.
- `eval` and `new Function()` are forbidden (AI_GUIDELINES §13.5). ESLint enforces `no-eval` and a
  restricted-syntax rule for the Function constructor. To load Node builtins in `packages/runtime`,
  use static `node:` imports (Deno/Node/Bun all support them), never a smuggled `require`.
- **Never mix clocks.** `ctx.startTime` is `runtime.hrtime()` — a MONOTONIC reading
  (`performance.now()`, ms since an arbitrary origin), NOT a wall-clock epoch. Compute a request
  duration as `runtime.hrtime() - ctx.startTime` (both monotonic). `Date.now() - ctx.startTime`
  subtracts a small monotonic value from a ~1.7e12 epoch number, yielding a garbage duration on
  EVERY request (and tripping every slow-request threshold). Also: `Date.now()` is a runtime API —
  outside `packages/runtime`, get time only via `IRuntimeServices` (`runtime.now()` /
  `runtime.hrtime()`). The gates do NOT flag `Date.now()`, so this is on you.
- **A lazily-loaded optional dep must ACTUALLY load.** Use a real `await import('<pkg>')` with a
  literal bare package name (or a client/factory injected through plugin options, AI_GUIDELINES
  §12.2) — never a `globalThis.__x` hook that only tests populate. A global-hook "loader" throws in
  production even when the package IS installed, because nothing ever imports it: that is a
  non-functional shim, not a lazy import. If a real `import()` forces the construction path to be
  async, make it async (`register()` may return a `Promise`); do not fake a sync constructor with a
  global. **And the literal import is AWAITED inside the `try` block of a `try`/`catch` in the SAME
  function** (`mod = await import('ioredis')`, M113d): Wrangler bundles Workers with esbuild, which
  resolves a bare string-literal `import()` at build time, so an unguarded import fails every Worker
  that imports the package — even one that never loads the driver — and an unawaited import fails it
  even inside the `try` (measured: `const p = import('x')` and `Promise.all([import('x')])` both
  do). The `catch` throws `OptionalDependencyUnavailableError` (or the package's own named load
  error carrying it as `cause`); the M113d audit (`findUnguardedImports`) refuses the unguarded
  shape.

## Self-review checklist (bugs that slipped through before — check every time)

- **Per-file coverage, not aggregate**: every source file must reach 90% on branch, function, AND
  line. Read the ANSI-stripped Node, Deno-lane, and root-script tables. Any file below 90% means the
  task is unfinished. Package fixtures under `test/` are excluded from measurement; the Node host
  helper and runner tooling have their own measured target.
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
  PUBLIC_API.md must describe what the code actually does. "Lazily imported via `pino`" on a
  function that never imports pino, or "@throws if X cannot be loaded from npm" when it throws
  because it never tries, are lies that pass every gate. When you touch a doc claim, confirm the
  code path it describes actually executes. **And when a comment or doc claims a SET — these inputs
  are refused, these providers create on write, these brokers populate that field — the enumeration
  belongs in the test as data, not in the prose as a list.** A prose list can disagree with the code
  silently; a table the test iterates cannot. This is what the repo already does where it matters
  (`filter-conformance.test.ts` runs one query through every adapter but Cosmos, which is excluded
  deliberately and covered by a reduced table against the real service; M75's header-conformance
  runs one table over all seven brokers; M90h's secrets table marks each cell verified-or-not); the
  addition is that it applies to a COMMENT too. M90h shipped three successive comment-level
  inaccuracies in one file, each describing a guard whose code was correct — and the last conflated
  two variants the author had already measured correctly, so no probe-first discipline would have
  caught it. Grouping the values by their measured behavior is what made that comment unable to
  drift without a test failing.
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
- **Read coverage ANSI-stripped, per file, after EVERY change — including deletions.** The Vitest
  coverage table colorizes output; naive parsing misreads the numbers (a `[33m` prefix turned 75.9
  into a false "OK"). Pipe through `sed 's/\x1b\[[0-9;]*m//g'` and confirm every changed `src` file
  is ≥90% on branch, function, AND line. Vitest enforces per-file thresholds with a nonzero exit;
  still read the table to verify the measured files and coverage dimensions. Deleting or rewriting a
  test can drop an UNRELATED file below the bar, and the aggregate will hide it — re-check per file
  after refactors and deletions, not just additions. A file that lands exactly at 90 has no margin —
  prefer a couple of points of headroom.
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
- **Run the two publish gates on the committed tree.** `pnpm run release:publish --dry-run` and
  `pnpm run release:verify <version>` — see the Verification section for the three M51 defects that
  every other gate passed over. A milestone whose package cannot publish is not done, and CI's
  `npm publish dry-run` job will say so on the PR after you have handed it back.
- **Report the evidence.** When handing back, paste the ANSI-stripped per-file coverage table, the
  grep result, and the exit status of both publish gates. "Done" without that evidence is not done.
- **Flip the milestone's status IN the milestone PR, before it merges.** A completed milestone is
  not done until its ROADMAP.md "Progress Tracking" row is `✅` AND the CLAUDE.md "Current status"
  section reflects it (mark the finished milestone complete with its PR number and point "Next
  milestone" at the following one). These edits belong on the milestone's own `feat/…` branch and
  ship in the SAME PR as the code — a merged PR that left the tracking table at `⬜` is a defect. If
  you catch a merged milestone whose status was never flipped, correct it on a `fix/…` branch (it is
  a defect in already-merged `develop`), never by editing `develop` or `main` directly.
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
- Package tests use `describe`, `it`, hooks, and `expect` from `vitest` in
  `test/{unit,integration,e2e}/` and run on Node 24. Root `test/` also imports `vitest` and runs in
  the `tooling` member. Deno-only proofs use the same Vitest-shaped files through the Deno-lane
  import-map shim. Write in the runner style appropriate to that location from the first line;
  `Deno.test` remains banned.
- No plugin imports another plugin — communicate via `ctx.services.get<T>(CAPABILITIES.X)`.
- Heavy deps (Prisma, Redis clients, …) are never hard dependencies: injected via options or lazy
  bare-package imports (AI_GUIDELINES §12.2).
- **Two long-lived branches; PRs target `develop` except release and hotfix PRs, which target
  `main`.** `develop` is where milestones, fixes and docs integrate. `main` is the repository's
  DEFAULT branch, so a `gh pr create` without `--base` targets it — always pass `--base develop` (or
  `--base main` for a release or hotfix PR). `main` means "the last release": it moves only when a
  release PR merges, and each merge to `main` redeploys the public website (Cloudflare Workers
  Builds watches `main`). Both are protected by rulesets ("protect develop", "protect main"), which
  name each branch explicitly — never point one at `~DEFAULT_BRANCH`, since that silently moves
  protection when the default changes. The release flow is `docs/releasing.md`'s: cut
  `release/vX.Y.Z` from `develop`, PR it into `main` with a MERGE COMMIT (the `main` ruleset refuses
  squash and rebase, because either rewrites the history `develop` must share), tag that merge
  commit, then open a back-merge PR `main` → `develop`, also as a merge commit, so the release's
  version-bump commits reach `develop`. A defect in a PUBLISHED release that cannot wait for the
  next one goes on `hotfix/[issue]-[description]` cut from `main`, PRs into `main`, ships as a patch
  release, and back-merges the same way.
- **Every new task starts in a new worktree** —
  `git worktree add -b <branch> .claude/worktrees/<name> origin/develop` (`origin/main` for a
  hotfix), then work only inside it. The main checkout stays on `develop` and is never edited; a
  resumed task continues in the worktree that already holds its branch (`git worktree list`).
  `.claude/` is gitignored and invisible to Prettier and ESLint; never put a worktree in `/tmp` or
  beside the repository. Remove it with `git worktree remove` once its PR merges. AI_GUIDELINES
  §15.4 is canonical.
- Branches: one `feat/[milestone]-[description]` per milestone — all of that milestone's work and
  fixes stay on it until it merges; `fix/[issue]-[description]` is only for defects in
  already-merged `develop`; `docs/[description]` is for a documentation-only change that is not a
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
  the code comments are where the long reasoning goes; no direct commits to `develop` or `main`.
- **Pushing and opening the PR are yours to do — but only when asked.** Remote credentials ARE
  available (`gh auth status` reports a logged-in account; SSH for git operations), so `git push`
  and `gh pr create` work. This bullet previously said the opposite — that no credentials existed
  and any attempt would fail and waste time — which was stale: PRs #123 and #124 were pushed and
  opened this way. Do not push or open a PR unprompted, though: finish the milestone, report the
  evidence, and wait for the human to ask. Publishing a branch is outward-facing and their call to
  time.
- **A new non-`docs/…` PR requests its CodeRabbit review with a comment, once its head is final** —
  `gh pr comment <pr> --body '@coderabbitai review'`, posted AFTER the PR-number commit below has
  been pushed, never before it. CodeRabbit aborts a review whose head commit moves while it runs
  ("⚠️ Action not completed — Head commit changed.") and does not retry, which is how
  setu-ts/setu-ts#440 lost its first review; if a push lands mid-review, trigger it again.
  `.coderabbit.yaml` sets `auto_review.enabled: false` with no `labels` or `description_keyword`, so
  CodeRabbit never reviews on its own. Applies to `feat/…`, `fix/…`, `hotfix/…`, `release/…` and
  `chore/…` PRs; **`docs/…` PRs are excluded** (the review is for code) and so is a `main` →
  `develop` back-merge (already-reviewed commits). Automatic review was dropped when `main` became
  the default branch: it covers the default branch plus `base_branches`, so it would have to be
  re-scoped to `develop` and would then fire on `docs/…` PRs too — nothing in CodeRabbit's config
  excludes by HEAD branch. **The failure is silent**: `review_status: false` suppresses the "review
  skipped" notice, so a PR nobody asked to review looks exactly like one whose review has not
  arrived — check the comment was posted. A re-review after pushing fixes is another
  `@coderabbitai review`. Also attach the `maintainer-review` label to every such PR
  (`gh pr edit <pr> --add-label maintainer-review`) — the maintainer keeps it as the marker of a PR
  awaiting their review, though it no longer triggers CodeRabbit; the comment does. The repo file
  overrides the CodeRabbit dashboard, so the web toggle changes nothing. Fork PRs are proposals and
  are not reviewed (CONTRIBUTING.md). AI_GUIDELINES §16.7 is canonical.
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
  pending)" → push → `gh pr create` → edit the entry to the real number → commit and push again →
  only then post `@coderabbitai review` (see above). That second commit lands on the same branch
  before merge, so the merged history never carries "PR pending". Same for the ROADMAP row and the
  plan archival — all of it ships in the milestone's own PR (see "Before reporting a task done").
