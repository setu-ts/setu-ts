# @hono-enterprise/common

Shared types, interfaces, and capability tokens for the Hono Enterprise framework.

This package is the framework's contract layer: every other package depends on it, and it depends on
nothing. It contains only interfaces, type aliases, constants, and pure zero-dependency type
utilities — no runtime behavior beyond those.

## Installation

```bash
# Deno
deno add jsr:@hono-enterprise/common

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @hono-enterprise/common
```

## What's Inside

| Area                | Exports                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability tokens   | `CAPABILITIES`, `createCapabilityToken()`, `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                           |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, context APIs (`IRouterApi`, `IMiddlewareApi`, `ILifecycleApi`, …)                                                                                                                                                                               |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory`                                                                                                                                                                                                                                      |
| HTTP abstractions   | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `RouteHandler`, `RouteDefinition`                                                                                                                                                                           |
| Runtime abstraction | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`                                                                                                                                                                                                                                            |
| Optional DI         | `IContainer`, `Provider`, `ServiceScope`                                                                                                                                                                                                                                                     |
| Domain contracts    | `ILogger`, `IConfig`, `IValidationService`, `IHealthIndicator`, `IMetric`, `IJwtService`, `IOrmAdapter`, `ICacheStore`, `IEventBus`, `IMessageBroker`, `IQueue`, `ISecretManager`, `IAuditLogger`, `ICircuitBreaker`, `IStorage`, `IMailer`, `INotifier`, `IFeatureFlags`, `ITenantResolver` |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PLUGIN_PRIORITY`                                                                                                                                                                               |
| Utility types       | `Result<T, E>` (`ok`, `err`, `isOk`, `isErr`, `unwrap`), `Option<T>` (`some`, `none`, `isSome`, `isNone`, `fromNullable`)                                                                                                                                                                    |

## Usage

Resolve capabilities by token, typed by the interfaces defined here:

```typescript
import { CAPABILITIES, type ILogger, type IPlugin } from '@hono-enterprise/common';

export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: [CAPABILITIES.LOGGER],
    register(ctx) {
      const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
      logger.info('my-plugin registered');
    },
  };
}
```

Handle fallible operations without throwing:

```typescript
import { err, ok, type Result } from '@hono-enterprise/common';

function parsePort(raw: string): Result<number, RangeError> {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? ok(port)
    : err(new RangeError(`Invalid port: ${raw}`));
}
```

## Rules

- Zero dependencies, always.
- No runtime-specific APIs — ever.
- Every export is public API: documented in the repository's `PUBLIC_API.md`, JSDoc'd, and covered
  by the backward-compatibility policy.

See the repository's [`PUBLIC_API.md`](../../PUBLIC_API.md) for the full API contract and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for how this package fits the plugin architecture.
