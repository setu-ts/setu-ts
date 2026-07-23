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
 * import { CAPABILITIES } from '@hono-enterprise/common';
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
  /** Optional dependency injection container. */
  DI_CONTAINER: 'di-container',
  /** HTTP server adapter — the runtime plugin registers its IHttpAdapter here. */
  HTTP_ADAPTER: 'http-adapter',
  /** Server-Sent Events (SSE) hub for in-process real-time broadcasting. */
  SSE: 'sse',
  /** Server-side rendering (SSR) — React Router or similar framework. */
  SSR: 'ssr',
  /** Health indicator contributions (multi-provider). */
  HEALTH_INDICATOR: 'health-indicator',
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
} as const;

/**
 * Union of all standard capability token values.
 *
 * @since 0.1.0
 */
export type StandardCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

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
  const segment = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
  const pattern = new RegExp(`^${segment}(?:\\.${segment})*$`);
  if (!pattern.test(name)) {
    throw new TypeError(
      `Invalid capability token "${name}": tokens must be lowercase kebab-case, ` +
        `optionally namespaced with dots (e.g. "my-capability" or "vendor.my-capability").`,
    );
  }
  return name;
}
