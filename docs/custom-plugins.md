# Custom Plugin Development

This guide shows you how to build custom plugins for the Setu-TS framework.

## Creating Your First Plugin

### Step 1: Define the Plugin

```typescript
// my-plugin.ts
import type { IPlugin, IPluginContext } from '@setu-ts/common';

export interface MyPluginOptions {
  greeting?: string;
  enabled?: boolean;
}

export function MyPlugin(options: MyPluginOptions = {}): IPlugin {
  const config = {
    greeting: options.greeting ?? 'Hello',
    enabled: options.enabled ?? true,
  };

  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: [CAPABILITIES.RUNTIME], // Requires RuntimePlugin
    provides: ['my-service'],
    async register(ctx: IPluginContext) {
      // Register a service
      ctx.services.register('my-service', {
        greet: (name: string) => `${config.greeting}, ${name}!`,
      });

      // Add middleware
      ctx.middleware.add(async (ctx, next) => {
        ctx.state.set('my-plugin', { enabled: config.enabled });
        await next();
      });

      // Register a route
      ctx.router.get('/greet/:name', async (ctx) => {
        const service = ctx.services.get<{ greet: (name: string) => string }>('my-service');
        return ctx.response.json({ message: service.greet(ctx.params.name) });
      });
    },
  };
}
```

### Step 2: Use the Plugin

```typescript
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

function MyPlugin(options: { greeting?: string }): IPlugin {
  const greeting = options.greeting ?? 'Hello';
  return {
    name: 'my-plugin',
    version: '1.0.0',
    async register(ctx: IPluginContext) {
      ctx.services.register('my-service', { greet: (name: string) => `${greeting}, ${name}!` });
    },
  };
}

const app = createApplication();

app.register(RuntimePlugin());
app.register(MyPlugin({ greeting: 'Bonjour' }));

await app.start({ port: 3000 });
```

## Plugin Structure

### Plugin Factory Pattern

Creating plugins via factory functions allows configuration and encapsulation:

```typescript
export function CachePlugin(options: CachePluginOptions): IPlugin {
  const config = { ...defaultConfig, ...options };

  return {
    name: 'cache',
    version: '1.0.0',
    optionalDependencies: [CAPABILITIES.LOGGER],
    provides: [CAPABILITIES.CACHE],
    async register(ctx) {
      const cache = createCache(config);

      ctx.services.register(CAPABILITIES.CACHE, cache);

      ctx.lifecycle.onClose(() => {
        cache.close();
      });
    },
  };
}
```

### Service Registration

```typescript
// Register a singleton
ctx.services.register('my-service', new MyService());

// Register a factory (lazy instantiation)
ctx.services.registerFactory('my-service', () => new MyService());

// Register with options
ctx.services.register('my-service', new MyService(), {
  override: true, // Replace existing
  multi: true, // Allow multiple providers
});
```

### Middleware

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';

const myMiddleware: MiddlewareFunction = async (ctx, next) => {
  // Use the runtime's monotonic clock for durations, not host performance.now().
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const start = runtime.hrtime();
  await next();
  const duration = runtime.hrtime() - start;
  // Use wall-clock time from runtime for timestamps, not host Date.now().
  console.log('Request completed', { duration, timestamp: runtime.now() });
};

// Add to pipeline
ctx.middleware.add(myMiddleware);

// Add with priority
ctx.middleware.add(myMiddleware, { priority: 25 });

// Add to specific routes
// Route-specific middleware is not supported in Setu-TS; use a middleware that checks ctx.request.path instead.
```

### Routes

```typescript
import type { RouteHandler } from '@setu-ts/common';

// GET route
const getHandler: RouteHandler = async (ctx) => ctx.response.json({ ok: true });
ctx.router.get('/path', getHandler);

// POST route
ctx.router.post('/path', getHandler);

// PUT, PATCH, DELETE, HEAD, OPTIONS
ctx.router.put('/path', getHandler);
ctx.router.patch('/path', getHandler);
ctx.router.delete('/path', getHandler);
ctx.router.head('/path', getHandler);
ctx.router.options('/path', getHandler);

// Route group
ctx.router.group('/api', (group) => {
  group.get('/users', getHandler);
  group.post('/users', getHandler);
});
```

### Health Checks

```typescript
ctx.health.register('my-check', async () => {
  return {
    status: 'up',
    data: { timestamp: ctx.runtime.now() },
  };
});
```

### Metrics

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ICounter, IGauge, IHistogram, IMetricsService } from '@setu-ts/common';

// Resolve IMetricsService through the capability token
const metrics = ctx.services.get<IMetricsService>(CAPABILITIES.METRICS);

// Create a custom counter (counter() returns ICounter, not void)
const requestCounter: ICounter = metrics.counter('my_requests_total', {
  help: 'Total requests handled by my plugin',
  labels: ['method', 'path'],
});

// Explicitly increment the counter — a custom counter is NOT automatically
// observed by built-in HTTP collection. You must call inc() yourself.
ctx.middleware.add(async (ctx, next) => {
  await next();
  requestCounter.inc(1, {
    method: ctx.request.method,
    path: ctx.request.path,
  });
});

// Gauge for tracking current connections
const activeConnections: IGauge = metrics.gauge('active_connections', {
  help: 'Current active connections',
});

// Histogram for request durations
const requestDuration: IHistogram = metrics.histogram('request_duration_seconds', {
  help: 'Request duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5],
});
```

### Lifecycle Hooks

```typescript
// Initialization (before pipeline compilation)
ctx.lifecycle.onInit(() => {
  console.log('Initializing plugin...');
});

// Bootstrap (after pipeline compilation, before accepting requests)
ctx.lifecycle.onBootstrap(() => {
  console.log('Plugin ready!');
});

// Per-request hooks
ctx.lifecycle.onRequest((ctx) => {
  console.log('Request started:', ctx.request.url);
});

ctx.lifecycle.onResponse((ctx) => {
  console.log('Response sent:', ctx.response.snapshot().status);
});

ctx.lifecycle.onError((error, ctx) => {
  console.error('Request error:', error);
});

// Shutdown hooks
ctx.lifecycle.onStopping(() => {
  console.log('Stopping - deregister from external traffic sources');
});

ctx.lifecycle.onShutdown(() => {
  console.log('Shutdown - kernel has drained requests and closed the socket');
});

ctx.lifecycle.onClose(() => {
  console.log('Close - releasing resources');
});
```

### CLI Commands

```typescript
ctx.cli.register('my-command', async (args) => {
  console.log('Command executed with args:', args);
});
```

### OpenAPI Contributions

```typescript
// Add a schema
ctx.openapi.addSchema('User', {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name', 'email'],
});
```

## Environment Declaration

```typescript
ctx.environment.validate({
  PORT: {
    type: 'number',
    default: 3000,
  },
  NODE_ENV: {
    type: 'string',
    default: 'development',
  },
  API_KEY: {
    type: 'string',
    required: true,
  },
});
```

## Configuration

```typescript
// Read configuration
const config = ctx.config?.get('my-plugin', {
  default: {
    greeting: 'Hello',
    enabled: true,
  },
});
```

## Using Runtime Services

```typescript
// Platform detection
const platform = ctx.runtime.platform();
if (platform === 'cloudflare-workers') {
  // Workers-specific logic
}

// Environment variables
const env = ctx.runtime.env;
const apiKey = env.API_KEY;

// UUID generation
const id = ctx.runtime.uuid();

// Random bytes
const bytes = ctx.runtime.randomBytes(32);

// Time
const now = ctx.runtime.now(); // Wall clock (ms since epoch)
const hrtime = ctx.runtime.hrtime(); // Monotonic (ms since arbitrary origin)

// Timers
const timeoutId = ctx.runtime.setTimeout(() => {}, 1000);
ctx.runtime.clearTimeout(timeoutId);

// File system (may be undefined on Workers)
if (ctx.runtime.fs) {
  const fileContent = await ctx.runtime.fs.readFile('file.txt');
}

// SubtleCrypto (may be undefined)
if (ctx.runtime.subtle) {
  const importedKey = await ctx.runtime.subtle.importKey(
    'raw',
    new Uint8Array(32),
    'HMAC',
    false,
    ['sign'],
  );
}
```

## Dependencies

### Hard Dependencies

```typescript
export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.LOGGER], // Will fail if missing
    async register(ctx) {
      // ctx.logger is guaranteed when CAPABILITIES.LOGGER is in dependencies.
      ctx.logger?.info('Plugin registered');
    },
  };
}
```

### Optional Dependencies

```typescript
export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    optionalDependencies: [CAPABILITIES.CACHE], // Works without it
    async register(ctx) {
      if (ctx.services.has(CAPABILITIES.CACHE)) {
        const cache = ctx.services.get(CAPABILITIES.CACHE);
        // Use cache
      } else {
        // Fallback behavior
      }
    },
  };
}
```

### Soft Dependencies (Consumes)

```typescript
export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    consumes: [CAPABILITIES.METRICS], // Warning if missing, doesn't fail
    async register(ctx) {
      // Plugin works but logs warning if metrics not available
    },
  };
}
```

## Testing Custom Plugins

### Unit Tests

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// Self-contained plugin for testing (no relative import)
function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    async register(ctx) {
      // Plugin registration logic
    },
  };
}

describe('MyPlugin', () => {
  it('has correct name and version', () => {
    const plugin = MyPlugin();
    expect(plugin.name).toBe('my-plugin');
    expect(plugin.version).toBe('1.0.0');
  });

  it('registers the service', async () => {
    const plugin = MyPlugin();
    const mockServices = {
      registered: new Map<string, unknown>(),
      register: (token: string, service: unknown) => {
        mockServices.registered.set(token, service);
      },
      get: (token: string) => mockServices.registered.get(token),
      has: (token: string) => mockServices.registered.has(token),
    };

    await plugin.register({
      services: mockServices as never,
      runtime: {} as never,
      // ... other context properties
    } as never);

    expect(mockServices.has('my-service')).toBe(true);
  });
});
```

### Integration Tests

```typescript
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

// Self-contained plugin for testing (no relative import)
function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    async register(ctx) {
      ctx.router.get('/greet/:name', (ctx) => {
        return ctx.response.json({ message: `Hello, ${ctx.params.name}!` });
      });
    },
  };
}

describe('MyPlugin integration', () => {
  it('handles GET /greet/:name', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });
    app.register(MyPlugin());

    const response = await inject(app, {
      method: 'GET',
      url: '/greet/World',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ message: 'Hello, World!' });
  });
});
```

## Best Practices

### 1. Keep Plugins Focused

Each plugin should do one thing well. Split large plugins into smaller, composable units.

### 2. Use Capability Tokens

Always use capability tokens from `@setu-ts/common` or create your own with
`createCapabilityToken()`.

### 3. Handle Missing Dependencies Gracefully

Check for optional dependencies before using them.

### 4. Clean Up Resources

Always register cleanup hooks for resources you allocate.

### 5. Document Your Plugin

Provide clear documentation including:

- What the plugin does
- Required and optional dependencies
- Configuration options
- Usage examples

### 6. Test Thoroughly

Test your plugin:

- In isolation (unit tests)
- In integration (with other plugins)
- With various configurations

### 7. Version Your Plugins

Follow semantic versioning and update the version field when making changes.

### 8. Error Handling

Provide clear, actionable error messages when something goes wrong.

## Publishing Your Plugin

### Package Structure

```
my-plugin/
├── deno.json
├── README.md
├── src/
│   ├── index.ts
│   └── plugin.ts
└── test/
    └── plugin.test.ts
```

### deno.json

```json
{
  "name": "@acme/my-plugin",
  "version": "1.0.0",
  "exports": "./src/index.ts",
  "imports": {
    "@setu-ts/common": "jsr:@setu-ts/common@^0.1.0-alpha.5"
  }
}
```

### README.md

````markdown
# @acme/my-plugin

A custom plugin for Setu-TS.

## Installation

```bash
deno add jsr:@acme/my-plugin
```
````

## Usage

```typescript
// A published plugin package — import from your own package once published:
//   import { MyPlugin } from '@acme/my-plugin';
//   app.register(MyPlugin({ option: 'value' }));

// For local development, import directly:
//   import { MyPlugin } from './src/my-plugin.ts';
//   app.register(MyPlugin());
```

## Options

| Option | Type   | Default   | Description |
| ------ | ------ | --------- | ----------- |
| option | string | 'default' | Description |

## Next Steps

- [Plugin Architecture](./plugin-architecture.md) - Deep dive into the plugin system
- [Examples](./examples.md) - See real-world applications
