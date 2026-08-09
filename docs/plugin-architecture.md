# Plugin Architecture

The Setu-TS framework is built around a powerful, flexible plugin architecture. Every capability in
the framework is implemented as a plugin, from routing and middleware to database access and
authentication.

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
interface IPlugin {
  name: string;
  version: string;
  dependencies?: string[]; // Hard dependencies (must be present)
  optionalDependencies?: string[]; // Soft dependencies (optional)
  provides?: string[]; // Capability tokens this plugin provides
  consumes?: string[]; // Capability tokens this plugin needs
  priority?: number; // Registration order (lower = first)
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
import type { MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

async register(ctx: IPluginContext) {
  // Register a service
  ctx.services.register<MyService>('my-service', new MyService());

  // Register with options
  ctx.services.register<MyService>('my-service', new MyService(), {
    override: true,   // Replace existing registration
    multi: true,      // Allow multiple providers
    lazy: true,       // Instantiate on first get
  });

  // Register a factory (lazy instantiation)
  ctx.services.registerFactory('my-service', () => new MyService());
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
async register(ctx: IPluginContext) {
  // Add middleware with default priority
  ctx.middleware.add(async (ctx, next) => {
    console.log('Before request');
    await next();
    console.log('After request');
  });

  // Add middleware with specific priority
  ctx.middleware.add(
    async (ctx, next) => {
      // Middleware logic
      await next();
    },
    { priority: 15 } // Runs at priority 15
  );
}
```

### Middleware Priorities

The default middleware priority order:

| Priority | Middleware                     | Description                       |
| -------- | ------------------------------ | --------------------------------- |
| 10       | `cacheApiMiddleware`           | Cache API middleware (Cloudflare) |
| 15       | `cacheMiddleware`              | Response caching                  |
| 20       | `metricsMiddleware`            | Metrics collection                |
| 25       | `authMiddleware`               | Authentication                    |
| 30       | `telemetryMiddleware`          | Telemetry/request tracing         |
| 35       | `validateBody`/`validateQuery` | Request validation                |
| 40       | `multiTenancyMiddleware`       | Multi-tenancy                     |
| 500      | Default middleware             | Application routes                |

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
async register(ctx: IPluginContext) {
  // Register when app starts (before pipeline compilation)
  ctx.lifecycle.onInit(() => {
    // Initialization logic
  });

  // Register when app is ready to accept requests
  ctx.lifecycle.onBootstrap(() => {
    // Bootstrap logic
  });

  // Per-request hooks
  ctx.lifecycle.onRequest((ctx) => {
    // Request started
  });

  ctx.lifecycle.onResponse((ctx) => {
    // Response completed
  });

  // Error handling
  ctx.lifecycle.onError((error, ctx) => {
    // Handle error
  });

  // Shutdown hooks (drain period)
  ctx.lifecycle.onStopping(() => {
    // Start graceful shutdown
  });

  ctx.lifecycle.onShutdown(() => {
    // Final cleanup
  });

  ctx.lifecycle.onClose(() => {
    // Release resources
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
  dependencies: ['runtime', 'logger'], // Will fail if missing
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
  optionalDependencies: ['cache'], // Works without it
  register(ctx) {
    if (ctx.services.has('cache')) {
      // Use cache
    } else {
      // Fallback behavior
    }
  },
};
```

### Consumes (Soft Dependencies)

The `consumes` field indicates capabilities your plugin needs but won't fail if missing:

```typescript
const MyPlugin: IPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  consumes: ['metrics'], // Warning if missing, but doesn't fail
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

Plugins can be replaced by custom implementations:

```typescript
// Register a custom logger
app.register(CustomLoggerPlugin(), { override: true });
```

## Runtime Independence

Plugins should be runtime-independent whenever possible:

```typescript
async register(ctx: IPluginContext) {
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
if (ctx.services.has('cache')) {
  const cache = ctx.services.get<ICacheService>('cache');
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

describe('MyPlugin', () => {
  it('registers services correctly', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });
    app.register(MyPlugin());

    expect(app.services.has('my-service')).toBe(true);
  });

  it('adds middleware to the pipeline', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });
    app.register(MyPlugin());

    const response = await inject(app, {
      method: 'GET',
      url: '/test',
    });

    // Assert middleware behavior
  });
});
```

## Next Steps

- [Programmatic API](./programmatic-api.md) - Complete API reference
- [Custom Plugin Development](./custom-plugins.md) - Build your own plugins
- [Plugin Catalog](./plugins.md) - Explore built-in plugins
