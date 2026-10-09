/**
 * Capability tokens — the string identifiers plugins use to publish and
 * resolve services through the service registry.
 *
 * This module is the single source of truth for capability tokens
 * (AI_GUIDELINES §11.2). Every token used anywhere in the framework must
 * either appear in {@linkcode CAPABILITIES} or be created through
 * {@linkcode createCapabilityToken}.
 *
 * @module
 */

/**
 * A capability token: a lowercase kebab-case string that identifies a
 * capability, not a concrete type.
 *
 * Plugins communicate exclusively via capability tokens resolved through the
 * service registry, which keeps them decoupled and independently replaceable.
 *
 * @since 0.1.0
 */
export type CapabilityToken = string;

/**
 * Standard capability tokens provided by the first-party plugins.
 *
 * Consumers must reference tokens through this constant rather than repeating
 * string literals:
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
 * ```
 *
 * @since 0.1.0
 */
export const CAPABILITIES = {
  /** Runtime services provided by the RuntimePlugin. Mandatory in every application. */
  RUNTIME: 'runtime',
  /** Structured logger. */
  LOGGER: 'logger',
  /** Configuration access. */
  CONFIG: 'config',
  /** Request/data validation. */
  VALIDATION: 'validation',
  /** Database access (repositories, unit of work). */
  DATABASE: 'database',
  /** Key/value caching. */
  CACHE: 'cache',
  /** In-memory domain event bus. */
  EVENTS: 'events',
  /** Message broker for integration events. */
  MESSAGING: 'messaging',
  /** Authentication service. */
  AUTH: 'authentication',
  /** Authorization service (RBAC, permissions). */
  AUTHORIZATION: 'authorization',
  /** JWT sign/verify service. */
  JWT: 'jwt',
  /**
   * The single owner of "this session is signed in as this principal" — an
   * `IAuthSessionService` the AuthPlugin registers when its `signIn` option is
   * configured. Every later authentication feature (second factor, passkeys,
   * SAML) creates, holds back, or promotes that one record through this token,
   * instead of each keeping a private copy of the same session write.
   *
   * @since 0.8.0
   */
  AUTH_SESSION: 'auth-session',
  /** Job scheduling (cron, delayed, recurring). */
  SCHEDULER: 'scheduler',
  /** Metrics collection. */
  METRICS: 'metrics',
  /** Health checks. */
  HEALTH: 'health',
  /** OpenAPI spec contribution and generation. */
  OPENAPI: 'openapi',
  /** Distributed tracing. */
  TELEMETRY: 'telemetry',
  /** Secret management. */
  SECRETS: 'secrets',
  /** Audit trail logging. */
  AUDIT: 'audit',
  /** Resilience patterns (circuit breaker, retry, timeout, bulkhead). */
  RESILIENCE: 'resilience',
  /** File storage. */
  STORAGE: 'storage',
  /** Email sending. */
  MAIL: 'mail',
  /** Multi-channel notifications. */
  NOTIFICATION: 'notification',
  /** Feature flag evaluation. */
  FEATURE_FLAGS: 'feature-flags',
  /** Background job queue. */
  QUEUE: 'queue',
  /** CQRS facade. */
  CQRS: 'cqrs',
  /** Command bus (CQRS). */
  COMMAND_BUS: 'command-bus',
  /** Query bus (CQRS). */
  QUERY_BUS: 'query-bus',
  /** Multi-tenancy service. */
  MULTI_TENANCY: 'multi-tenancy',
  /** Worker-thread pool for CPU-bound tasks. */
  WORKER_POOL: 'worker-pool',
  /** Optional dependency injection container. */
  DI_CONTAINER: 'di-container',
  /** HTTP server adapter — the runtime plugin registers its IHttpAdapter here. */
  HTTP_ADAPTER: 'http-adapter',
  /** Server-Sent Events (SSE) hub for in-process real-time broadcasting. */
  SSE: 'sse',
  /** WebSocket hub for bidirectional real-time messaging. */
  WEBSOCKET: 'websocket',
  /**
   * Pub/sub transport carrying real-time broadcasts between application
   * instances, so WebSocket rooms and SSE channels fan out across replicas.
   * Consumed optionally — absent means purely in-process broadcasting.
   */
  REALTIME_BACKPLANE: 'realtime-backplane',
  /** Server-side rendering (SSR) — React Router or similar framework. */
  SSR: 'ssr',
  /** Cookie-backed sessions for server-rendered applications. */
  SESSION: 'session',
  /** Service discovery — logical service name to reachable instances. */
  SERVICE_DISCOVERY: 'service-discovery',
  /** Health indicator contributions (multi-provider). */
  HEALTH_INDICATOR: 'health-indicator',
  /**
   * Minimized health observations (M98d) — an `IHealthDiagnosticsSource` the
   * HealthPlugin registers under this token and the DiagnosticsPlugin
   * consumes optionally to serve `GET /v1/health`. Absent means the
   * connector answers a typed `unsupported` snapshot; it never runs an
   * indicator itself.
   */
  HEALTH_DIAGNOSTICS: 'health-diagnostics',
  /**
   * Value-free configuration provenance (M98e) — an `IConfigDiagnosticsSource`
   * the ConfigPlugin registers under this token and the DiagnosticsPlugin
   * consumes optionally to serve `GET /v1/config`. Absent means the connector
   * answers a typed `unsupported` snapshot; it never reads a configuration
   * value, enumerates keys, or invokes a custom `IConfig` implementation.
   */
  CONFIG_DIAGNOSTICS: 'config-diagnostics',
  /**
   * Minimized queue observations (M98f) — an `IQueueDiagnosticsSource` every
   * QueuePlugin instance registers under this token with `{ multi: true }`,
   * without claiming it in `provides`, so named queue instances never collide.
   * The DiagnosticsPlugin reads every source to serve `GET /v1/queues`; no
   * registered source means the connector answers a typed `unsupported`
   * batch. A read never reserves, settles or counts a job.
   */
  QUEUE_DIAGNOSTICS: 'queue-diagnostics',
  /**
   * Minimized distributed-tracing observations (M98g) — an
   * `ITraceDiagnosticsSource` the TelemetryPlugin always registers under
   * this token (a `disabled` or `unsupported`-answering one when observation
   * was not opted into or the tracing stack cannot supply completed spans).
   * The DiagnosticsPlugin consumes it optionally to serve `GET /v1/traces`.
   * A read never starts, exports or flushes a span.
   */
  TRACE_DIAGNOSTICS: 'trace-diagnostics',
  /**
   * Authorization decision explanations (M98h) — an
   * `IAuthorizationDiagnosticsSource` the AuthPlugin always registers under
   * this token (a `disabled`-answering one when observation was not opted
   * into; an `unsupported`-answering one when RBAC is absent, the registry
   * lacks the non-resolving identity predicate, or the authorization provider
   * was replaced). The DiagnosticsPlugin consumes it
   * optionally to serve `GET /v1/authorization`. A read never evaluates a
   * role, permission or wildcard, and never resolves a service.
   */
  AUTHORIZATION_DIAGNOSTICS: 'authorization-diagnostics',
  /**
   * Minimized cache operation counters (M98i) — an `ICacheDiagnosticsSource`
   * every CachePlugin instance registers under this token with
   * `{ multi: true }`, without claiming it in `provides`, so named cache
   * instances never collide. The DiagnosticsPlugin reads every source to serve
   * `GET /v1/cache`. A read never performs a cache operation.
   */
  CACHE_DIAGNOSTICS: 'cache-diagnostics',
  /**
   * Scheduler execution observations (M98k) — an
   * `ISchedulerDiagnosticsSource` every SchedulerPlugin instance registers
   * under this token with `{ multi: true }`, without claiming it in
   * `provides`, so the diagnostics token never collides with another
   * provider of it (an application registers at most one SchedulerPlugin —
   * its plugin name is fixed — but other code may contribute a source). The
   * DiagnosticsPlugin reads every source to serve `GET /v1/scheduler`. A
   * read never acquires a lock, invokes a handler, or claims cluster
   * completeness — a skipped local fire is not a globally missed execution.
   */
  SCHEDULER_DIAGNOSTICS: 'scheduler-diagnostics',
  /**
   * Minimized event-dispatch observations (M98j) — an
   * `IEventDiagnosticsSource` every EventsPlugin instance registers under
   * this token with `{ multi: true }`, without claiming it in `provides`, so
   * multiple bus instances never collide. The DiagnosticsPlugin reads every
   * source to serve `GET /v1/event`; no registered source means the
   * connector answers a typed `unsupported` response. A read never
   * publishes an event or invokes a handler.
   */
  EVENTS_DIAGNOSTICS: 'event-diagnostics',
  /**
   * Minimized realtime lifecycle observations (M98l) — an
   * `IRealtimeDiagnosticsSource` the WebSocket, SSE and realtime-backplane
   * plugins each register under this token with `{ multi: true }`, without
   * claiming it in `provides`. The DiagnosticsPlugin reads every source to
   * serve `GET /v1/realtime`; no registered source means the connector answers
   * a typed `unsupported` response. A read never sends, closes, publishes,
   * subscribes, or creates or enumerates a room or channel.
   */
  REALTIME_DIAGNOSTICS: 'realtime-diagnostics',
  /**
   * Minimized outbound HTTP attempt observations (M98n) — an
   * `IOutboundHttpDiagnosticsSource` the SDK's `createObservedFetch` helper
   * registers, through its returned plugin, under this token with
   * `{ multi: true }` and without claiming it in `provides`. The SDK writes
   * this value as a literal (so its `common` imports stay type-only), pinned
   * by a test. The DiagnosticsPlugin reads every source to serve
   * `GET /v1/outbound-http`; no registered source means a typed
   * `unsupported` response. A read never performs a request.
   */
  OUTBOUND_HTTP_DIAGNOSTICS: 'outbound-http-diagnostics',
  /**
   * Minimized storage operation observations (M98m) — an
   * `IStorageDiagnosticsSource` every StoragePlugin instance registers under
   * this token with `{ multi: true }`, without claiming it in `provides`, so
   * multiple storage instances never collide. The DiagnosticsPlugin reads
   * every source to serve `GET /v1/storage`; no registered source means the
   * connector answers a typed `unsupported` response. A read never performs a
   * storage operation, resolves the storage capability, or probes a backend.
   */
  STORAGE_DIAGNOSTICS: 'storage-diagnostics',
  /** Metric registration contributions (multi-provider). */
  METRIC_REGISTRATION: 'metric-registration',
  /** OpenAPI schema contributions (multi-provider). */
  OPENAPI_SCHEMA: 'openapi-schema',
  /** CLI command contributions (multi-provider). */
  CLI_COMMAND: 'cli-command',
  /** Decorator handler contributions (multi-provider). */
  DECORATOR_HANDLER: 'decorator-handler',
  /** Decorator metadata store (from the DecoratorPlugin, when registered). */
  METADATA_STORE: 'metadata-store',
  /** gRPC plugin — server-side Connect/gRPC/gRPC-Web co-serving. */
  GRPC: 'grpc',
  /**
   * Cloudflare Workers platform bindings (KV, R2, D1, Queues, service and
   * Durable Object namespaces) published as one typed accessor.
   */
  CLOUDFLARE: 'cloudflare',
  /** GraphQL plugin — schema-first and code-first GraphQL-over-HTTP. */
  GRAPHQL: 'graphql',
  /** Static file serving plugin. */
  STATIC_FILES: 'static-files',
  /**
   * View rendering (server-rendered HTML) — an `IViewEngine` that turns a
   * view component and its props into an HTML string, so a handler can answer
   * with markup it did not concatenate by hand.
   */
  VIEW: 'view',
  /**
   * Localization — an `ILocalizer` holding the application's message
   * catalogues per locale, bound to a request's resolved `IRequest.locale`
   * through the localization plugin's `localizerFor(ctx)`.
   */
  LOCALIZATION: 'localization',
  /**
   * Transactional outbox — the `IOutbox` the messaging plugin registers when
   * its `outbox` option is set (`outbox.<name>` for a named messaging
   * instance). Writes an integration event in the caller's own database
   * transaction and relays it to the broker afterwards.
   *
   * @since 0.9.0
   */
  OUTBOX: 'outbox',
  /**
   * Idempotency — an `IIdempotencyService` whose `middleware` and `behavior`
   * members build the HTTP and ingress idempotency paths over one store. The
   * request/reply types and the entry points live in
   * `@setu-ts/idempotency-plugin`; only the port, the service contract, the
   * option types and this token live in `common`.
   */
  IDEMPOTENCY: 'idempotency',
  /**
   * Runtime-owned local diagnostics listener — the single IPv4-loopback port
   * the RuntimePlugin can bind for the local diagnostics connector
   * (`ILocalDiagnosticsListenerFactory`). Provided by the RuntimePlugin;
   * consumed by the DiagnosticsPlugin. Not a generic second HTTP server API.
   */
  LOCAL_DIAGNOSTICS_LISTENER: 'local-diagnostics-listener',
} as const;

/**
 * Union of all standard capability token values.
 *
 * @since 0.1.0
 */
export type StandardCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * One kebab-case segment of a token: a lowercase letter, then lowercase
 * alphanumerics, then any number of `-`-joined alphanumeric groups.
 */
const TOKEN_SEGMENT = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

/**
 * The full token grammar: one or more {@linkcode TOKEN_SEGMENT}s joined by
 * dots. Compiled once at module load rather than per
 * {@linkcode createCapabilityToken} call.
 */
const TOKEN_PATTERN = new RegExp(`^${TOKEN_SEGMENT}(?:\\.${TOKEN_SEGMENT})*$`);

/**
 * Creates a custom capability token for third-party plugins.
 *
 * Tokens must be lowercase kebab-case (`my-capability`). Namespacing by
 * vendor is recommended for community plugins to avoid collisions with
 * standard tokens (`acme.payment-gateway`).
 *
 * @param name - The token name; lowercase kebab-case segments, optionally
 * separated by dots for namespacing
 * @returns The validated capability token
 * @throws {TypeError} If the name is not lowercase kebab-case
 * @example
 * ```typescript
 * const PAYMENTS = createCapabilityToken('acme.payment-gateway');
 * ctx.services.register(PAYMENTS, new StripeGateway());
 * ```
 * @since 0.1.0
 */
export function createCapabilityToken(name: string): CapabilityToken {
  if (!TOKEN_PATTERN.test(name)) {
    throw new TypeError(
      `Invalid capability token "${name}": tokens must be lowercase kebab-case, ` +
        `optionally namespaced with dots (e.g. "my-capability" or "vendor.my-capability").`,
    );
  }
  return name;
}
