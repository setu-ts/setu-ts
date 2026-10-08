# Plugin Architecture

The Setu-TS framework is built around a plugin architecture. The kernel provides the router, the
middleware pipeline, the service registry and the lifecycle; every capability on top of that —
configuration, logging, database access, authentication and the rest — is a plugin.

## Core Concepts

### What is a Plugin?

A plugin is a modular unit of functionality that can be registered with your application. Plugins:

- **Register services** in the service registry under capability tokens
- **Add middleware** to the request pipeline
- **Register routes** and route handlers
- **Contribute lifecycle hooks** for initialization and cleanup
- **Register health checks** and metrics
- **Contribute CLI commands**
- **Register decorators** (when using the decorator plugin)

### The Plugin Contract

Every plugin implements the `IPlugin` interface:

```typescript
import type { CapabilityToken, IPluginContext } from '@setu-ts/common';

interface IPlugin {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: readonly CapabilityToken[]; // Must be provided, or startup fails
  readonly optionalDependencies?: readonly CapabilityToken[]; // Ordered first when present
  readonly provides?: readonly CapabilityToken[]; // Tokens this plugin registers
  readonly consumes?: readonly CapabilityToken[]; // Tokens it reads; a warning if unprovided
  readonly priority?: number; // Registration order among unrelated plugins (lower = first)
  register(ctx: IPluginContext): void | Promise<void>;
}
```

### Capability Tokens

Plugins communicate via **capability tokens** - simple string identifiers that represent
capabilities:

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

// Use the predefined tokens
app.register(RuntimePlugin()); // Provides: CAPABILITIES.RUNTIME
app.register(LoggerPlugin()); // Provides: CAPABILITIES.LOGGER

// Access services via tokens
const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
```

### Creating Custom Capability Tokens

For custom plugins, create typed capability tokens:

```typescript
import { createCapabilityToken } from '@setu-ts/common';

// Token names must be lowercase kebab-case with dot namespacing
const PAYMENT_GATEWAY = createCapabilityToken('acme.payment-gateway');
const ANALYTICS_SERVICE = createCapabilityToken('acme.analytics');
```

**Token naming rules:**

- Lowercase letters, numbers, and hyphens only
- Dot notation for namespacing (e.g., `acme.payment-gateway`)
- No colons or special characters
- Must be unique within your application

## Service Registry

The service registry is the heart of the plugin system. Plugins register services, and other
plugins/consumers resolve them by token.

### Registering Services

```typescript
import type { RegisterOptions } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

async function registerServices(ctx: IPluginContext) {
  // Register a service
  ctx.services.register(CAPABILITIES.CACHE, new MyService());

  // Register with options
  const options: RegisterOptions = {
    override: true, // Replace existing registration
    multi: true, // Allow multiple providers
  };
  ctx.services.register(CAPABILITIES.CACHE, new MyService(), options);

  // Register a factory (lazy instantiation)
  ctx.services.registerFactory(CAPABILITIES.CACHE, () => new MyService());
}
```

### Resolving Services

```typescript
// Get a service
const service = ctx.services.get<MyService>('my-service');

// Check if available
if (ctx.services.has('my-service')) {
  // Service is available
}

// Get all providers (if multi-provider was registered)
const providers = ctx.services.getAll<MyService>('my-service');
```

## Middleware Pipeline

Plugins can add middleware to the request processing pipeline.

### Adding Middleware

```typescript
import type { MiddlewareFunction, MiddlewareOptions } from '@setu-ts/common';

async function addMiddleware(ctx: IPluginContext) {
  // Add middleware with default priority
  ctx.middleware.add(async (requestCtx, next) => {
    console.log('Before request');
    await next();
    console.log('After request');
  });

  // Add middleware with specific priority
  const middlewareOptions: MiddlewareOptions = { priority: 15 };
  ctx.middleware.add(
    async (requestCtx, next) => {
      // Middleware logic
      await next();
    },
    middlewareOptions,
  );
}
```

### Middleware Priorities

The default middleware priority order:

| Priority | Middleware                          | Registered by                                       |
| -------- | ----------------------------------- | --------------------------------------------------- |
| 0        | `errorHandler()`                    | The application (the starters and `setu new` do it) |
| 20       | Metrics collection                  | `MetricsPlugin`                                     |
| 30       | Request tracing                     | `TelemetryPlugin`                                   |
| 40       | Tenant resolution                   | `MultiTenancyPlugin`                                |
| 45       | Locale resolution                   | `LocalizationPlugin`                                |
| 100      | Request logging                     | `LoggerPlugin`                                      |
| 120      | IP allow/deny lists                 | `HttpSecurityPlugin`                                |
| 180      | Request size limit                  | `HttpSecurityPlugin`                                |
| 200      | CORS                                | `HttpSecurityPlugin`                                |
| 250      | Security headers                    | `HttpSecurityPlugin`                                |
| 260      | Session load and commit             | `SessionPlugin`                                     |
| 270      | Origin-based CSRF check             | `HttpSecurityPlugin`                                |
| 275      | Form CSRF (synchronizer)            | `SessionPlugin`                                     |
| 300      | Authentication                      | `AuthPlugin`                                        |
| 500      | Middleware added with no `priority` | The application                                     |

Lower numbers run first on the way in and last on the way out. Route-level middleware (a route's
`middleware` list, or a decorator's guards) runs after all of these, just before the handler.

## Plugin Context

The `IPluginContext` provides access to all framework capabilities during plugin registration:

```typescript
interface IPluginContext {
  // Service registry
  services: IServiceRegistry;

  // Middleware pipeline
  middleware: IMiddlewareApi;

  // Router
  router: IRouterApi;

  // Configuration
  config?: IConfig;

  // Environment validation
  environment: IEnvironmentApi;

  // Health checks
  health: IHealthApi;

  // Metrics
  metrics: IMetricsApi;

  // OpenAPI contributions
  openapi: IOpenApiApi;

  // Decorators
  decorators: IDecoratorApi;

  // CLI commands
  cli: ICliApi;

  // Lifecycle hooks
  lifecycle: ILifecycleApi;

  // Runtime services (always available)
  runtime: IRuntimeServices;

  // Optional services (may be undefined)
  logger?: ILogger;
  metadata?: IMetadataStore;
  container?: IContainer;

  // Plugin-specific options
  options: Readonly<Record<string, unknown>>;

  // Application instance
  app: IApplication;
}
```

## Lifecycle Hooks

Plugins can register lifecycle hooks to respond to application events:

```typescript
async function registerLifecycleHooks(ctx: IPluginContext) {
  // After every plugin's register(): every capability is now resolvable
  ctx.lifecycle.onInit(() => {
    // Initialization logic
  });

  // After every onInit, before the server binds its port
  ctx.lifecycle.onBootstrap(() => {
    // Bootstrap logic
  });

  // Per-request hooks
  ctx.lifecycle.onRequest((requestCtx) => {
    // Request started
  });

  ctx.lifecycle.onResponse((requestCtx) => {
    // Response completed
  });

  // Error handling
  ctx.lifecycle.onError((error, requestCtx) => {
    // Handle error
  });

  // First thing in stop(), while the app still serves: deregister from discovery
  ctx.lifecycle.onStopping(() => {
    // Stop new traffic arriving
  });

  // The app now refuses requests and the socket is closed: close connections
  ctx.lifecycle.onShutdown(() => {
    // Close connections, flush buffers
  });

  // After shutdown completes
  ctx.lifecycle.onClose(() => {
    // Release remaining resources
  });
}
```

## Plugin Dependencies

### Hard Dependencies

Hard dependencies must be present for your plugin to work:

```typescript
const MyPlugin: IPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.LOGGER], // Will fail if missing
  register(ctx) {
    // ctx.logger is guaranteed to be available
  },
};
```

### Optional Dependencies

Optional dependencies are used when available:

```typescript
const MyPlugin: IPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  optionalDependencies: [CAPABILITIES.CACHE], // Works without it
  register(ctx) {
    if (ctx.services.has(CAPABILITIES.CACHE)) {
      // Use cache
    } else {
      // Fallback behavior
    }
  },
};
```

### Consumes (Soft Dependencies)

The `consumes` field declares capabilities your plugin reads. Startup does not fail when one is
missing; the kernel logs a warning through the registered logger, and says nothing when no logger is
registered:

```typescript
const MyPlugin: IPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  consumes: [CAPABILITIES.METRICS], // Warning if missing, but doesn't fail
  register(ctx) {
    // Plugin works but logs a warning if metrics not available
  },
};
```

## Plugin Priority

Plugins with lower priority values register first:

```typescript
const EarlyPlugin = {
  name: 'early',
  priority: 10,
  // Registers first
};

const LatePlugin = {
  name: 'late',
  priority: 100,
  // Registers last
};
```

**Default priority:** `500` — the `PLUGIN_PRIORITY.NORMAL` band from
[`@setu-ts/common`](../packages/common/src/types.ts). The well-known bands are `HIGHEST` (0), `HIGH`
(100), `NORMAL` (500), `OPENAPI` (700), `LOW` (900), and `LOWEST` (1000); any number is a valid
priority, and these constants mark the conventional ordering relative to first-party middleware (see
the middleware priority table above).

## Plugin Replacement

A capability has one provider, so replacing a plugin means registering yours **instead of** the
original. Registering both fails at startup with
`Capability 'logger' is provided by both 'logger-plugin' and 'custom-logger'`.

```typescript
// Register a custom logger plugin in place of LoggerPlugin, not beside it
app.register(CustomLoggerPlugin());
```

To replace one service while keeping the rest of a plugin, register it under the same token with
`{ override: true }` from a plugin that runs later.

## Runtime Independence

Plugins should be runtime-independent whenever possible:

```typescript
async function useRuntimeIndependently(ctx: IPluginContext) {
  // Use runtime services instead of platform-specific APIs
  const uuid = ctx.runtime.uuid();
  const env = ctx.runtime.env;
  const now = ctx.runtime.now();

  // Check platform if needed
  const platform = ctx.runtime.platform();
  if (platform === 'cloudflare-workers') {
    // Workers-specific logic
  }
}
```

## Best Practices

### 1. Keep Plugins Focused

Each plugin should have a single responsibility. Split large plugins into smaller, composable units.

### 2. Use Capability Tokens

Always use capability tokens from `@setu-ts/common` or create your own with
`createCapabilityToken()`. Never hardcode token strings.

### 3. Handle Missing Dependencies Gracefully

Check for optional dependencies before using them:

```typescript
if (ctx.services.has(CAPABILITIES.CACHE)) {
  const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
  // Use cache
}
```

### 4. Clean Up Resources

Always register cleanup hooks:

```typescript
ctx.lifecycle.onClose(() => {
  // Release file handles, database connections, etc.
});
```

### 5. Document Your Plugin

Provide clear documentation:

- What the plugin does
- Required and optional dependencies
- Configuration options
- Usage examples

## Testing Plugins

Plugins should be tested in isolation and in integration:

```typescript
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('MyPlugin', () => {
  it('registers services correctly', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MyPlugin(undefined)],
    });

    expect(app.services.has('my-service')).toBe(true);
    await app.stop();
  });

  it('adds middleware to the pipeline', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MyPlugin(undefined)],
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/test',
    });

    // Assert middleware behavior
    await app.stop();
  });
});
```

`createTestApp` starts the application, and a plugin cannot be registered after `start()`: pass
every plugin in `plugins`. To test your real composition instead, pass your app factory:
`createTestApp({ app: createApp() })`.

## Next Steps

- [Programmatic API](./programmatic-api.md) - Complete API reference
- [Custom Plugin Development](./custom-plugins.md) - Build your own plugins
- [Plugin Catalog](./plugins.md) - Explore built-in plugins
