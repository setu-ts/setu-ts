# Plugin Catalog

This catalog lists all published plugins and packages in the Setu-TS framework, organized by tier
and capability.

## Package Tiers

Packages are organized into tiers based on their role in the framework:

| Tier        | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| **Tier 1**  | Core infrastructure (common, kernel, runtime)                        |
| **Tier 2**  | Essential plugins (DI, decorators, logger, config, validation)       |
| **Tier 3**  | Business capability plugins (database, cache, auth, messaging, etc.) |
| **Tier 4**  | Infrastructure plugins (metrics, health, telemetry, etc.)            |
| **Tier 5**  | Platform-specific plugins (Cloudflare, gRPC, GraphQL, etc.)          |
| **Tooling** | CLI, SDK, and starters                                               |

## Optional npm drivers

Most packages here declare **no npm dependencies at all**. The ones that do declare them only
because they offer an optional driver — a Redis client, a cloud SDK, a database ORM — and the rule
in every case is the same: **nothing is imported until you select the arm that needs it.** Choosing
`MemoryStore` never loads `ioredis`; choosing `LogProvider` never loads `nodemailer`.

What differs is what "declare" means in each ecosystem, and it is worth being precise because the
two answers are genuinely different:

|                        | Deno / JSR                                    | Node / Bun (npm)                         |
| ---------------------- | --------------------------------------------- | ---------------------------------------- |
| Adding the package     | fetches nothing extra                         | installs the declared drivers            |
| Selecting a driver arm | resolves the `npm:` specifier on first import | already present                          |
| Never selecting one    | the driver is never fetched                   | the driver sits unused in `node_modules` |

The npm column is not a packaging choice we made. JSR's npm-compatibility build turns every `npm:`
specifier it finds into a `dependencies` entry of the published package, and npm has no concept of
an optional-but-declared runtime dependency that fits this pattern. So on npm, installing
`@setu-ts/messaging-plugin` does bring its six broker clients with it, even if your application only
ever uses the in-memory broker.

### Which packages declare drivers

Every package NOT listed here declares zero npm dependencies — that includes `common`, `kernel`,
`exceptions`, `sdk`, `cloudflare-plugin`, `session-plugin`, `validation-plugin`, `openapi-plugin`,
and the three starters.

| Package                     | Declared npm drivers                                                                                            | Arm that needs them                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `auth-plugin`               | `ioredis`                                                                                                       | `RedisRateLimitStore`                                                         |
| `cache-plugin`              | `ioredis`                                                                                                       | `store: 'redis'`                                                              |
| `database-plugin`           | `drizzle-orm`                                                                                                   | `type: 'drizzle'` (Prisma and D1 are inject-only — neither declares a driver) |
| `feature-flags-plugin`      | `@launchdarkly/node-server-sdk`                                                                                 | `provider: 'launchdarkly'`                                                    |
| `graphql-plugin`            | `graphql`                                                                                                       | always (the execution engine)                                                 |
| `grpc-plugin`               | `@connectrpc/connect`, `@bufbuild/protobuf`                                                                     | always (the RPC runtime)                                                      |
| `logger-plugin`             | `pino`                                                                                                          | `PinoLogger`                                                                  |
| `mail-plugin`               | `nodemailer`, `@aws-sdk/client-sesv2`                                                                           | `smtp` / `ses` providers                                                      |
| `messaging-plugin`          | `ioredis`, `amqplib`, `kafkajs`, `nats`, `@google-cloud/pubsub`, `@azure/service-bus`                           | the matching broker                                                           |
| `queue-plugin`              | `ioredis`, `amqplib`, `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`                                              | the matching adapter                                                          |
| `react-router-plugin`       | `react-router`                                                                                                  | always (SSR request handler)                                                  |
| `realtime-backplane-plugin` | `ioredis`                                                                                                       | `transport: 'redis'`                                                          |
| `runtime`                   | `@hono/node-server`, `ws`                                                                                       | the Node HTTP and WebSocket adapters                                          |
| `scheduler-plugin`          | `ioredis`                                                                                                       | `RedisLock`                                                                   |
| `secrets-plugin`            | `@aws-sdk/client-secrets-manager`, `@google-cloud/secret-manager`, `@azure/identity`, `@azure/keyvault-secrets` | the matching cloud provider                                                   |
| `storage-plugin`            | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@google-cloud/storage`, `@azure/storage-blob`           | the matching provider                                                         |
| `telemetry-plugin`          | `@opentelemetry/*` (SDK, exporter, and the five auto-instrumentations)                                          | any non-noop exporter, or `instrumentations`                                  |

Two of these — `graphql-plugin` and `grpc-plugin` — are marked "always" because the driver **is**
the capability rather than one choice among several. Neither has a zero-driver arm, and neither
claims one.

Every driver above can also be supplied by **injection** instead, through the plugin's own options
(`DatabasePlugin({ client })`, `CachePlugin({ client })`, and so on). An application that injects
its own client never triggers the lazy import at all — see
[AI_GUIDELINES §12.2](https://github.com/setu-ts/setu-ts/blob/main/AI_GUIDELINES.md).

## Tier 1: Core Infrastructure

### @setu-ts/common

**Purpose:** Shared types, interfaces, and capability tokens used across all packages.

**Capability Token:** N/A (type-only package)

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Exports:**

- `IPlugin`, `IPluginContext` - Plugin contracts
- `CAPABILITIES` - Standard capability tokens
- `IRequest`, `IResponse`, `IRequestContext` - HTTP abstractions
- `IRuntimeServices` - Runtime service interface

**Links:**

- [README](../packages/common/README.md)
- [API Reference](./api/common/src/index.ts/index.html)

---

### @setu-ts/kernel

**Purpose:** Core plugin kernel with registry, middleware pipeline, router, and application
lifecycle.

**Capability Token:** N/A (core infrastructure)

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Exports:**

- `createApplication()` - Application factory
- `Router`, `LinearRouter` - Routing engine
- `ServiceRegistry` - Service container

**Links:**

- [README](../packages/kernel/README.md)
- [API Reference](./api/kernel/src/index.ts/index.html)

---

### @setu-ts/runtime

**Purpose:** Runtime detection and HTTP adapter implementations for all platforms.

**Capability Token:** `CAPABILITIES.RUNTIME`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Exports:**

- `RuntimePlugin` - Runtime registration
- `DenoHttpAdapter`, `NodeHttpAdapter`, `BunHttpAdapter`, `CloudflareWorkersHttpAdapter`
- `detectRuntime()` - Runtime detection

**Links:**

- [README](../packages/runtime/README.md)
- [API Reference](./api/runtime/src/index.ts/index.html)

---

## Tier 2: Essential Plugins

### @setu-ts/di-plugin

**Purpose:** Optional dependency injection container with constructor injection and scope
management.

**Capability Token:** `CAPABILITIES.CONTAINER`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Features:**

- Singleton, scoped, and transient lifecycles
- Constructor and parameter injection
- Circular dependency detection
- Hierarchical scopes

**Links:**

- [README](../packages/di-plugin/README.md)
- [API Reference](./api/di-plugin/src/index.ts/index.html)

---

### @setu-ts/decorator-plugin

**Purpose:** Optional decorators for controllers, routes, and dependency injection.

**Capability Token:** `CAPABILITIES.METADATA_STORE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Features:**

- `@Controller`, `@Get`, `@Post`, etc.
- `@Injectable`, `@Inject`
- `@Body`, `@Query`, `@Param`
- `@UseGuards`, `@UseInterceptors`, `@UseFilters`

**Note:** Decorators are **optional** and require explicit token injection (no
emitDecoratorMetadata).

**Links:**

- [README](../packages/decorator-plugin/README.md)
- [API Reference](./api/decorator-plugin/src/index.ts/index.html)

---

### @setu-ts/logger-plugin

**Purpose:** Structured logging with pluggable backends.

**Capability Token:** `CAPABILITIES.LOGGER`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Features:**

- Console and file backends
- Log levels (debug, info, warn, error)
- Structured JSON output
- Context injection

**Links:**

- [README](../packages/logger-plugin/README.md)
- [API Reference](./api/logger-plugin/src/index.ts/index.html)

---

### @setu-ts/config-plugin

**Purpose:** Configuration management with environment variable support and validation.

**Capability Token:** `CAPABILITIES.CONFIG`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Features:**

- Environment variable loading
- Variable expansion (`${VAR}`)
- Zod-compatible validation
- Multi-source configuration

**Links:**

- [README](../packages/config-plugin/README.md)
- [API Reference](./api/config-plugin/src/index.ts/index.html)

---

### @setu-ts/validation-plugin

**Purpose:** Request validation with Zod integration.

**Capability Token:** `CAPABILITIES.VALIDATION`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Key Features:**

- Zod schema validation
- Request body/query/param validation
- Custom error formatting
- Async validators

**Links:**

- [README](../packages/validation-plugin/README.md)
- [API Reference](./api/validation-plugin/src/index.ts/index.html)

---

### @setu-ts/exceptions

**Purpose:** Exception hierarchy, RFC 9457 Problem Details, and the error-handler middleware.

**Capability Token:** N/A (middleware-only)

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- HttpError hierarchy
- RFC 9457 Problem Details format (the `'rfc7807'` alias is deprecated but still accepted)
- Error handler middleware factory

**Links:**

- [README](../packages/exceptions/README.md)
- [API Reference](./api/exceptions/src/index.ts/index.html)

---

### @setu-ts/openapi-plugin

**Purpose:** OpenAPI 3.1 spec generation from routes, with a Zod transformer and Swagger UI.

**Capability Token:** `CAPABILITIES.OPENAPI`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- Route-based OpenAPI spec generation
- Zod schema transformer
- Swagger UI serving

**Links:**

- [README](../packages/openapi-plugin/README.md)
- [API Reference](./api/openapi-plugin/src/index.ts/index.html)

---

## Tier 3: Business Capabilities

### @setu-ts/database-plugin

**Purpose:** Database access with repository pattern and ORM adapters.

**Capability Token:** `CAPABILITIES.DATABASE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers            |
| ---- | ---- | --- | ------------------ |
| ✅   | ✅   | ✅  | ✅ (with adapters) |

**Adapters:**

- Memory (built-in)
- Prisma (via npm: adapter)
- Drizzle (via npm: adapter)
- D1 (Cloudflare Workers)

**Links:**

- [README](../packages/database-plugin/README.md)
- [API Reference](./api/database-plugin/src/index.ts/index.html)

---

### @setu-ts/cache-plugin

**Purpose:** Caching with multiple backend support.

**Capability Token:** `CAPABILITIES.CACHE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅ (KV) |

**Stores:**

- Memory (built-in)
- Redis (via npm:ioredis)
- Cloudflare KV

**Links:**

- [README](../packages/cache-plugin/README.md)
- [API Reference](./api/cache-plugin/src/index.ts/index.html)

---

### @setu-ts/auth-plugin

**Purpose:** Authentication and authorization with JWT and API key support.

**Capability Token:** `CAPABILITIES.AUTHENTICATION`, `CAPABILITIES.AUTHORIZATION`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- JWT (HS256, RS256)
- API key authentication
- RBAC with role hierarchy
- Local strategy for login flows
- Password hashing (PBKDF2-SHA256)

**Links:**

- [README](../packages/auth-plugin/README.md)
- [API Reference](./api/auth-plugin/src/index.ts/index.html)

---

### @setu-ts/messaging-plugin

**Purpose:** Message broker integration for event-driven architectures.

**Capability Token:** `CAPABILITIES.MESSAGING`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

**Brokers:**

- In-memory (built-in)
- Redis Streams (via npm:ioredis)
- RabbitMQ (via npm:amqplib)
- NATS (via npm:nats)
- Kafka (via npm:kafkajs)
- GCP Pub/Sub (via npm:@google-cloud/pubsub)
- Azure Service Bus (via npm:@azure/service-bus)

> Workers is not supported by **this package**: every broker except the in-memory default needs raw
> sockets or an npm SDK that does not run on the edge. The capability itself IS available there —
> [`@setu-ts/cloudflare-plugin`](#setu-tscloudflare-plugin) registers `CAPABILITIES.MESSAGING` from
> the platform, serving publish/subscribe over Workers Queues and request/reply through a Durable
> Object reply inbox. An application registers exactly one provider of the token, so the choice is
> per deployment target, not per call site.

**Features:**

- Publish/subscribe
- Request/reply (RPC)
- Events bridge
- Message persistence

**Links:**

- [README](../packages/messaging-plugin/README.md)
- [API Reference](./api/messaging-plugin/src/index.ts/index.html)

---

### @setu-ts/queue-plugin

**Purpose:** Job queue with retries, scheduling, and multiple backends.

**Capability Token:** `CAPABILITIES.QUEUE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

**Adapters:**

- Memory (built-in)
- Redis (via npm:ioredis)
- RabbitMQ (via npm:amqplib)
- SQS (via npm:@aws-sdk/client-sqs)

> Workers Queues belong to [`@setu-ts/cloudflare-plugin`](#setu-tscloudflare-plugin), not this
> package — the queue-plugin adapters all need raw sockets or an npm SDK unavailable on the edge.

**Links:**

- [README](../packages/queue-plugin/README.md)
- [API Reference](./api/queue-plugin/src/index.ts/index.html)

---

### @setu-ts/events-plugin

**Purpose:** Domain event publishing and handling.

**Capability Token:** `CAPABILITIES.EVENTS`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- DomainEvent, IntegrationEvent
- In-memory event bus
- Event persistence (via messaging)

**Links:**

- [README](../packages/events-plugin/README.md)
- [API Reference](./api/events-plugin/src/index.ts/index.html)

---

### @setu-ts/cqrs-plugin

**Purpose:** Command-Query Responsibility Segregation pattern implementation.

**Capability Token:** `CAPABILITIES.CQRS`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- CommandBus, QueryBus
- Handler registration
- Pipeline behaviors

**Links:**

- [README](../packages/cqrs-plugin/README.md)
- [API Reference](./api/cqrs-plugin/src/index.ts/index.html)

---

## Tier 4: Infrastructure

### @setu-ts/metrics-plugin

**Purpose:** Prometheus metrics collection.

**Capability Token:** `CAPABILITIES.METRICS`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- Counter, Gauge, Histogram, Summary
- HTTP metrics collection
- `/metrics` endpoint

**Links:**

- [README](../packages/metrics-plugin/README.md)
- [API Reference](./api/metrics-plugin/src/index.ts/index.html)

---

### @setu-ts/health-plugin

**Purpose:** Health checks and readiness probes.

**Capability Token:** `CAPABILITIES.HEALTH`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- Built-in health indicators
- Custom health checks
- Aggregated health endpoint

**Links:**

- [README](../packages/health-plugin/README.md)
- [API Reference](./api/health-plugin/src/index.ts/index.html)

---

### @setu-ts/telemetry-plugin

**Purpose:** OpenTelemetry integration for distributed tracing.

**Capability Token:** `CAPABILITIES.TELEMETRY`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers      |
| ---- | ---- | --- | ------------ |
| ✅   | ✅   | ✅  | ✅ (limited) |

**Features:**

- Request tracing
- W3C traceparent propagation
- OTLP exporter
- Auto-instrumentation (Node-only)

**Links:**

- [README](../packages/telemetry-plugin/README.md)
- [API Reference](./api/telemetry-plugin/src/index.ts/index.html)

---

### @setu-ts/scheduler-plugin

**Purpose:** Scheduled job execution with cron support.

**Capability Token:** `CAPABILITIES.SCHEDULER`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers               |
| ---- | ---- | --- | --------------------- |
| ✅   | ✅   | ✅  | ❌ (use Workers Cron) |

**Features:**

- 5-field UTC cron parser
- Fixed-interval and one-shot jobs
- Retry with backoff
- Distributed locking

**Links:**

- [README](../packages/scheduler-plugin/README.md)
- [API Reference](./api/scheduler-plugin/src/index.ts/index.html)

---

### @setu-ts/secrets-plugin

**Purpose:** Secret management with multiple cloud providers.

**Capability Token:** `CAPABILITIES.SECRETS`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers  |
| ---- | ---- | --- | -------- |
| ✅   | ✅   | ✅  | ✅ (env) |

**Providers:**

- Environment variables (default)
- AWS Secrets Manager
- GCP Secret Manager
- Azure Key Vault
- HashiCorp Vault

**Links:**

- [README](../packages/secrets-plugin/README.md)
- [API Reference](./api/secrets-plugin/src/index.ts/index.html)

---

### @setu-ts/audit-plugin

**Purpose:** Audit logging with pluggable storage.

**Capability Token:** `CAPABILITIES.AUDIT`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅ (KV) |

**Storage:**

- Memory (default)
- File (JSONL)
- Database
- Cloudflare KV

**Links:**

- [README](../packages/audit-plugin/README.md)
- [API Reference](./api/audit-plugin/src/index.ts/index.html)

---

### @setu-ts/resilience-plugin

**Purpose:** Resilience patterns (circuit breaker, retry, timeout, bulkhead).

**Capability Token:** `CAPABILITIES.RESILIENCE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Patterns:**

- Circuit breaker
- Retry with backoff
- Timeout
- Bulkhead

**Links:**

- [README](../packages/resilience-plugin/README.md)
- [API Reference](./api/resilience-plugin/src/index.ts/index.html)

---

### @setu-ts/storage-plugin

**Purpose:** Object storage with multiple cloud providers.

**Capability Token:** `CAPABILITIES.STORAGE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅ (R2) |

**Providers:**

- Memory (default)
- Local filesystem
- AWS S3
- Google Cloud Storage
- Azure Blob Storage
- Backblaze B2

**Links:**

- [README](../packages/storage-plugin/README.md)
- [API Reference](./api/storage-plugin/src/index.ts/index.html)

---

### @setu-ts/mail-plugin

**Purpose:** Email sending with multiple providers.

**Capability Token:** `CAPABILITIES.MAIL`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers   |
| ---- | ---- | --- | --------- |
| ✅   | ✅   | ✅  | ✅ (HTTP) |

**Providers:**

- Log (default, for development)
- SMTP (Node/Deno/Bun only)
- AWS SES
- SendGrid

**Links:**

- [README](../packages/mail-plugin/README.md)
- [API Reference](./api/mail-plugin/src/index.ts/index.html)

---

### @setu-ts/notification-plugin

**Purpose:** Multi-channel notifications (email, SMS, push, Slack).

**Capability Token:** `CAPABILITIES.NOTIFICATION`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers   |
| ---- | ---- | --- | --------- |
| ✅   | ✅   | ✅  | ✅ (HTTP) |

**Channels:**

- Email (via mail plugin)
- SMS (Twilio)
- Push (FCM)
- Slack

**Links:**

- [README](../packages/notification-plugin/README.md)
- [API Reference](./api/notification-plugin/src/index.ts/index.html)

---

### @setu-ts/feature-flags-plugin

**Purpose:** Feature flag management with multiple providers.

**Capability Token:** `CAPABILITIES.FEATURE_FLAGS`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Providers:**

- Config (inline, immutable)
- Memory (mutable)
- Database (polling)
- LaunchDarkly (Node-only)

**Links:**

- [README](../packages/feature-flags-plugin/README.md)
- [API Reference](./api/feature-flags-plugin/src/index.ts/index.html)

---

### @setu-ts/multi-tenancy-plugin

**Purpose:** Multi-tenancy with multiple isolation strategies.

**Capability Token:** `CAPABILITIES.MULTI_TENANCY`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Strategies:**

- Column isolation
- Schema isolation
- Database isolation

**Resolvers:**

- Subdomain
- Header
- Path
- JWT

**Links:**

- [README](../packages/multi-tenancy-plugin/README.md)
- [API Reference](./api/multi-tenancy-plugin/src/index.ts/index.html)

---

### @setu-ts/session-plugin

**Purpose:** Cookie-based sessions and CSRF protection.

**Capability Token:** `CAPABILITIES.SESSION`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅ (KV) |

**Features:**

- Encrypted cookies (default)
- Server-side storage (memory, cache)
- Key rotation
- Form CSRF (synchronizer token)

**Links:**

- [README](../packages/session-plugin/README.md)
- [API Reference](./api/session-plugin/src/index.ts/index.html)

---

## Tier 5: Platform-Specific

### @setu-ts/cloudflare-plugin

**Purpose:** Cloudflare Workers platform integration.

**Capability Token:** `CAPABILITIES.CLOUDFLARE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ❌   | ❌   | ❌  | ✅      |

**Features:**

- KV cache/session stores
- D1 database adapter
- R2 storage provider
- Durable Objects (backplane, locks)
- Workers Queues
- Cron Triggers
- Messaging (`CAPABILITIES.MESSAGING`) — publish/subscribe over Workers Queues, and request/reply
  through a Durable Object reply inbox
- Cache API middleware

**Links:**

- [README](../packages/cloudflare-plugin/README.md)
- [API Reference](./api/cloudflare-plugin/src/index.ts/index.html)

---

### @setu-ts/grpc-plugin

**Purpose:** gRPC and Connect-ES support.

**Capability Token:** `CAPABILITIES.GRPC`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Protocols:**

- gRPC
- Connect-ES
- gRPC-Web

**Links:**

- [README](../packages/grpc-plugin/README.md)
- [API Reference](./api/grpc-plugin/src/index.ts/index.html)

---

### @setu-ts/graphql-plugin

**Purpose:** GraphQL server with schema-first and code-first support.

**Capability Token:** `CAPABILITIES.GRAPHQL`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- Schema-first and code-first
- Subscriptions (WebSocket, SSE)
- GraphiQL
- Automatic Persisted Queries

**Links:**

- [README](../packages/graphql-plugin/README.md)
- [API Reference](./api/graphql-plugin/src/index.ts/index.html)

---

### @setu-ts/react-router-plugin

**Purpose:** React Router SSR integration.

**Capability Token:** `CAPABILITIES.SSR`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Note:** Requires Node/npm toolchain for client build.

**Links:**

- [README](../packages/react-router-plugin/README.md)
- [API Reference](./api/react-router-plugin/src/index.ts/index.html)

---

### @setu-ts/sse-plugin

**Purpose:** Server-Sent Events support.

**Capability Token:** `CAPABILITIES.SSE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Links:**

- [README](../packages/sse-plugin/README.md)
- [API Reference](./api/sse-plugin/src/index.ts/index.html)

---

### @setu-ts/websocket-plugin

**Purpose:** WebSocket support with room broadcasting.

**Capability Token:** `CAPABILITIES.WEBSOCKET`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Links:**

- [README](../packages/websocket-plugin/README.md)
- [API Reference](./api/websocket-plugin/src/index.ts/index.html)

---

### @setu-ts/worker-pool-plugin

**Purpose:** CPU-intensive tasks on worker threads.

**Capability Token:** `CAPABILITIES.WORKER_POOL`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

**Links:**

- [README](../packages/worker-pool-plugin/README.md)
- [API Reference](./api/worker-pool-plugin/src/index.ts/index.html)

---

### @setu-ts/realtime-backplane-plugin

**Purpose:** Cross-replica real-time communication.

**Capability Token:** `CAPABILITIES.REALTIME_BACKPLANE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Transports:**

- Memory (default)
- Messaging (brokered)
- Redis
- Custom

> The Durable Objects backplane belongs to
> [`@setu-ts/cloudflare-plugin`](#setu-tscloudflare-plugin), not this package. This plugin ships the
> `memory`, `messaging`, `redis`, and `custom` transports; on Workers, register the
> cloudflare-plugin's `durableObject` arm for the DO-backed `IRealtimeBackplane` instead.

**Links:**

- [README](../packages/realtime-backplane-plugin/README.md)
- [API Reference](./api/realtime-backplane-plugin/src/index.ts/index.html)

---

### @setu-ts/static-plugin

**Purpose:** Static file serving with caching and range requests.

**Capability Token:** `CAPABILITIES.STATIC_FILES`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

> Workers has no filesystem, so the plugin registers its capability but mounts no route — a degraded
> health indicator reports "no file system on this runtime". Serve assets through Workers Assets or
> an R2 bucket via [`@setu-ts/cloudflare-plugin`](#setu-tscloudflare-plugin) instead; this package
> has no R2 implementation.

**Links:**

- [README](../packages/static-plugin/README.md)
- [API Reference](./api/static-plugin/src/index.ts/index.html)

---

### @setu-ts/service-discovery-plugin

**Purpose:** Service discovery for microservices.

**Capability Token:** `CAPABILITIES.SERVICE_DISCOVERY`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers   |
| ---- | ---- | --- | --------- |
| ✅   | ✅   | ✅  | ✅ (HTTP) |

**Providers:**

- Static
- Consul
- Kubernetes
- DNS-SRV

**Links:**

- [README](../packages/service-discovery-plugin/README.md)
- [API Reference](./api/service-discovery-plugin/src/index.ts/index.html)

---

### @setu-ts/http-security-plugin

**Purpose:** Security middleware (CORS, headers, CSRF, rate limiting).

**Capability Token:** N/A (middleware-only)

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- CORS
- Security headers
- CSRF protection
- Rate limiting
- IP security

**Links:**

- [README](../packages/http-security-plugin/README.md)
- [API Reference](./api/http-security-plugin/src/index.ts/index.html)

---

## Tooling

### @setu-ts/cli

**Purpose:** Command-line interface for scaffolding and code generation.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ❌  | N/A     |

**Commands:**

- `setu new <name>` - Create a new project (`--template rest|microservice|class-based|full-stack`,
  `--runtime deno|node|bun|cloudflare-workers`); `--template class-based` opts into decorators and
  dependency injection together, and every other template is functional
- `setu new <name> --workspace` - Create a monorepo root (`--port`, `--transport`)
- `setu generate <type> <name>` - Generate code; 14 schematics, 11 of them wired into a registration
  site with no edit to a file you own
- `setu generate app <name>` - Add a service to a workspace, allocating its port and registering it
  in every sibling's discovery map
- `setu commands` - List the commands this project's plugins provide

**Installation:**

```bash
deno install -g -A --min-dep-age 0 -n setu jsr:@setu-ts/cli@^0.1.0-alpha.8/main
```

**Links:**

- [CLI Guide](./cli.md)
- [README](../packages/cli/README.md)
- [API Reference](./api/cli/src/index.ts/index.html)

---

### @setu-ts/sdk

**Purpose:** Client SDK for consuming Setu-TS applications.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- HTTP client with auth interceptors
- Resilience (retry, circuit breaker, rate limit)
- OpenAPI code generation

**Links:**

- [README](../packages/sdk/README.md)
- [API Reference](./api/sdk/src/index.ts/index.html)

---

### @setu-ts/testing

**Purpose:** Testing utilities for Setu-TS applications.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Utilities:**

- `createTestApp()` - Test application factory
- `inject()` - Test request injection
- `createMockPlugin()` - Mock plugin creator

**Links:**

- [README](../packages/testing/README.md)
- [API Reference](./api/testing/src/index.ts/index.html)

---

## Starters

### @setu-ts/rest-starter

**Purpose:** Opinionated REST API composition library.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Includes:** Runtime, Logger, Config, Validation, Exceptions, DI, Decorators, Auth, HTTP Security,
OpenAPI, Health, Metrics.

**Links:**

- [README](../packages/starters/rest-starter/README.md)
- [API Reference](./api/starters/rest-starter/src/index.ts/index.html)

---

### @setu-ts/microservice-starter

**Purpose:** Opinionated microservice composition library.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

**Includes:** All REST starter plugins + Messaging, Queue, Resilience, Telemetry, Service Discovery.

**Links:**

- [README](../packages/starters/microservice-starter/README.md)
- [API Reference](./api/starters/microservice-starter/src/index.ts/index.html)

---

### @setu-ts/full-stack-starter

**Purpose:** Opinionated full-stack (SSR) composition library.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Includes:** All REST starter plugins + React Router, Session, Database.

**Links:**

- [README](../packages/starters/full-stack-starter/README.md)
- [API Reference](./api/starters/full-stack-starter/src/index.ts/index.html)

---

## Notes

- **Workers Compatibility:** Packages marked ✅ for Workers run on the platform. Packages with
  HTTP-only providers (mail, storage, notification) work when configured with HTTP-based backends.
- **Provider Limitations:** Some packages have providers that are not Workers-compatible (e.g., SMTP
  for mail, raw sockets for messaging). Check individual package documentation.
- **Runtime Detection:** Use `detectRuntime()` from `@setu-ts/runtime` to conditionally enable
  features based on the runtime.
