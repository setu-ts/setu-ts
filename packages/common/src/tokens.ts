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

declare const capabilityBrand: unique symbol;
/**
 * Required singleton-token brand, imported only in type positions.
 * @internal
 * @since 0.13.0
 */
export declare const serviceBrand: unique symbol;
declare const requestServiceBrand: unique symbol;

/**
 * A standard capability string carrying its key as a required type-only brand.
 * Registry overloads use the key to infer the service from `CapabilityServices`;
 * a plain string cannot stand in for a branded standard token.
 *
 * @typeParam K - The standard capability's string value
 * @example
 * ```typescript
 * const token: StandardCapabilityToken<'logger'> = CAPABILITIES.LOGGER;
 * const logger = services.get(token);
 * ```
 * @since 0.13.0
 */
export type StandardCapabilityToken<K extends string> = K & { readonly [capabilityBrand]: K };

/**
 * A capability token carrying the service type produced by a request-bound
 * registration. The required brand keeps it distinct from singleton tokens.
 * Register a `RequestBoundService<T>` wrapper under it, then resolve the
 * request's instance with `resolveRequestService` or React Router's `getService`.
 * Raw registry `get` and `getAll` calls refuse this token at compile time.
 *
 * @typeParam T - The service built for each request
 * @example
 * ```typescript
 * const PRODUCTS = requestServiceToken<ProductsService>('module.products');
 * services.register(PRODUCTS, requestService(productsService));
 * const products = resolveRequestService(ctx, PRODUCTS);
 * ```
 * @since 0.13.0
 */
export type RequestServiceToken<T> = string & { readonly [requestServiceBrand]: T };

/**
 * A custom or derived string token without a standard, singleton-service or
 * request-service brand. Registry and request-resolver overloads accept an
 * explicit service type for these tokens because no interface binding is known.
 * The optional `never` properties exclude all three branded token kinds from
 * this fallback overload.
 *
 * @example
 * ```typescript
 * const CUSTOM: UnboundToken = createCapabilityToken('acme.cache');
 * const cache = services.get<ICacheStore>(CUSTOM);
 * ```
 * @since 0.13.0
 */
export type UnboundToken = string & {
  readonly [capabilityBrand]?: never;
  readonly [serviceBrand]?: never;
  readonly [requestServiceBrand]?: never;
};

/**
 * Standard capability tokens provided by the first-party plugins.
 *
 * Consumers must reference tokens through this constant rather than repeating
 * string literals. Each value carries its capability key at the type level,
 * allowing the registry to infer the bound service interface.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES } from '@setu-ts/common';
 *
 * const logger = ctx.services.get(CAPABILITIES.LOGGER);
 * ```
 *
 * @since 0.1.0
 */
export const CAPABILITIES = {
  /** Durable agent-run service (IAgentRunService). */
  AGENT_RUNS: 'agent-runs' as StandardCapabilityToken<'agent-runs'>,
  /** Runtime services provided by the RuntimePlugin. Mandatory in every application. */
  RUNTIME: 'runtime' as StandardCapabilityToken<'runtime'>,
  /** Structured logger. */
  LOGGER: 'logger' as StandardCapabilityToken<'logger'>,
  /** Configuration access. */
  CONFIG: 'config' as StandardCapabilityToken<'config'>,
  /** Request/data validation. */
  VALIDATION: 'validation' as StandardCapabilityToken<'validation'>,
  /** Database access (repositories, unit of work). */
  DATABASE: 'database' as StandardCapabilityToken<'database'>,
  /** Key/value caching. */
  CACHE: 'cache' as StandardCapabilityToken<'cache'>,
  /** In-memory domain event bus. */
  EVENTS: 'events' as StandardCapabilityToken<'events'>,
  /** Message broker for integration events. */
  MESSAGING: 'messaging' as StandardCapabilityToken<'messaging'>,
  /** Authentication service. */
  AUTH: 'authentication' as StandardCapabilityToken<'authentication'>,
  /** Authorization service (RBAC, permissions). */
  AUTHORIZATION: 'authorization' as StandardCapabilityToken<'authorization'>,
  /**
   * Authorization policies — an `IAuthorizationPolicyService` the AuthPlugin
   * always registers: an asynchronous, target-aware check over named
   * policies, beside (never replacing) the synchronous RBAC service under
   * `AUTHORIZATION`. Consumed by the `requirePolicy` guard and by
   * DecoratorPlugin's `@RequirePolicy` and class-form policies.
   *
   * @since 0.9.0
   */
  AUTHORIZATION_POLICIES:
    'authorization-policies' as StandardCapabilityToken<'authorization-policies'>,
  /** JWT sign/verify service. */
  JWT: 'jwt' as StandardCapabilityToken<'jwt'>,
  /**
   * The single owner of "this session is signed in as this principal" — an
   * `IAuthSessionService` the AuthPlugin registers when its `signIn` option is
   * configured. Every later authentication feature (second factor, passkeys,
   * SAML) creates, holds back, or promotes that one record through this token,
   * instead of each keeping a private copy of the same session write.
   *
   * @since 0.8.0
   */
  AUTH_SESSION: 'auth-session' as StandardCapabilityToken<'auth-session'>,
  /** Job scheduling (cron, delayed, recurring). */
  SCHEDULER: 'scheduler' as StandardCapabilityToken<'scheduler'>,
  /** Metrics collection. */
  METRICS: 'metrics' as StandardCapabilityToken<'metrics'>,
  /** Health checks. */
  HEALTH: 'health' as StandardCapabilityToken<'health'>,
  /** OpenAPI spec contribution and generation. */
  OPENAPI: 'openapi' as StandardCapabilityToken<'openapi'>,
  /** Distributed tracing. */
  TELEMETRY: 'telemetry' as StandardCapabilityToken<'telemetry'>,
  /** Secret management. */
  SECRETS: 'secrets' as StandardCapabilityToken<'secrets'>,
  /** Audit trail logging. */
  AUDIT: 'audit' as StandardCapabilityToken<'audit'>,
  /** Resilience patterns (circuit breaker, retry, timeout, bulkhead). */
  RESILIENCE: 'resilience' as StandardCapabilityToken<'resilience'>,
  /** File storage. */
  STORAGE: 'storage' as StandardCapabilityToken<'storage'>,
  /** Email sending. */
  MAIL: 'mail' as StandardCapabilityToken<'mail'>,
  /** Multi-channel notifications. */
  NOTIFICATION: 'notification' as StandardCapabilityToken<'notification'>,
  /** Feature flag evaluation. */
  FEATURE_FLAGS: 'feature-flags' as StandardCapabilityToken<'feature-flags'>,
  /** Background job queue. */
  QUEUE: 'queue' as StandardCapabilityToken<'queue'>,
  /** CQRS facade. */
  CQRS: 'cqrs' as StandardCapabilityToken<'cqrs'>,
  /** Command bus (CQRS). */
  COMMAND_BUS: 'command-bus' as StandardCapabilityToken<'command-bus'>,
  /** Query bus (CQRS). */
  QUERY_BUS: 'query-bus' as StandardCapabilityToken<'query-bus'>,
  /** Multi-tenancy service. */
  MULTI_TENANCY: 'multi-tenancy' as StandardCapabilityToken<'multi-tenancy'>,
  /** Worker-thread pool for CPU-bound tasks. */
  WORKER_POOL: 'worker-pool' as StandardCapabilityToken<'worker-pool'>,
  /** Optional dependency injection container. */
  DI_CONTAINER: 'di-container' as StandardCapabilityToken<'di-container'>,
  /** HTTP server adapter — the runtime plugin registers its IHttpAdapter here. */
  HTTP_ADAPTER: 'http-adapter' as StandardCapabilityToken<'http-adapter'>,
  /** Server-Sent Events (SSE) hub for in-process real-time broadcasting. */
  SSE: 'sse' as StandardCapabilityToken<'sse'>,
  /** WebSocket hub for bidirectional real-time messaging. */
  WEBSOCKET: 'websocket' as StandardCapabilityToken<'websocket'>,
  /**
   * Pub/sub transport carrying real-time broadcasts between application
   * instances, so WebSocket rooms and SSE channels fan out across replicas.
   * Consumed optionally — absent means purely in-process broadcasting.
   */
  REALTIME_BACKPLANE: 'realtime-backplane' as StandardCapabilityToken<'realtime-backplane'>,
  /** Server-side rendering (SSR) — React Router or similar framework. */
  SSR: 'ssr' as StandardCapabilityToken<'ssr'>,
  /** Cookie-backed sessions for server-rendered applications. */
  SESSION: 'session' as StandardCapabilityToken<'session'>,
  /** Service discovery — logical service name to reachable instances. */
  SERVICE_DISCOVERY: 'service-discovery' as StandardCapabilityToken<'service-discovery'>,
  /** Health indicator contributions (multi-provider). */
  HEALTH_INDICATOR: 'health-indicator' as StandardCapabilityToken<'health-indicator'>,
  /**
   * Minimized health observations (M98d) — an `IHealthDiagnosticsSource` the
   * HealthPlugin registers under this token and the DiagnosticsPlugin
   * consumes optionally to serve `GET /v1/health`. Absent means the
   * connector answers a typed `unsupported` snapshot; it never runs an
   * indicator itself.
   */
  HEALTH_DIAGNOSTICS: 'health-diagnostics' as StandardCapabilityToken<'health-diagnostics'>,
  /**
   * Value-free configuration provenance (M98e) — an `IConfigDiagnosticsSource`
   * the ConfigPlugin registers under this token and the DiagnosticsPlugin
   * consumes optionally to serve `GET /v1/config`. Absent means the connector
   * answers a typed `unsupported` snapshot; it never reads a configuration
   * value, enumerates keys, or invokes a custom `IConfig` implementation.
   */
  CONFIG_DIAGNOSTICS: 'config-diagnostics' as StandardCapabilityToken<'config-diagnostics'>,
  /**
   * Minimized queue observations (M98f) — an `IQueueDiagnosticsSource` every
   * QueuePlugin instance registers under this token with `{ multi: true }`,
   * without claiming it in `provides`, so named queue instances never collide.
   * The DiagnosticsPlugin reads every source to serve `GET /v1/queues`; no
   * registered source means the connector answers a typed `unsupported`
   * batch. A read never reserves, settles or counts a job.
   */
  QUEUE_DIAGNOSTICS: 'queue-diagnostics' as StandardCapabilityToken<'queue-diagnostics'>,
  /**
   * Minimized distributed-tracing observations (M98g) — an
   * `ITraceDiagnosticsSource` the TelemetryPlugin always registers under
   * this token (a `disabled` or `unsupported`-answering one when observation
   * was not opted into or the tracing stack cannot supply completed spans).
   * The DiagnosticsPlugin consumes it optionally to serve `GET /v1/traces`.
   * A read never starts, exports or flushes a span.
   */
  TRACE_DIAGNOSTICS: 'trace-diagnostics' as StandardCapabilityToken<'trace-diagnostics'>,
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
  AUTHORIZATION_DIAGNOSTICS:
    'authorization-diagnostics' as StandardCapabilityToken<'authorization-diagnostics'>,
  /**
   * Minimized cache operation counters (M98i) — an `ICacheDiagnosticsSource`
   * every CachePlugin instance registers under this token with
   * `{ multi: true }`, without claiming it in `provides`, so named cache
   * instances never collide. The DiagnosticsPlugin reads every source to serve
   * `GET /v1/cache`. A read never performs a cache operation.
   */
  CACHE_DIAGNOSTICS: 'cache-diagnostics' as StandardCapabilityToken<'cache-diagnostics'>,
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
  SCHEDULER_DIAGNOSTICS:
    'scheduler-diagnostics' as StandardCapabilityToken<'scheduler-diagnostics'>,
  /**
   * Minimized event-dispatch observations (M98j) — an
   * `IEventDiagnosticsSource` every EventsPlugin instance registers under
   * this token with `{ multi: true }`, without claiming it in `provides`, so
   * multiple bus instances never collide. The DiagnosticsPlugin reads every
   * source to serve `GET /v1/event`; no registered source means the
   * connector answers a typed `unsupported` response. A read never
   * publishes an event or invokes a handler.
   */
  EVENTS_DIAGNOSTICS: 'event-diagnostics' as StandardCapabilityToken<'event-diagnostics'>,
  /**
   * Minimized realtime lifecycle observations (M98l) — an
   * `IRealtimeDiagnosticsSource` the WebSocket, SSE and realtime-backplane
   * plugins each register under this token with `{ multi: true }`, without
   * claiming it in `provides`. The DiagnosticsPlugin reads every source to
   * serve `GET /v1/realtime`; no registered source means the connector answers
   * a typed `unsupported` response. A read never sends, closes, publishes,
   * subscribes, or creates or enumerates a room or channel.
   */
  REALTIME_DIAGNOSTICS: 'realtime-diagnostics' as StandardCapabilityToken<'realtime-diagnostics'>,
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
  OUTBOUND_HTTP_DIAGNOSTICS:
    'outbound-http-diagnostics' as StandardCapabilityToken<'outbound-http-diagnostics'>,
  /**
   * Minimized storage operation observations (M98m) — an
   * `IStorageDiagnosticsSource` every StoragePlugin instance registers under
   * this token with `{ multi: true }`, without claiming it in `provides`, so
   * multiple storage instances never collide. The DiagnosticsPlugin reads
   * every source to serve `GET /v1/storage`; no registered source means the
   * connector answers a typed `unsupported` response. A read never performs a
   * storage operation, resolves the storage capability, or probes a backend.
   */
  STORAGE_DIAGNOSTICS: 'storage-diagnostics' as StandardCapabilityToken<'storage-diagnostics'>,
  /** Metric registration contributions (multi-provider). */
  METRIC_REGISTRATION: 'metric-registration' as StandardCapabilityToken<'metric-registration'>,
  /** OpenAPI schema contributions (multi-provider). */
  OPENAPI_SCHEMA: 'openapi-schema' as StandardCapabilityToken<'openapi-schema'>,
  /** CLI command contributions (multi-provider). */
  CLI_COMMAND: 'cli-command' as StandardCapabilityToken<'cli-command'>,
  /** Decorator handler contributions (multi-provider). */
  DECORATOR_HANDLER: 'decorator-handler' as StandardCapabilityToken<'decorator-handler'>,
  /** Decorator metadata store (from the DecoratorPlugin, when registered). */
  METADATA_STORE: 'metadata-store' as StandardCapabilityToken<'metadata-store'>,
  /** gRPC plugin — server-side Connect/gRPC/gRPC-Web co-serving. */
  GRPC: 'grpc' as StandardCapabilityToken<'grpc'>,
  /**
   * Cloudflare Workers platform bindings (KV, R2, D1, Queues, service and
   * Durable Object namespaces) published as one typed accessor.
   */
  CLOUDFLARE: 'cloudflare' as StandardCapabilityToken<'cloudflare'>,
  /** GraphQL plugin — schema-first and code-first GraphQL-over-HTTP. */
  GRAPHQL: 'graphql' as StandardCapabilityToken<'graphql'>,
  /** Static file serving plugin. */
  STATIC_FILES: 'static-files' as StandardCapabilityToken<'static-files'>,
  /**
   * View rendering (server-rendered HTML) — an `IViewEngine` that turns a
   * view component and its props into an HTML string, so a handler can answer
   * with markup it did not concatenate by hand.
   */
  VIEW: 'view' as StandardCapabilityToken<'view'>,
  /**
   * Localization — an `ILocalizer` holding the application's message
   * catalogues per locale, bound to a request's resolved `IRequest.locale`
   * through the localization plugin's `localizerFor(ctx)`.
   */
  LOCALIZATION: 'localization' as StandardCapabilityToken<'localization'>,
  /**
   * Transactional outbox — the `IOutbox` the messaging plugin registers when
   * its `outbox` option is set (`outbox.<name>` for a named messaging
   * instance). Writes an integration event in the caller's own database
   * transaction and relays it to the broker afterwards.
   *
   * @since 0.9.0
   */
  OUTBOX: 'outbox' as StandardCapabilityToken<'outbox'>,
  /**
   * Consumer inbox — the `IInbox` the messaging plugin registers when its
   * `inbox` option is set (`inbox.<name>` for a named messaging instance).
   * Records each handled integration event in the handler's own database
   * transaction, so a duplicate delivery is acknowledged without running the
   * handler again.
   *
   * @since 0.9.0
   */
  INBOX: 'inbox' as StandardCapabilityToken<'inbox'>,
  /**
   * Idempotency — an `IIdempotencyService` whose `middleware` and `behavior`
   * members build the HTTP and ingress idempotency paths over one store. The
   * request/reply types and the entry points live in
   * `@setu-ts/idempotency-plugin`; only the port, the service contract, the
   * option types and this token live in `common`.
   */
  IDEMPOTENCY: 'idempotency' as StandardCapabilityToken<'idempotency'>,
  /**
   * Runtime-owned local diagnostics listener — the single IPv4-loopback port
   * the RuntimePlugin can bind for the local diagnostics connector
   * (`ILocalDiagnosticsListenerFactory`). Provided by the RuntimePlugin;
   * consumed by the DiagnosticsPlugin. Not a generic second HTTP server API.
   */
  LOCAL_DIAGNOSTICS_LISTENER:
    'local-diagnostics-listener' as StandardCapabilityToken<'local-diagnostics-listener'>,
  /**
   * Vector store — tenant-scoped similarity search (`IVectorStore`). Provided
   * by `@setu-ts/vector-store-plugin`; every data method takes the tenant scope
   * as a required argument.
   */
  VECTOR_STORE: 'vector-store' as StandardCapabilityToken<'vector-store'>,
} as const;

/**
 * Union of all standard capability token values, including their type-only
 * brands. Use `CapabilityKey` when an unbranded key union is needed.
 *
 * @since 0.1.0
 */
export type StandardCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * The plain string union underlying the branded `StandardCapability` values.
 * Used to compute which standard keys lack an interface in `CapabilityServices`.
 *
 * @since 0.13.0
 */
export type CapabilityKey = StandardCapability extends StandardCapabilityToken<infer K> ? K : never;

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
