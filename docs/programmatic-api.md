# Programmatic API Reference

This document provides a comprehensive reference for the Setu-TS programmatic API. For
decorator-based usage, see [Decorators Guide](./decorators.md).

## Application

### `createApplication(options?)`

Creates a new application instance.

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication();
```

**Options:** None currently. The application is configured entirely through plugin registration.

### Application Methods

#### `register(plugin, options?)`

Register a plugin with the application.

```typescript
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';

app.register(RuntimePlugin());
app.register(LoggerPlugin({ level: 'info' }));
```

#### `router.get(path, handler)`

Register a GET route handler through the router.

```typescript
app.router.get('/users', async (ctx) => {
  const users = await ctx.services.get<IDatabaseService>('database').findAll('users');
  return ctx.response.json(users);
});
```

#### `router.post(path, handler)`, `router.put(path, handler)`, `router.patch(path, handler)`, `router.delete(path, handler)`

Register route handlers for other HTTP methods.

```typescript
app.router.post('/users', async (ctx) => {
  const user = await ctx.services.get<IDatabaseService>('database').create(
    'users',
    await ctx.request.json(),
  );
  return ctx.response.json(user, { status: 201 });
});
```

#### `middleware.add(middleware)`

Add global middleware to the pipeline.

```typescript
import { MetricsPlugin } from '@setu-ts/metrics-plugin';

app.register(MetricsPlugin({ endpoint: '/metrics' }));
```

#### `start(options?)`

Start the application and optionally listen on a port.

```typescript
await app.start({ port: 3000, hostname: '0.0.0.0' });
```

**Options:**

- `port?: number` - Port to listen on
- `hostname?: string` - Hostname to bind to (default: '0.0.0.0')

#### `stop()`

Stop the application gracefully.

```typescript
await app.stop();
```

#### `fetch(request)`

Handle a web-standard Request. Used for testing and Workers deployments.

```typescript
const response = await app.fetch(new Request('http://localhost:3000/health'));
```

#### `inject(request)`

Inject a request without a network socket (testing only).

```typescript
import { inject } from '@setu-ts/testing';

const response = await inject(app, {
  method: 'GET',
  url: '/health',
});
```

## Router

### Route Handler Context

Route handlers receive a context object with the following properties:

```typescript
interface RouteHandlerContext {
  request: IRequest;
  response: IResponse;
  services: ServiceRegistry;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  state: Map<string, unknown>;
}
```

### Response Methods

```typescript
// JSON response
ctx.response.json(data);

// Text response
ctx.response.text('Hello');

// Redirect
ctx.response.redirect('/other');

// Streaming response
ctx.response.stream(readableStream);
```

### Response Options

```typescript
interface ResponseOptions {
  status?: number;
  headers?: HeadersInit;
}
```

## Service Registry

### `register<T>(token, service, options?)`

Register a service.

```typescript
ctx.services.register<IMyService>('my-service', new MyService());
```

### `get<T>(token)`

Resolve a service.

```typescript
const db = ctx.services.get<IDatabaseService>('database');
```

### `has(token)`

Check if a service is registered.

```typescript
if (ctx.services.has('cache')) {
  const cache = ctx.services.get<ICacheService>('cache');
}
```

### `getAll<T>(token)`

Get all providers for a multi-provider capability.

```typescript
const validators = ctx.services.getAll<IValidator>('validator');
```

## Middleware

### Creating Middleware

```typescript
const myMiddleware: MiddlewareFunction = async (ctx, next) => {
  console.log('Before');
  await next();
  console.log('After');
};
```

### Middleware Priority

```typescript
app.middleware.add(myMiddleware, { priority: 25 });
```

Default priority is 500. Lower numbers run first.

## Lifecycle Hooks

### `onRegister(handler)`

Called during plugin registration.

```typescript
ctx.lifecycle.onRegister(() => {
  console.log('Registering...');
});
```

### `onInit(handler)`

Called after all plugins have registered.

```typescript
ctx.lifecycle.onInit(() => {
  console.log('Initializing...');
});
```

### `onBootstrap(handler)`

Called when the application is ready to accept requests.

```typescript
ctx.lifecycle.onBootstrap(() => {
  console.log('Ready!');
});
```

### `onRequest(handler)`, `onResponse(handler)`, `onError(handler)`

Per-request lifecycle hooks.

```typescript
ctx.lifecycle.onRequest((ctx) => {
  console.log('Request started:', ctx.request.url);
});

ctx.lifecycle.onResponse((ctx) => {
  console.log('Response sent:', ctx.response.snapshot().status);
});

ctx.lifecycle.onError((error, ctx) => {
  console.error('Error:', error);
});
```

### `onStopping(handler)`, `onShutdown(handler)`, `onClose(handler)`

Shutdown lifecycle hooks.

```typescript
ctx.lifecycle.onStopping(() => {
  // Stop accepting new requests
});

ctx.lifecycle.onShutdown(() => {
  // Drain in-flight requests
});

ctx.lifecycle.onClose(() => {
  // Release resources
});
```

## Request/Response

### IRequest

```typescript
interface IRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Headers;
  readonly body?: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;

  json<T>(): Promise<T>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}
```

### IRequestContext

```typescript
interface IRequestContext {
  readonly id: string;
  readonly request: IRequest;
  readonly response: IResponse;
  readonly services: IServiceRegistry;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly state: Map<string, unknown>;
  readonly startTime: number;
  readonly signal: AbortSignal;
}
```

### IResponse

```typescript
interface IResponse {
  status(code: number): IResponse;
  header(name: string, value: string): IResponse;
  appendHeader(name: string, value: string): IResponse;
  json<T>(body: T): HandlerResult;
  text(body: string): HandlerResult;
  send(body?: Uint8Array): HandlerResult;
  redirect(url: string, status?: number): HandlerResult;
  stream(body: ReadableStream<Uint8Array>): HandlerResult;
  snapshot(): ResponseSnapshot;
}
```

## Health Checks

### `register(name, check)`

Register a health check.

```typescript
ctx.health.register('database', async () => {
  const db = ctx.services.get<IDatabaseService>('database');
  const healthy = await db.isHealthy();
  return { status: healthy ? 'healthy' : 'unhealthy' };
});
```

## Metrics

### `register(name, config)`

Register a metric.

```typescript
const requestCount = ctx.metrics.register('http_requests_total', {
  type: 'counter',
  help: 'Total HTTP requests',
  labels: ['method', 'path'],
});
```

## OpenAPI Contributions

### `addSchema(name, schema)`

Contribute an OpenAPI schema.

```typescript
ctx.openapi.addSchema('User', {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
});
```

## CLI Contributions

### `register(name, handler)`

Register a CLI command.

```typescript
ctx.cli.register('my-command', async (args) => {
  console.log('Command executed with args:', args);
});
```

## Decorator Contributions

### `register(name, handler)`

Register a decorator handler.

```typescript
ctx.decorators.register('MyDecorator', async (metadata, target) => {
  // Handle decorator application
});
```

## Runtime Services

### IRuntimeServices

```typescript
interface IRuntimeServices {
  readonly platform: RuntimePlatform;
  readonly env: Record<string, string | undefined>;
  readonly uuid: () => string;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly hrtime: () => number;
  readonly setTimeout: typeof setTimeout;
  readonly setInterval: typeof setInterval;
  readonly clearTimeout: typeof clearTimeout;
  readonly clearInterval: typeof clearInterval;
  readonly fs?: IFileSystem;
  readonly workers?: IWorkerHost;
  readonly dns?: IDnsResolver;
  readonly subtle?: SubtleCrypto;
}
```

### Runtime Platform

```typescript
type RuntimePlatform = 'deno' | 'node' | 'bun' | 'cloudflare-workers';
```

Every value has a runtime implementation — there is no `'unknown'` arm. Use
[`detectRuntime()`](../packages/runtime/src/detector/runtime-detector.ts) to resolve the current
platform, or pass `RuntimePlugin({ platform })` to force one.

## Testing Utilities

### `createTestApp(options?)`

Create a test application.

```typescript
import { createTestApp } from '@setu-ts/testing';

const app = await createTestApp({
  plugins: [RuntimePlugin()],
});
```

### `inject(app, request)`

Inject a request.

```typescript
import { inject } from '@setu-ts/testing';

const response = await inject(app, {
  method: 'GET',
  url: '/test',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ foo: 'bar' }),
});
```

### `createMockPlugin(options?)`

Create a mock plugin.

```typescript
import { createMockPlugin } from '@setu-ts/testing';

const mockPlugin = createMockPlugin({
  provides: ['my-service'],
  services: {
    'my-service': mockMyService,
  },
});
```

## Streaming

### Streaming Responses

```typescript
app.router.get('/stream', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new TextEncoder().encode(`Line ${i}\n`));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      controller.close();
    },
  });

  return ctx.response.stream(stream);
});
```

### Client Disconnect Handling

```typescript
app.router.get('/long-running', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!ctx.signal.aborted) {
          controller.enqueue(new TextEncoder().encode('data\n'));
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch {
        // Client disconnected
      } finally {
        controller.close();
      }
    },
  });

  return ctx.response.stream(stream);
});
```

## Next Steps

- [Decorators Guide](./decorators.md) - Optional decorator API
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Examples](./examples.md) - Runnable examples
