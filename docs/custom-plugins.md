# Custom Plugin Development

This guide shows you how to build custom plugins for the Setu-TS framework.

## Creating Your First Plugin

### Step 1: Define the Plugin

```typescript
// my-plugin.ts
import { IPlugin, IPluginContext } from '@setu-ts/common';

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
    dependencies: ['runtime'], // Requires RuntimePlugin
    provides: ['my-service'],
    async register(ctx: IPluginContext) {
      // Register a service
      ctx.services.register('my-service', {
        greet: (name: string) => `${config.greeting}, ${name}!`,
      });

      // Add middleware
      ctx.middleware.add(async (ctx, next) => {
        ctx.state['my-plugin'] = { enabled: config.enabled };
        await next();
      });

      // Register a route
      ctx.router.get('/greet/:name', async (ctx) => {
        const service = ctx.services.get<{ greet: (name: string) => string }>('my-service');
        return ctx.json({ message: service.greet(ctx.params.name) });
      });
    },
  };
}
```

### Step 2: Use the Plugin

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MyPlugin } from './my-plugin';

const app = createApplication();

await app.register(RuntimePlugin);
await app.register(MyPlugin({ greeting: 'Bonjour' }));

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
    optionalDependencies: ['logger'],
    provides: ['cache'],
    async register(ctx) {
      const cache = createCache(config);

      ctx.services.register('cache', cache);

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

// Register a factory (lazy)
ctx.services.registerFactory('my-service', () => new MyService());

// Register with options
ctx.services.register('my-service', new MyService(), {
  override: true, // Replace existing
  multi: true, // Allow multiple providers
  lazy: true, // Instantiate on first get
});
```

### Middleware

```typescript
const myMiddleware: MiddlewareFunction = async (ctx, next) => {
  const start = ctx.startTime;
  await next();
  const duration = ctx.startTime - start;
  ctx.logger?.info('Request completed', { duration });
});

// Add to pipeline
ctx.middleware.add(myMiddleware);

// Add with priority
ctx.middleware.add(myMiddleware, { priority: 25 });

// Add to specific routes
// Route-specific middleware is not supported in Setu-TS; use a middleware that checks ctx.request.path instead.
```

### Routes

```typescript
// GET route
ctx.router.get('/path', handler);

// POST route
ctx.router.post('/path', handler);

// PUT, PATCH, DELETE, HEAD, OPTIONS
ctx.router.put('/path', handler);
ctx.router.patch('/path', handler);
ctx.router.delete('/path', handler);
ctx.router.head('/path', handler);
ctx.router.options('/path', handler);

// All methods
ctx.router.all('/path', handler);

// Route group
ctx.router.group('/api', (group) => {
  group.get('/users', getUsers);
  group.post('/users', createUser);
});
```

### Health Checks

```typescript
ctx.health.register('my-check', async () => {
  const healthy = await checkHealth();
  return {
    status: healthy ? 'healthy' : 'unhealthy',
    detail: { timestamp: Date.now() },
  };
});
```

### Metrics

```typescript
// Counter
const requests = ctx.metrics.registerCounter('my_requests_total', {
  description: 'Total requests',
  labels: ['method', 'path'],
});

ctx.middleware.add(async (ctx, next) => {
  await next();
  requests.inc({ labels: { method: ctx.request.method, path: ctx.request.path } });
});

// Gauge
const activeConnections = ctx.metrics.registerGauge('active_connections', {
  description: 'Active connections',
});

// Histogram
const duration = ctx.metrics.registerHistogram('request_duration', {
  description: 'Request duration in seconds',
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
  console.log('Stopping - no new requests');
});

ctx.lifecycle.onShutdown(() => {
  console.log('Shutdown - draining requests');
});

ctx.lifecycle.onClose(() => {
  console.log('Close - releasing resources');
});
```

### CLI Commands

```typescript
ctx.cli.register({
  name: 'my-command',
  aliases: ['mc'],
  description: 'My custom command',
  options: {
    verbose: { type: 'boolean', description: 'Enable verbose output' },
  },
  async handler(args) {
    if (args.verbose) {
      console.log('Verbose mode enabled');
    }
    console.log('Command executed');
  },
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

// Modify the document
ctx.openapi.addDocumentModifier((doc) => {
  doc.info = {
    title: 'My API',
    version: '1.0.0',
  };
  return doc;
});
```

## Environment Declaration

```typescript
ctx.environment.validate({
  PORT: {
    type: 'number',
    default: 3000,
    min: 1,
    max: 65535,
  },
  NODE_ENV: {
    type: 'string',
    enum: ['development', 'production', 'test'],
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
const config = ctx.config.get('my-plugin', {
  greeting: 'Hello',
  enabled: true,
});

// Validate configuration
ctx.config.validate('my-plugin', {
  greeting: { type: 'string', default: 'Hello' },
  enabled: { type: 'boolean', default: true },
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
const now = ctx.runtime.now();           // Wall clock (ms since epoch)
const hrtime = ctx.runtime.hrtime();     // Monotonic (ms since arbitrary origin)

// Timers
const timeoutId = ctx.runtime.setTimeout(() => {}, 1000);
ctx.runtime.clearTimeout(timeoutId);

// File system (may be undefined on Workers)
if (ctx.runtime.fs) {
  const content = await ctx.runtime.fs.readFile('file.txt');
}

// SubtleCrypto (may be undefined)
if (ctx.runtime.subtle) {
  const key = await ctx.runtime.subtle.importKey(...);
}
```

## Dependencies

### Hard Dependencies

```typescript
export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: ['runtime', 'logger'], // Will fail if missing
    async register(ctx) {
      // ctx.logger is guaranteed to be available
      ctx.logger.info('Plugin registered');
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
    optionalDependencies: ['cache'], // Works without it
    async register(ctx) {
      if (ctx.services.has('cache')) {
        const cache = ctx.services.get('cache');
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
    consumes: ['metrics'], // Warning if missing, doesn't fail
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
import { MyPlugin } from '../my-plugin';

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
import { MyPlugin } from '../my-plugin';

describe('MyPlugin integration', () => {
  it('handles GET /greet/:name', async () => {
    const app = createTestApp();
    await app.register(RuntimePlugin);
    await app.register(MyPlugin({ greeting: 'Hello' }));

    const response = await inject(app, {
      method: 'GET',
      path: '/greet/World',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
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
import { MyPlugin } from '@acme/my-plugin';

await app.register(MyPlugin({ option: 'value' }));
```

## Options

| Option | Type   | Default   | Description |
| ------ | ------ | --------- | ----------- |
| option | string | 'default' | Description |

```
## Next Steps

- [Plugin Architecture](./plugin-architecture.md) - Deep dive into the plugin system
- [Examples](./examples.md) - See real-world applications
```
