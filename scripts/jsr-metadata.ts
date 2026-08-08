/**
 * Per-package JSR settings: the one-line description and the runtime-compat
 * flags shown on each package page and in search results.
 *
 * WHY THIS IS DATA AND NOT DERIVED. The descriptions started as the README
 * feature-table cells, which are already reviewed prose, but they are frozen
 * here rather than scraped: a README cell is written for a table that names the
 * package in an adjacent column, while a JSR description is read standalone.
 * Scraping would also make a README formatting change silently rewrite 47 public
 * package pages.
 *
 * WHAT THE COMPAT FLAGS CLAIM. A flag is `true` when the package is usable on
 * that runtime through its default, zero-dependency path — not when every
 * optional provider is. `mail-plugin` is `workerd: true` because `LogProvider`
 * and `SendGridProvider` are Workers-portable, even though `SmtpProvider` needs
 * raw sockets; the per-package boolean JSR offers cannot express "some providers
 * only", and refusing the whole package would be the more misleading of the two
 * available answers. A flag is omitted entirely where the honest answer is
 * unknown — JSR renders that as "Compatibility unknown", which is a weaker claim
 * than `false`.
 *
 * @module
 */

/** The five runtimes JSR tracks. An omitted key renders as "unknown". */
export interface RuntimeCompat {
  readonly browser?: boolean;
  readonly deno?: boolean;
  readonly node?: boolean;
  readonly workerd?: boolean;
  readonly bun?: boolean;
}

/** Settings for one package, keyed by its name within the scope. */
export interface PackageMetadata {
  readonly description: string;
  readonly runtimeCompat: RuntimeCompat;
}

/** Every package runs on the three server runtimes but not the edge or a browser. */
const SERVER_ONLY: RuntimeCompat = {
  browser: false,
  deno: true,
  node: true,
  workerd: false,
  bun: false,
} as const;

/** The common case: the three server runtimes plus the edge, but not a browser. */
const PORTABLE: RuntimeCompat = {
  browser: false,
  deno: true,
  node: true,
  workerd: true,
  bun: true,
} as const;

/** Server runtimes and the edge, and usable in a browser too. */
const UNIVERSAL: RuntimeCompat = {
  browser: true,
  deno: true,
  node: true,
  workerd: true,
  bun: true,
} as const;

/** Deno, Node and Bun, but not the edge — needs sockets, threads, or a filesystem. */
const NO_EDGE: RuntimeCompat = {
  browser: false,
  deno: true,
  node: true,
  workerd: false,
  bun: true,
} as const;

/**
 * The settings applied to every published package.
 *
 * Keys are JSR package names within the `@setu-ts` scope, and
 * `set-jsr-metadata.ts` fails when this map and `PUBLISHED_PACKAGES` disagree,
 * so a new package cannot be published with an empty page by omission.
 */
export const PACKAGE_METADATA: Readonly<Record<string, PackageMetadata>> = {
  // ── Core ──────────────────────────────────────────────────────────────────
  'common': {
    description:
      'Shared contracts, capability tokens, and pure codecs every Setu-TS package builds on',
    runtimeCompat: UNIVERSAL,
  },
  'kernel': {
    description: 'Capability-token plugin kernel: service registry, middleware pipeline, router',
    runtimeCompat: PORTABLE,
  },
  'runtime': {
    description:
      'Runtime services and HTTP adapters for Node.js, Deno, Bun, and Cloudflare Workers',
    runtimeCompat: PORTABLE,
  },
  'exceptions': {
    description: 'Exception hierarchy, RFC 7807 Problem Details, and the error-handler middleware',
    runtimeCompat: PORTABLE,
  },
  'testing': {
    description: 'Test app factory, mock plugins, and request injection for Setu-TS',
    runtimeCompat: PORTABLE,
  },

  // ── Optional composition ──────────────────────────────────────────────────
  'di-plugin': {
    description: 'Optional dependency injection with singleton, scoped, and transient lifecycles',
    runtimeCompat: PORTABLE,
  },
  'decorator-plugin': {
    description: 'Optional NestJS-style decorators and reflection, without reflect-metadata',
    runtimeCompat: PORTABLE,
  },

  // ── Request path ──────────────────────────────────────────────────────────
  'logger-plugin': {
    description: 'Structured logging over console, pino, or noop, with request/response middleware',
    runtimeCompat: PORTABLE,
  },
  'config-plugin': {
    description: 'Configuration with env loading, variable expansion, and schema validation',
    runtimeCompat: PORTABLE,
  },
  'validation-plugin': {
    description: 'Zod-based validation with RFC 7807, NestJS, or default error shapes',
    runtimeCompat: PORTABLE,
  },
  'http-security-plugin': {
    description: 'CORS, security headers, CSRF, request-size limits, and IP rules',
    runtimeCompat: PORTABLE,
  },
  'auth-plugin': {
    description:
      'JWT via Web Crypto, API keys, refresh tokens, RBAC, and rate limiting — zero npm dependencies',
    runtimeCompat: PORTABLE,
  },
  'session-plugin': {
    description: 'Encrypted cookie sessions with pluggable stores and synchronizer-token form CSRF',
    runtimeCompat: PORTABLE,
  },
  'graphql-plugin': {
    description:
      'GraphQL over HTTP with subscriptions on WebSocket and SSE, batching, and persisted queries',
    runtimeCompat: PORTABLE,
  },
  'grpc-plugin': {
    description: 'Co-serve gRPC, Connect, and gRPC-Web on the same port as ordinary routes',
    runtimeCompat: PORTABLE,
  },
  'static-plugin': {
    description:
      'Static files with conditional requests, Range, precompressed sidecars, and SPA fallback',
    // Reads through `IRuntimeServices.fs`, which Workers does not provide — the
    // plugin registers its capability there but mounts no route. Workers apps
    // serve assets through Workers Assets or R2 via `cloudflare-plugin`.
    runtimeCompat: NO_EDGE,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  'database-plugin': {
    description: 'Repository pattern and Unit of Work over Prisma, Drizzle, D1, or memory',
    runtimeCompat: PORTABLE,
  },
  'cache-plugin': {
    description: 'Cache over memory (LRU), Redis, or noop, with transparent response caching',
    runtimeCompat: PORTABLE,
  },
  'events-plugin': {
    description: 'In-process domain event bus with typed handlers',
    runtimeCompat: PORTABLE,
  },
  'cqrs-plugin': {
    description: 'Command and query buses with a composable pipeline of behaviors',
    runtimeCompat: PORTABLE,
  },
  'messaging-plugin': {
    description:
      'Message broker over in-memory, Redis Streams, RabbitMQ, NATS, or Kafka, with request-reply',
    runtimeCompat: NO_EDGE,
  },
  'queue-plugin': {
    description:
      'Background jobs over memory, Redis, or RabbitMQ, with retries and cron scheduling',
    runtimeCompat: NO_EDGE,
  },
  'storage-plugin': {
    description: 'Object storage over S3, B2, GCS, Azure Blob, local, or memory, with uploads',
    runtimeCompat: PORTABLE,
  },

  // ── Operations ────────────────────────────────────────────────────────────
  'scheduler-plugin': {
    description: 'Cron, interval, and delayed jobs with distributed locking',
    runtimeCompat: NO_EDGE,
  },
  'metrics-plugin': {
    description:
      'Prometheus counters, gauges, histograms, and summaries with built-in HTTP metrics',
    runtimeCompat: PORTABLE,
  },
  'health-plugin': {
    description: 'Health, liveness, and readiness probes with pluggable indicators',
    runtimeCompat: PORTABLE,
  },
  'openapi-plugin': {
    description: 'OpenAPI 3.1 generated from routes, with a Zod transformer and Swagger UI',
    runtimeCompat: PORTABLE,
  },
  'telemetry-plugin': {
    description: 'OpenTelemetry tracing with W3C propagation and optional auto-instrumentation',
    runtimeCompat: PORTABLE,
  },
  'secrets-plugin': {
    description:
      'Secrets over env, AWS KMS, GCP Secret Manager, Azure Key Vault, or HashiCorp Vault',
    runtimeCompat: PORTABLE,
  },
  'audit-plugin': {
    description: 'Immutable audit trail over memory, log, database, or file storage',
    runtimeCompat: PORTABLE,
  },
  'resilience-plugin': {
    description: 'Circuit breaker, retry, timeout, and bulkhead composed around any async call',
    runtimeCompat: PORTABLE,
  },
  'service-discovery-plugin': {
    description:
      'Service discovery over static config, Consul, Kubernetes, or DNS-SRV, with balancing and ejection',
    runtimeCompat: NO_EDGE,
  },

  // ── Features ──────────────────────────────────────────────────────────────
  'mail-plugin': {
    description: 'Email over log, SMTP, SES, or SendGrid, with a zero-dependency template engine',
    runtimeCompat: PORTABLE,
  },
  'notification-plugin': {
    description: 'Email, SMS, push, and Slack notifications over one injectable HTTP seam',
    runtimeCompat: PORTABLE,
  },
  'feature-flags-plugin': {
    description: 'Feature flags with percentage rollout, user targeting, and pluggable providers',
    runtimeCompat: PORTABLE,
  },
  'multi-tenancy-plugin': {
    description:
      'Tenant resolution by subdomain, header, path, or JWT, with schema/database/column isolation',
    runtimeCompat: PORTABLE,
  },

  // ── Real-time and SSR ─────────────────────────────────────────────────────
  'sse-plugin': {
    description: 'Server-Sent Events with named channels, heartbeat, and Last-Event-ID replay',
    runtimeCompat: PORTABLE,
  },
  'websocket-plugin': {
    description: 'Full-duplex WebSocket on all four runtimes, with rooms, heartbeat, and limits',
    runtimeCompat: PORTABLE,
  },
  'realtime-backplane-plugin': {
    description: 'Cross-replica fan-out so WebSocket rooms and SSE channels reach every instance',
    runtimeCompat: PORTABLE,
  },
  'react-router-plugin': {
    description: 'React Router v7 framework-mode SSR with file-based routing, as a plugin',
    runtimeCompat: PORTABLE,
  },
  'worker-pool-plugin': {
    description: 'CPU-bound work on real worker threads, off the event loop',
    runtimeCompat: NO_EDGE,
  },

  // ── Platform ──────────────────────────────────────────────────────────────
  'cloudflare-plugin': {
    description: 'Cloudflare bindings: KV, R2, D1, Queues, Cron, Cache API, and Durable Objects',
    runtimeCompat: {
      browser: false,
      deno: false,
      node: false,
      workerd: true,
      bun: false,
    },
  },

  // ── Tooling ───────────────────────────────────────────────────────────────
  'cli': {
    description: 'setu — project scaffolding and plugin-aware code generation',
    runtimeCompat: SERVER_ONLY,
  },
  'sdk': {
    description:
      'Portable HTTP client with retry, circuit breaker, rate limiting, and OpenAPI codegen',
    runtimeCompat: UNIVERSAL,
  },

  // ── Starters ──────────────────────────────────────────────────────────────
  'rest-starter': {
    description: 'createRestApp — a pre-wired REST plugin set with per-plugin option arms',
    runtimeCompat: PORTABLE,
  },
  'microservice-starter': {
    description: 'createMicroserviceApp — REST plus messaging, queues, resilience, and telemetry',
    runtimeCompat: NO_EDGE,
  },
  // `workerd: true` while `microservice-starter` is false, though this tier
  // composes that one. Not an oversight: the flags track the CLI's own
  // `unsupported` declarations, which are the repo's explicit statement of what
  // is supported where. `full-stack` declares `unsupported: {}` and its e2e gate
  // scaffolds the Workers target; `microservice` refuses Workers because it
  // exists for broker-backed work that would deploy cleanly and fail at first
  // use. Both tiers register `MessagingPlugin`/`QueuePlugin`, but their in-memory
  // defaults boot on Workers and the scaffolded `wrangler.toml` sets
  // `nodejs_compat`, so the `node:buffer` the RabbitMQ modules import resolves.
  'full-stack-starter': {
    description: 'createFullStackApp — the microservice set plus caching, CQRS, storage, and SSR',
    runtimeCompat: PORTABLE,
  },
} as const;
