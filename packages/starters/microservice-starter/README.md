# @hono-enterprise/microservice-starter

Opinionated plugin composition for building microservices with Hono Enterprise.

Extends the REST starter bundle with additional capabilities essential for distributed systems:
messaging, queue processing, resilience patterns, and telemetry. Ideal for service-oriented
architectures requiring async communication, circuit breakers, and observability.

## Installation

```bash
deno add jsr:@hono-enterprise/microservice-starter
```

Or via npm/yarn/pnpm:

```bash
npm install @hono-enterprise/microservice-starter
```

## Usage

The starter exports `createMicroserviceApp` — a fully wired application combining REST plugins plus
microservice-specific features:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';

const app = createMicroserviceApp();

app.get('/hello', () => 'Hello world');

await app.start({ port: 3000 });
```

### With Options

Customize all plugin configurations through the optional options parameter:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';
import type { MicroserviceStarterOptions } from '@hono-enterprise/microservice-starter';

const options: MicroserviceStarterOptions = {
  // REST base plugins (see rest-starter)
  config: {/* ... */},
  logger: {/* ... */},

  // Microservice additions
  messaging: {/* messaging plugin options */},
  queue: {/* queue plugin options */},
  resilience: {/* resilience plugin options */},
  telemetry: {/* telemetry plugin options */},
};

const app = createMicroserviceApp(options);
```

### Advanced Plugin Composition

Use `buildMicroservicePlugins` to construct a custom plugin array with full control over ordering
and configuration:

```typescript
import { buildMicroservicePlugins, createApplication } from '@hono-enterprise/microservice-starter';

const app = createApplication({
  plugins: buildMicroservicePlugins({
    messaging: true,
    queue: {/* custom config */},
    telemetry: false, // exclude if not needed
  }),
});
```

## Included Plugins

| Category         | Plugin             | Description               |
| ---------------- | ------------------ | ------------------------- |
| **REST Base**    | RuntimePlugin      | Core runtime integration  |
|                  | ConfigPlugin       | Configuration management  |
|                  | LoggerPlugin       | Structured logging        |
|                  | ValidationPlugin   | Request validation        |
|                  | HttpSecurityPlugin | Security headers          |
|                  | HealthPlugin       | Health check endpoints    |
|                  | MetricsPlugin      | Metrics collection        |
|                  | OpenApiPlugin      | OpenAPI documentation     |
|                  | DecoratorPlugin    | Decorator-based routing   |
|                  | DatabasePlugin     | Optional database access  |
|                  | AuthPlugin         | Optional authentication   |
| **Microservice** | MessagingPlugin    | Async message bus support |
|                  | QueuePlugin        | Background job queueing   |
|                  | ResiliencePlugin   | Circuit breaker & retries |
|                  | TelemetryPlugin    | Tracing & observability   |

All microservice plugins are enabled by default; individual plugins can be configured or omitted via
options.

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/microservice-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [rest-starter](./../rest-starter/README.md)
