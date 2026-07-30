# @hono-enterprise/full-stack-starter

Opinionated plugin composition for building full-stack applications with Hono Enterprise.

The most comprehensive starter bundle, combining REST capabilities, microservice patterns, and full-stack features including caching, event-driven architecture, CQRS, scheduling, auditing, secrets management, storage, mail delivery, feature flags, notifications, multi-tenancy, and React SSR support.

## Installation

```bash
deno add jsr:@hono-enterprise/full-stack-starter
```

Or via npm/yarn/pnpm:

```bash
npm install @hono-enterprise/full-stack-starter
```

## Usage

The starter exports `createFullStackApp` — a fully wired application with all enterprise-grade plugins pre-configured:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';

const app = createFullStackApp();

app.get('/hello', () => 'Hello world');

await app.start({ port: 3000 });
```

### With Options

Configure every plugin through the optional options parameter:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';
import type { FullStackStarterOptions } from '@hono-enterprise/full-stack-starter';

const options: FullStackStarterOptions = {
  // REST base plugins (see rest-starter)
  config: { /* ... */ },
  logger: { /* ... */ },
  
  // Microservice additions (see microservice-starter)
  messaging: { /* ... */ },
  queue: { /* ... */ },
  
  // Full-stack additions
  cache: { /* cache plugin options */ },
  events: { /* events plugin options */ },
  cqrs: { /* cqrs plugin options */ },
  scheduler: { /* scheduler plugin options */ },
  audit: { /* audit plugin options */ },
  secrets: { /* secrets plugin options */ },
  storage: { /* storage plugin options */ },
  mail: { /* mail plugin options */ },
  
  // Gated arms (only included when provided)
  featureFlags: { /* feature flags plugin options */ },
  notifications: { /* notification plugin options */ },
  multiTenancy: { /* multi-tenancy plugin options */ },
  reactRouter: { /* react router plugin options */ }
};

const app = createFullStackApp(options);
```

### Advanced Plugin Composition

Use `buildFullStackPlugins` to construct a custom plugin array for advanced scenarios requiring selective inclusion or different ordering:

```typescript
import { buildFullStackPlugins, createApplication } from '@hono-enterprise/full-stack-starter';

const app = createApplication({
  plugins: buildFullStackPlugins({
    cache: true,
    events: true,
    reactRouter: { /* custom SSR config */ }
    // Omit featureFlags, notifications, multiTenancy if not needed
  })
});
```

## Included Plugins

| Category | Plugin | Description |
|----------|--------|-------------|
| **REST Base** | RuntimePlugin | Core runtime integration |
| | ConfigPlugin | Configuration management |
| | LoggerPlugin | Structured logging |
| | ValidationPlugin | Request validation |
| | HttpSecurityPlugin | Security headers |
| | HealthPlugin | Health check endpoints |
| | MetricsPlugin | Metrics collection |
| | OpenApiPlugin | OpenAPI documentation |
| | DecoratorPlugin | Decorator-based routing |
| | DatabasePlugin | Optional database access |
| | AuthPlugin | Optional authentication |
| **Microservice** | MessagingPlugin | Async message bus support |
| | QueuePlugin | Background job queueing |
| | ResiliencePlugin | Circuit breaker & retries |
| | TelemetryPlugin | Tracing & observability |
| **Full-Stack** | CachePlugin | Distributed caching |
| | EventsPlugin | Event publishing/subscribing |
| | CqrsPlugin | CQRS pattern support |
| | SchedulerPlugin | Scheduled task execution |
| | AuditPlugin | Audit trail logging |
| | SecretsPlugin | Secure secret management |
| | StoragePlugin | Object/file storage |
| | MailPlugin | Email delivery |
| | FeatureFlagsPlugin | Dynamic feature toggles |
| | NotificationPlugin | Push/notification service |
| | MultiTenancyPlugin | Tenant isolation |
| | ReactRouterPlugin | React SSR & file-based routing |

Gated plugins (`featureFlags`, `notifications`, `multiTenancy`, `reactRouter`) are only registered when explicitly provided in options.

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/full-stack-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [rest-starter](./../rest-starter/README.md)
- [microservice-starter](./../microservice-starter/README.md)