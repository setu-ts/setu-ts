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

Use `buildMicroservicePlugins` together with `createApplication` from the kernel to construct a
custom plugin array with full control over ordering and configuration:

```typescript
import { buildMicroservicePlugins } from '@hono-enterprise/microservice-starter';
import { createApplication } from '@hono-enterprise/kernel';

const app = createApplication({
  plugins: buildMicroservicePlugins({
    messaging: {}, // provide options object; omit to use default
    queue: {/* custom config */},
    // telemetry omitted to exclude (no-op default)
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

### Workers Portability

This starter bundles **MessagingPlugin** and **QueuePlugin**, which require raw network sockets
(TCP/UDP) and are therefore **not compatible with Cloudflare Workers**. This starter is for Node.js,
Deno, or Bun runtimes only — matching the CLI's refusal of
`--template microservice --runtime cloudflare-workers`. The REST base plugins (Runtime, Config,
Logger, etc.) are all edge-safe.

### Multi-instance Restriction + Escape Hatch

The four multi-instance plugins (**cache**, **database**, **queue**, **messaging**) accept an
`options.name` parameter that creates a derived capability token. The starter registers **one
instance per arm on the bare token** (e.g., `CAPABILITIES.CACHE`, `CAPABILITIES.MESSAGING`). Setting
`name` through a starter arm moves the plugin off the bare token, which will break any code that
resolves the capability (including health checks and documentation examples).

The starter does **not** support setting `name` through its option arms. If you need a second
instance (e.g., a session cache distinct from the default, or a separate queue for dead-letter
processing), register it manually after the starter returns:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

const app = createMicroserviceApp();
app.register(CachePlugin({ name: 'session' }));
app.register(QueuePlugin({ name: 'dead-letter' }));
```

This escape hatch works because `createMicroserviceApp` returns an un-started `IKernelApplication`
that accepts additional registrations.

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/microservice-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [rest-starter](./../rest-starter/README.md)
