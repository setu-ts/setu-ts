/** Package discovery data shipped with the CLI; root tooling refuses metadata drift. */
import type { CAPABILITIES } from '@setu-ts/common';

/** A published library's npm description and the capability keys it provides. */
export interface IPackageData {
  readonly description: string;
  readonly tokens: readonly (keyof typeof CAPABILITIES)[];
}

/**
 * Published packages that are run rather than imported, and so ship no card: a
 * project may depend on the CLI (for `npx setu`), but it is a tool, not a
 * library the brief should point an agent at.
 */
export const TOOLING_PACKAGES: ReadonlySet<string> = new Set(['cli', 'create']);

/** Bare package names, including non-addable starters and diagnostics. */
export const PACKAGE_DATA: ReadonlyMap<string, IPackageData> = new Map<string, IPackageData>([
  [
    'common',
    {
      description:
        'Shared contracts, capability tokens, and pure codecs every Setu-TS package builds on',
      tokens: [],
    },
  ],
  [
    'kernel',
    {
      description: 'Capability-token plugin kernel: service registry, middleware pipeline, router',
      tokens: [],
    },
  ],
  [
    'runtime',
    {
      description:
        'Runtime services and HTTP adapters for Node.js, Deno, Bun, and Cloudflare Workers',
      tokens: ['RUNTIME', 'HTTP_ADAPTER', 'LOCAL_DIAGNOSTICS_LISTENER'],
    },
  ],
  [
    'testing',
    {
      description: 'Test app factory, mock plugins, and request injection for Setu-TS',
      tokens: [],
    },
  ],
  [
    'exceptions',
    {
      description:
        'Exception hierarchy, RFC 9457 Problem Details, and the error-handler middleware',
      tokens: [],
    },
  ],
  [
    'sdk',
    {
      description:
        'Portable HTTP client with retry, circuit breaker, rate limiting, and OpenAPI codegen',
      tokens: ['OUTBOUND_HTTP_DIAGNOSTICS'],
    },
  ],
  [
    'audit-plugin',
    {
      description: 'Immutable audit trail over memory, log, database, or file storage',
      tokens: ['AUDIT'],
    },
  ],
  [
    'auth-plugin',
    {
      description:
        'JWT via Web Crypto, API keys, refresh tokens, RBAC, and rate limiting — zero npm dependencies',
      tokens: [
        'AUTH',
        'AUTHORIZATION',
        'AUTHORIZATION_POLICIES',
        'JWT',
        'AUTH_SESSION',
        'AUTHORIZATION_DIAGNOSTICS',
      ],
    },
  ],
  [
    'cache-plugin',
    {
      description: 'Cache over memory (LRU), Redis, or noop, with transparent response caching',
      tokens: ['CACHE', 'CACHE_DIAGNOSTICS'],
    },
  ],
  [
    'cloudflare-plugin',
    {
      description: 'Cloudflare bindings: KV, R2, D1, Queues, Cron, Cache API, and Durable Objects',
      tokens: ['CLOUDFLARE', 'CACHE', 'STORAGE', 'QUEUE', 'MESSAGING', 'REALTIME_BACKPLANE'],
    },
  ],
  [
    'config-plugin',
    {
      description: 'Configuration with env loading, variable expansion, and schema validation',
      tokens: ['CONFIG', 'CONFIG_DIAGNOSTICS'],
    },
  ],
  [
    'cqrs-plugin',
    {
      description: 'Command and query buses with a composable pipeline of behaviors',
      tokens: ['CQRS', 'COMMAND_BUS', 'QUERY_BUS'],
    },
  ],
  [
    'database-plugin',
    {
      description:
        'Repository pattern and Unit of Work over MongoDB, Prisma, Drizzle, D1, or memory',
      tokens: ['DATABASE'],
    },
  ],
  [
    'decorator-plugin',
    {
      description: 'Optional NestJS-style decorators and reflection, without reflect-metadata',
      tokens: ['METADATA_STORE'],
    },
  ],
  [
    'di-plugin',
    {
      description: 'Optional dependency injection with singleton, scoped, and transient lifecycles',
      tokens: ['DI_CONTAINER'],
    },
  ],
  [
    'diagnostics-plugin',
    {
      description:
        'Authenticated local diagnostics connector: signed loopback polling for the devtool',
      tokens: [],
    },
  ],
  [
    'events-plugin',
    {
      description: 'In-process domain event bus with typed handlers',
      tokens: ['EVENTS', 'EVENTS_DIAGNOSTICS'],
    },
  ],
  [
    'feature-flags-plugin',
    {
      description: 'Feature flags with percentage rollout, user targeting, and pluggable providers',
      tokens: ['FEATURE_FLAGS'],
    },
  ],
  [
    'graphql-plugin',
    {
      description:
        'GraphQL over HTTP with subscriptions on WebSocket and SSE, batching, and persisted queries',
      tokens: ['GRAPHQL'],
    },
  ],
  [
    'grpc-plugin',
    {
      description: 'Co-serve gRPC, Connect, and gRPC-Web on the same port as ordinary routes',
      tokens: ['GRPC'],
    },
  ],
  [
    'health-plugin',
    {
      description: 'Health, liveness, and readiness probes with pluggable indicators',
      tokens: ['HEALTH', 'HEALTH_DIAGNOSTICS'],
    },
  ],
  [
    'http-security-plugin',
    { description: 'CORS, security headers, CSRF, request-size limits, and IP rules', tokens: [] },
  ],
  [
    'idempotency-plugin',
    {
      description: 'A repeated request, queue job or broker message does its work once per key',
      tokens: ['IDEMPOTENCY'],
    },
  ],
  [
    'localization-plugin',
    {
      description:
        'Localization: message catalogues, request locale resolution, a formatter shared with the browser',
      tokens: ['LOCALIZATION'],
    },
  ],
  [
    'logger-plugin',
    {
      description:
        'Structured logging over console, pino, or noop, with request/response middleware',
      tokens: ['LOGGER'],
    },
  ],
  [
    'mail-plugin',
    {
      description: 'Email over log, SMTP, SES, or SendGrid, with a zero-dependency template engine',
      tokens: ['MAIL'],
    },
  ],
  [
    'messaging-plugin',
    {
      description:
        'Message broker over in-memory, Redis Streams, RabbitMQ, NATS, or Kafka, with request-reply',
      tokens: ['MESSAGING', 'OUTBOX', 'INBOX'],
    },
  ],
  [
    'metrics-plugin',
    {
      description:
        'Prometheus counters, gauges, histograms, and summaries with built-in HTTP metrics',
      tokens: ['METRICS'],
    },
  ],
  [
    'multi-tenancy-plugin',
    {
      description:
        'Tenant resolution by subdomain, header, path, or JWT, with schema/database/column isolation',
      tokens: ['MULTI_TENANCY'],
    },
  ],
  [
    'notification-plugin',
    {
      description: 'Email, SMS, push, and Slack notifications over one injectable HTTP seam',
      tokens: ['NOTIFICATION'],
    },
  ],
  [
    'openapi-plugin',
    {
      description: 'OpenAPI 3.1 generated from routes, with a Zod transformer and Swagger UI',
      tokens: ['OPENAPI'],
    },
  ],
  [
    'queue-plugin',
    {
      description:
        'Background jobs over memory, Redis, or RabbitMQ, with retries and cron scheduling',
      tokens: ['QUEUE', 'QUEUE_DIAGNOSTICS'],
    },
  ],
  [
    'react-router-plugin',
    {
      description: 'React Router 8 framework-mode SSR with file-based routing, as a plugin',
      tokens: ['SSR'],
    },
  ],
  [
    'realtime-backplane-plugin',
    {
      description: 'Cross-replica fan-out so WebSocket rooms and SSE channels reach every instance',
      tokens: ['REALTIME_BACKPLANE', 'REALTIME_DIAGNOSTICS'],
    },
  ],
  [
    'resilience-plugin',
    {
      description: 'Circuit breaker, retry, timeout, and bulkhead composed around any async call',
      tokens: ['RESILIENCE'],
    },
  ],
  [
    'scheduler-plugin',
    {
      description: 'Cron, interval, and delayed jobs with distributed locking',
      tokens: ['SCHEDULER', 'SCHEDULER_DIAGNOSTICS'],
    },
  ],
  [
    'secrets-plugin',
    {
      description:
        'Secrets over env, AWS KMS, GCP Secret Manager, Azure Key Vault, or HashiCorp Vault',
      tokens: ['SECRETS'],
    },
  ],
  [
    'service-discovery-plugin',
    {
      description:
        'Service discovery over static config, Consul, Kubernetes, or DNS-SRV, with balancing and ejection',
      tokens: ['SERVICE_DISCOVERY'],
    },
  ],
  [
    'session-plugin',
    {
      description:
        'Encrypted cookie sessions with pluggable stores and synchronizer-token form CSRF',
      tokens: ['SESSION'],
    },
  ],
  [
    'sse-plugin',
    {
      description: 'Server-Sent Events with named channels, heartbeat, and Last-Event-ID replay',
      tokens: ['SSE', 'REALTIME_DIAGNOSTICS'],
    },
  ],
  [
    'static-plugin',
    {
      description:
        'Static files with conditional requests, Range, precompressed sidecars, and SPA fallback',
      tokens: ['STATIC_FILES'],
    },
  ],
  [
    'storage-plugin',
    {
      description: 'Object storage over S3, B2, GCS, Azure Blob, local, or memory, with uploads',
      tokens: ['STORAGE', 'STORAGE_DIAGNOSTICS'],
    },
  ],
  [
    'telemetry-plugin',
    {
      description: 'OpenTelemetry tracing with W3C propagation and optional auto-instrumentation',
      tokens: ['TELEMETRY', 'TRACE_DIAGNOSTICS'],
    },
  ],
  [
    'validation-plugin',
    {
      description: 'Zod-based validation with RFC 9457, NestJS, or default error shapes',
      tokens: ['VALIDATION'],
    },
  ],
  [
    'view-plugin',
    {
      description:
        'Server-rendered HTML: view engines for JSX and html-tag components, named by reference',
      tokens: ['VIEW'],
    },
  ],
  [
    'websocket-plugin',
    {
      description: 'Full-duplex WebSocket on all four runtimes, with rooms, heartbeat, and limits',
      tokens: ['WEBSOCKET', 'REALTIME_DIAGNOSTICS'],
    },
  ],
  [
    'worker-pool-plugin',
    {
      description: 'CPU-bound work on real worker threads, off the event loop',
      tokens: ['WORKER_POOL'],
    },
  ],
  [
    'rest-starter',
    {
      description: 'createRestApp — a pre-wired REST plugin set with per-plugin option arms',
      tokens: [],
    },
  ],
  [
    'microservice-starter',
    {
      description: 'createMicroserviceApp — REST plus messaging, queues, resilience, and telemetry',
      tokens: [],
    },
  ],
  [
    'full-stack-starter',
    {
      description: 'createFullStackApp — the microservice set plus caching, CQRS, storage, and SSR',
      tokens: [],
    },
  ],
]);
