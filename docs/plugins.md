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

Most packages depend on nothing but their `@setu-ts/*` siblings. Where a package offers a driver — a
Redis client, a cloud SDK, a database ORM — it declares that driver as an **optional peer
dependency**, and the rule is always the same: **nothing is imported until you select the arm that
needs it.** Choosing `MemoryStore` never loads `ioredis`; choosing `LogProvider` never loads
`nodemailer`.

Three packages are the exception, and the table marks them `always`: for `graphql-plugin`,
`grpc-plugin` and `react-router-plugin` the driver **is** the capability rather than one choice
among several, so there is nothing to select. Their driver is still an optional peer, so it is still
yours to install.

**A package manager never installs an optional peer.** Installing `@setu-ts/messaging-plugin` brings
none of its six broker clients; selecting the Kafka arm without `kafkajs` installed fails at startup
with `OptionalDependencyUnavailableError` naming the package and its installation location. Install
the driver for the arm you select, beside the plugin:

```bash
npm install @setu-ts/messaging-plugin kafkajs
# Deno: deno add npm:@setu-ts/messaging-plugin npm:kafkajs
```

`setu new --broker`/`--queue` and a workspace's `--transport` already add the client for the arm
they wire. `setu add` records peers for the default arm it wires (for example the console telemetry
exporter); any other arm you select by hand needs its driver installed as above.

### Optional peers in a workspace

Install an optional peer **where the framework package that loads it is installed**, within the
version range that package declares for it (in its `peerDependencies`, or `dependencies` for the few
loaders that declare their package as a regular dependency). In an npm, Yarn or Bun workspace this
is usually the workspace root. A hoisted framework package resolves imports from its own location: a
peer nested under a member is invisible to it. Conflicting member pins can also produce two copies
of a peer, including incompatible versions.

The startup symptom is `Optional dependency '<d>' could not be loaded by '<package>'`, followed by
the instruction to install it where that package is installed. Check the installed framework
package's `package.json` for its peer ranges rather than installing the latest upstream major.

Since 0.11.0, `setu add <plugin> --dir apps/<member>` in a listed Node or Bun Setu workspace records
the peers it supplies in the member's `package.json` `dependencies` and, when the root has a
`package.json`, in the root's too. It leaves a peer already declared in `dependencies`,
`optionalDependencies` or a non-optional `peerDependencies` as it is, adds a peer marked optional in
`peerDependenciesMeta` to `dependencies` at its own spec (it installs nothing otherwise), moves one
declared only in `devDependencies` to `dependencies` with its pin unchanged (`--omit=dev` would drop
it), records a peer the root's `overrides` pins (a string value, or an object's `"."` entry) at the
override's own spec (npm refuses a direct dependency whose spec differs from its override), leaves a
`$name` reference or a conditional override (a version-selector key such as `ioredis@5`, or several
rules for one package) to you with a printed line, still writes the root entry at the CLI's range
when a workspace member pins the peer at a different spec, printing a note that names the member and
its pin since npm may install a second copy for it, refuses a root `package.json` that is JSONC or
invalid JSON by name, and prints every edited path; run the printed install command from the
workspace root. The member entry also supports building the member outside the workspace. Deno
workspaces, standalone projects, pnpm workspaces and hand-built Yarn workspaces keep their existing
behavior; place peers manually when needed. `setu add` still refuses a workspace root as its target.

Three packages carry a real (non-optional) dependency beyond their siblings: `kernel` depends on
`hono` (its router), `runtime` on `@hono/node-server` (the Node adapter), and `view-plugin` on
`hono` (both view engines).

### Which packages declare drivers

Every package NOT listed here declares no optional driver — that includes `common`, `kernel`,
`exceptions`, `sdk`, `cloudflare-plugin`, `session-plugin`, `validation-plugin`, `openapi-plugin`,
`static-plugin`, `websocket-plugin`, `worker-pool-plugin`, `diagnostics-plugin`, `view-plugin`, and
the three starters. `cli` is on that list too, which is worth saying out loud because its source is
full of package names: those are DATA it writes into a generated project's manifest, not specifiers
it imports.

| Package                     | Optional peer drivers                                                                                                                                                         | Arm that needs them                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `auth-plugin`               | `ioredis`, `@node-saml/node-saml`                                                                                                                                             | `RedisRateLimitStore`; a `saml` sign-in provider (needs `nodejs_compat` on Workers) |
| `cache-plugin`              | `ioredis`                                                                                                                                                                     | `store: 'redis'`                                                                    |
| `database-plugin`           | `drizzle-orm`, `mongodb`, `@aws-sdk/client-dynamodb`, `@azure/cosmos`, `@google-cloud/bigtable`                                                                               | the matching `type` arm (Prisma and D1 are inject-only — neither declares a driver) |
| `feature-flags-plugin`      | `@launchdarkly/node-server-sdk`                                                                                                                                               | `provider: 'launchdarkly'`                                                          |
| `graphql-plugin`            | `graphql`                                                                                                                                                                     | always (the execution engine)                                                       |
| `grpc-plugin`               | `@connectrpc/connect`, `@bufbuild/protobuf`                                                                                                                                   | always (the RPC runtime)                                                            |
| `logger-plugin`             | `pino`                                                                                                                                                                        | `PinoLogger`                                                                        |
| `mail-plugin`               | `nodemailer`, `@aws-sdk/client-sesv2`                                                                                                                                         | `smtp` / `ses` providers                                                            |
| `messaging-plugin`          | `ioredis`, `amqplib`, `kafkajs`, `nats`, `@google-cloud/pubsub`, `@azure/service-bus`                                                                                         | the matching broker                                                                 |
| `queue-plugin`              | `ioredis`, `amqplib`, `@aws-sdk/client-sqs`, `@aws-sdk/client-sns`                                                                                                            | the matching adapter                                                                |
| `react-router-plugin`       | `react-router`                                                                                                                                                                | always (SSR request handler)                                                        |
| `realtime-backplane-plugin` | `ioredis`                                                                                                                                                                     | `transport: 'redis'`                                                                |
| `runtime`                   | `ws`                                                                                                                                                                          | the Node WebSocket adapter                                                          |
| `scheduler-plugin`          | `ioredis`                                                                                                                                                                     | `RedisLock`                                                                         |
| `secrets-plugin`            | `@aws-sdk/client-secrets-manager`, `@google-cloud/secret-manager`, `@azure/identity`, `@azure/keyvault-secrets`                                                               | the matching cloud provider                                                         |
| `storage-plugin`            | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@google-cloud/storage`, `@azure/storage-blob`                                                                         | the matching provider                                                               |
| `telemetry-plugin`          | `@opentelemetry/{api,resources,sdk-trace-base,exporter-trace-otlp-http,context-async-hooks}` and `@opentelemetry/instrumentation-{http,undici,ioredis,redis,amqplib,kafkajs}` | any non-noop exporter, or `instrumentations`                                        |

The three `always` rows — `graphql-plugin`, `grpc-plugin` and `react-router-plugin` — have no
zero-driver arm, and none of them claims one. Everything else here is genuinely optional: the arm
named beside it is the only thing that loads it.

Every driver above can also be supplied by **injection** instead, through the plugin's own options
(`DatabasePlugin({ client })`, `CachePlugin({ client })`, and so on). An application that injects
its own client never triggers the lazy import at all — see
[AI_GUIDELINES §12.2](https://github.com/setu-ts/setu-ts/blob/main/AI_GUIDELINES.md).

**node-redis.** Every `ioredis` row above can run on
[node-redis](https://www.npmjs.com/package/redis) (`redis` v5 or v6) through that injection: wrap a
client in `fromNodeRedis` from `@setu-ts/common` and pass it as the plugin's `client` (the backplane
takes `client` and `subscriber`). `ioredis` is then never loaded, and `redis` is your application's
own dependency, which no Setu-TS package declares. Traces come from `instrumentations.redis` in
`telemetry-plugin`, on Node only. See
[Using node-redis](https://github.com/setu-ts/setu-ts/blob/main/packages/common/README.md#using-node-redis-0110)
and `setu new --redis-client node-redis` in [the CLI guide](./cli.md#choosing-the-redis-client).

## Tier 1: Core Infrastructure

### @setu-ts/common

**Purpose:** Shared types, interfaces, and capability tokens used across all packages.

**Capability Token:** N/A (contracts and shared pure utilities)

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
- [API Reference](./api/modules/common_src.html)

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

- `createApplication()` - Application factory; its only value export. The router, service registry
  and pipeline are reached through the application (`app.router`, `app.services`, `app.middleware`),
  not imported

**Links:**

- [README](../packages/kernel/README.md)
- [API Reference](./api/modules/kernel_src.html)

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
- [API Reference](./api/modules/runtime_src.html)

---

## Tier 2: Essential Plugins

### @setu-ts/di-plugin

**Purpose:** Optional dependency injection container with constructor injection and scope
management.

**Capability Token:** `CAPABILITIES.DI_CONTAINER`

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
- [API Reference](./api/modules/di-plugin_src.html)

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
- [API Reference](./api/modules/decorator-plugin_src.html)

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
- [API Reference](./api/modules/logger-plugin_src.html)

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
- [API Reference](./api/modules/config-plugin_src.html)

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
- [API Reference](./api/modules/validation-plugin_src.html)

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
- [API Reference](./api/modules/exceptions_src.html)

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
- [API Reference](./api/modules/openapi-plugin_src.html)

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
- Prisma (an injected Prisma v7 client)
- Drizzle (an injected Drizzle database, wrapped with `createDrizzleDatabase`)
- MongoDB (via mongodb)
- DynamoDB (via @aws-sdk/client-dynamodb)
- Azure Cosmos DB (via @azure/cosmos)
- Cloud Bigtable (via @google-cloud/bigtable)
- Custom (`type: 'custom'`), for example `D1Adapter` from `cloudflare-plugin`

**Links:**

- [README](../packages/database-plugin/README.md)
- [API Reference](./api/modules/database-plugin_src.html)

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
- Redis (via ioredis)
- Cloudflare KV

**Links:**

- [README](../packages/cache-plugin/README.md)
- [API Reference](./api/modules/cache-plugin_src.html)

---

### @setu-ts/auth-plugin

**Purpose:** Authentication and authorization with JWT and API key support.

**Capability Token:** `CAPABILITIES.AUTH`, `CAPABILITIES.AUTHORIZATION`

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
- Tokens from an outside issuer, verified against its published key set (`issuers`)
- Sign-in with an outside provider: OpenID Connect, OAuth 2.0 and SAML 2.0 (`signIn`)
- Multi-factor authentication: TOTP with recovery codes, and passkeys (WebAuthn)

**Links:**

- [README](../packages/auth-plugin/README.md)
- [API Reference](./api/modules/auth-plugin_src.html)

---

### @setu-ts/messaging-plugin

**Purpose:** Message broker integration for event-driven architectures.

**Capability Token:** `CAPABILITIES.MESSAGING`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers                        |
| ---- | ---- | --- | ------------------------------ |
| ✅   | ✅   | ✅  | ❌ (see the Cloudflare plugin) |

**Brokers:**

- In-memory (built-in)
- Redis Streams (via ioredis)
- RabbitMQ (via amqplib)
- NATS (via nats)
- Kafka (via kafkajs)
- GCP Pub/Sub (via @google-cloud/pubsub)
- Azure Service Bus (via @azure/service-bus)

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
- Durable delivery where the broker provides it

**Links:**

- [README](../packages/messaging-plugin/README.md)
- [API Reference](./api/modules/messaging-plugin_src.html)

---

### @setu-ts/queue-plugin

**Purpose:** Job queue with retries, scheduling, and multiple backends.

**Capability Token:** `CAPABILITIES.QUEUE`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers                        |
| ---- | ---- | --- | ------------------------------ |
| ✅   | ✅   | ✅  | ❌ (see the Cloudflare plugin) |

**Adapters:**

- Memory (built-in)
- Redis (via ioredis)
- RabbitMQ (via amqplib)
- SQS (via @aws-sdk/client-sqs)

> Workers Queues belong to [`@setu-ts/cloudflare-plugin`](#setu-tscloudflare-plugin), not this
> package — the queue-plugin adapters all need raw sockets or an npm SDK unavailable on the edge.

**Links:**

- [README](../packages/queue-plugin/README.md)
- [API Reference](./api/modules/queue-plugin_src.html)

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
- Aggregate-local recording (`createDomainEvents`)
- Forwarding to a broker through `messaging-plugin`'s `EventsMessagingBridge`

**Links:**

- [README](../packages/events-plugin/README.md)
- [API Reference](./api/modules/events-plugin_src.html)

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
- [API Reference](./api/modules/cqrs-plugin_src.html)

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
- [API Reference](./api/modules/metrics-plugin_src.html)

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
- [API Reference](./api/modules/health-plugin_src.html)

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
- [API Reference](./api/modules/telemetry-plugin_src.html)

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
- [API Reference](./api/modules/scheduler-plugin_src.html)

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
- [API Reference](./api/modules/secrets-plugin_src.html)

---

### @setu-ts/audit-plugin

**Purpose:** Audit logging with pluggable storage.

**Capability Token:** `CAPABILITIES.AUDIT`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers                             |
| ---- | ---- | --- | ----------------------------------- |
| ✅   | ✅   | ✅  | ✅ (memory, log, injected database) |

**Storage:**

- Memory (default)
- File (JSONL)
- Database (an injected client)
- Log (routes each entry to the logger; `query()` returns `[]`)

**Links:**

- [README](../packages/audit-plugin/README.md)
- [API Reference](./api/modules/audit-plugin_src.html)

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
- [API Reference](./api/modules/resilience-plugin_src.html)

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
- [API Reference](./api/modules/storage-plugin_src.html)

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
- [API Reference](./api/modules/mail-plugin_src.html)

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
- [API Reference](./api/modules/notification-plugin_src.html)

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
- LaunchDarkly (lazy-loads the Node server SDK)

**Links:**

- [README](../packages/feature-flags-plugin/README.md)
- [API Reference](./api/modules/feature-flags-plugin_src.html)

---

### @setu-ts/multi-tenancy-plugin

**Purpose:** Multi-tenancy with multiple isolation strategies.

**Capability Token:** `CAPABILITIES.MULTI_TENANCY`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Strategies:**

- Column isolation (the shipped memory store)
- Schema and database isolation (names a strategy an injected `dataStore` implements; the memory
  store refuses both at startup)

**Resolvers:**

- Subdomain
- Header
- Path
- JWT

**Links:**

- [README](../packages/multi-tenancy-plugin/README.md)
- [API Reference](./api/modules/multi-tenancy-plugin_src.html)

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
- [API Reference](./api/modules/session-plugin_src.html)

---

### @setu-ts/idempotency-plugin

**Purpose:** A repeat of a completed HTTP request, queue job or broker message is answered from its
record or skipped instead of running again, over one claim/complete/release state machine and an
in-process, Redis or Cloudflare Durable Object store. A failure after an external side effect but
before `complete` can still repeat that effect; see the package README for the limits.

**Capability Token:** `CAPABILITIES.IDEMPOTENCY`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- `idempotent()` middleware for a route's `middleware` array and `idempotentIngress()` for queue and
  broker behaviours on an explicit allow-list
- An in-process store, a Redis store (atomic Lua, inject-or-lazy ioredis) and, from
  `@setu-ts/cloudflare-plugin`, a Durable Object store
- The `idempotency` health indicator: lifecycle truth then a bounded store probe

> On Cloudflare Workers, HTTP is supported through the Durable Object store; the ingress entry point
> is not available there in this release. The guarantee is no duplicate processing within the limits
> of the store, not a single-execution guarantee.

**Links:**

- [README](../packages/idempotency-plugin/README.md)
- [API Reference](./api/modules/idempotency-plugin_src.html)

---

### @setu-ts/localization-plugin

**Purpose:** Message catalogues per locale, request locale resolution, and a formatter shared with
the browser.

**Capability Token:** `CAPABILITIES.LOCALIZATION`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

**Features:**

- Catalogues validated at startup; plural forms through `Intl.PluralRules`
- Locale resolved from query, cookie, `Accept-Language` or a tenant default into
  `ctx.request.locale`
- `Vary` and `Content-Language` headers; `cache-plugin` keys on the locale
- An import-free `/format` subpath for browsers and SDK clients

> Locale data comes from each runtime's `Intl`, so a thin ICU build can lack a locale — the plugin
> refuses such a tag at startup rather than silently formatting in the runtime's default.

**Links:**

- [README](../packages/localization-plugin/README.md)
- [API Reference](./api/modules/localization-plugin_src.html)

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
- [API Reference](./api/modules/cloudflare-plugin_src.html)

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
- [API Reference](./api/modules/grpc-plugin_src.html)

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
- [API Reference](./api/modules/graphql-plugin_src.html)

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
- [API Reference](./api/modules/react-router-plugin_src.html)

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
- [API Reference](./api/modules/sse-plugin_src.html)

---

### @setu-ts/view-plugin

**Purpose:** Server-rendered HTML as a capability — view engines for JSX and html-tag components,
named by reference.

**Capability Token:** `CAPABILITIES.VIEW`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ✅      |

> Views are pure functions rendered to strings — no filesystem, no sockets — so the capability is
> portable by construction. A tree holding a pending `<Suspense>` boundary is refused by name
> (`UnresolvedSuspenseError`) rather than served as its fallback forever; streaming resolution is
> deferred to a follow-up milestone.

**Links:**

- [README](../packages/view-plugin/README.md)
- [API Reference](./api/modules/view-plugin_src.html)

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
- [API Reference](./api/modules/websocket-plugin_src.html)

---

### @setu-ts/diagnostics-plugin

**Purpose:** Authenticated local diagnostics connector — signed loopback polling between a native
devtool client and kernel diagnostics (M98a).

**Capability Token:** `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER` (consumed; provided by the
RuntimePlugin)

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ❌   | ❌  | ❌      |

**Links:**

- [README](../packages/diagnostics-plugin/README.md)
- [API Reference](./api/modules/diagnostics-plugin_src.html)

### @setu-ts/worker-pool-plugin

**Purpose:** CPU-intensive tasks on worker threads.

**Capability Token:** `CAPABILITIES.WORKER_POOL`

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ✅  | ❌      |

**Links:**

- [README](../packages/worker-pool-plugin/README.md)
- [API Reference](./api/modules/worker-pool-plugin_src.html)

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
- [API Reference](./api/modules/realtime-backplane-plugin_src.html)

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
- [API Reference](./api/modules/static-plugin_src.html)

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
- [API Reference](./api/modules/service-discovery-plugin_src.html)

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
- [API Reference](./api/modules/http-security-plugin_src.html)

---

## Tooling

### @setu-ts/cli

**Purpose:** Command-line interface for scaffolding and code generation.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ❌  | N/A     |

The table describes the importable package. The `setu` command itself is a Node program (Node 22 or
later), published to npm with a `bin`; `--runtime` scaffolds projects for all four runtimes, Node by
default.

**Commands:**

- `setu new <name>` - Create a new project (`--template rest|microservice|class-based|full-stack`,
  `--style functional|class-based`, `--runtime node|deno|bun|cloudflare-workers`, Node by default);
  `--style class-based` opts into decorators and dependency injection together on `rest` and
  `microservice`, and `--template class-based` is a byte-identical alias of
  `--template rest --style class-based`
- `setu new <name> --workspace` - Create a monorepo root (`--port`, `--transport`)
- `setu generate <type> <name>` - Generate code; 16 schematics, every one except `guard`,
  `migration` and (in a functional project) `service` and `job` wired into a registration site with
  no edit to a file you own
- `setu generate app <name>` - Add a service to a workspace, allocating its port and registering it
  in every sibling's discovery map
- `setu commands` - List the commands this project's plugins provide

**Installation:**

```bash
npx @setu-ts/cli new my-app
npm install --global @setu-ts/cli
```

**Links:**

- [CLI Guide](./cli.md)
- [README](../packages/cli/README.md)
- [API Reference](./api/modules/cli_src.html)

---

### @setu-ts/create

**Purpose:** The `npm create @setu-ts` entry point — `setu new` with the caller's arguments.

**Runtime Compatibility:**

| Deno | Node | Bun | Workers |
| ---- | ---- | --- | ------- |
| ✅   | ✅   | ❌  | N/A     |

The table describes the importable package (`createArgs`). The `create` executable is run by
`npm create` on Node, and accepts exactly what `setu new` accepts.

**Installation:**

```bash
npm create @setu-ts my-app -- --template rest
```

**Links:**

- [README](../packages/create/README.md)
- [API Reference](./api/modules/create_src.html)

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
- [API Reference](./api/modules/sdk_src.html)

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
- [API Reference](./api/modules/testing_src.html)

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
- [API Reference](./api/modules/starters_rest-starter_src.html)

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
- [API Reference](./api/modules/starters_microservice-starter_src.html)

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
- [API Reference](./api/modules/starters_full-stack-starter_src.html)

---

## Notes

- **Workers Compatibility:** Packages marked ✅ for Workers run on the platform. Packages with
  HTTP-only providers (mail, storage, notification) work when configured with HTTP-based backends.
- **Provider Limitations:** Some packages have providers that are not Workers-compatible (e.g., SMTP
  for mail, raw sockets for messaging). Check individual package documentation.
- **Runtime Detection:** Use `detectRuntime()` from `@setu-ts/runtime` to conditionally enable
  features based on the runtime.
