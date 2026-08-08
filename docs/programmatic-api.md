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

await app.register(RuntimePlugin);
await app.register(LoggerPlugin, { level: 'info' });
```

#### `get(path, handler)`

Register a GET route handler.

```typescript
app.get('/users', async (ctx) => {
  const users = await ctx.services.get<IDatabaseService>('database').findAll('users');
  return ctx.json(users);
});
```

#### `post(path, handler)`, `put(path, handler)`, `patch(path, handler)`, `delete(path, handler)`

Register route handlers for other HTTP methods.

```typescript
app.post('/users', async (ctx) => {
  const user = await ctx.services.get<IDatabaseService>('database').create(
    'users',
    ctx.request.body,
  );
  return ctx.json(user, { status: 201 });
});
```

#### `use(middleware)`

Add global middleware to the pipeline.

```typescript
import { metricsMiddleware } from '@setu-ts/metrics-plugin';

app.use(metricsMiddleware);
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
  path: '/health',
});
```

## Router

### Route Handler Context

Route handlers receive a context object with the following properties:

```typescript
interface RouteHandlerContext {
  request: IRequest;
  context: IRequestContext;
  services: ServiceRegistry;
  json<T>(data: T, options?: ResponseOptions): Promise<Response>;
  text(text: string, options?: ResponseOptions): Promise<Response>;
  html(html: string, options?: ResponseOptions): Promise<Response>;
  redirect(url: string, status?: number): Promise<Response>;
  stream(body: ReadableStream<Uint8Array>, options?: ResponseOptions): Promise<Response>;
}
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
});
```

### Middleware Priority

```typescript
ctx.middleware.add(myMiddleware, { priority: 25 });
```

Default priority is 50. Lower numbers run first.

## Lifecycle Hooks

### `onInit(handler)`

Called during application initialization.

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
  readonly url: URL;
  readonly path: string;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly headers: Readonly<Headers>;
  readonly body?: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;

  json<T>(): Promise<T>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  formData(): Promise<FormData>;
}
```

### IRequestContext

```typescript
interface IRequestContext {
  readonly startTime: number;
  readonly signal: AbortSignal;
  readonly params: Readonly<Record<string, string>>;
  readonly state: Record<string, unknown>;
  readonly user?: unknown;
  readonly tenant?: unknown;
}
```

### IResponse

```typescript
interface IResponse {
  json<T>(data: T, options?: ResponseOptions): Promise<Response>;
  text(text: string, options?: ResponseOptions): Promise<Response>;
  html(html: string, options?: ResponseOptions): Promise<Response>;
  redirect(url: string, status?: number): Promise<Response>;
  stream(body: ReadableStream<Uint8Array>, options?: ResponseOptions): Promise<Response>;
  send(body: Uint8Array, options?: ResponseOptions): Promise<Response>;
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

### `registerCounter(name, options?)`

Register a counter metric.

```typescript
const requestCount = ctx.metrics.registerCounter('http_requests_total', {
  description: 'Total HTTP requests',
  labels: ['method', 'path'],
});
```

### `registerGauge(name, options?)`

Register a gauge metric.

```typescript
const activeConnections = ctx.metrics.registerGauge('active_connections', {
  description: 'Number of active connections',
});
```

### `registerHistogram(name, options?)`

Register a histogram metric.

```typescript
const requestDuration = ctx.metrics.registerHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10],
});
```

### `registerSummary(name, options?)`

Register a summary metric.

```typescript
const requestSummary = ctx.metrics.registerSummary('http_request_summary', {
  description: 'HTTP request summary',
  percentiles: [0.5, 0.9, 0.99],
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

### `addDocumentModifier(modifier)`

Contribute an OpenAPI document modifier.

```typescript
ctx.openapi.addDocumentModifier((doc) => {
  doc.info.title = 'My API';
  return doc;
});
```

## CLI Contributions

### `register(command)`

Register a CLI command.

```typescript
ctx.cli.register({
  name: 'my-command',
  aliases: ['mc'],
  description: 'My custom command',
  handler: async (args) => {
    console.log('Command executed with args:', args);
  },
});
```

## Decorator Contributions

### `register(type, handler)`

Register a decorator handler.

```typescript
ctx.decorators.register('MyDecorator', async (metadata, ctx) => {
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
type RuntimePlatform = 'deno' | 'node' | 'bun' | 'cloudflare-workers' | 'unknown';
```

## Testing Utilities

### `createTestApp()`

Create a test application.

```typescript
import { createTestApp } from '@setu-ts/testing';

const app = createTestApp();
await app.register(RuntimePlugin);
```

### `inject(app, request)`

Inject a request.

```typescript
import { inject } from '@setu-ts/testing';

const response = await inject(app, {
  method: 'GET',
  path: '/test',
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
app.get('/stream', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new TextEncoder().encode(`Line ${i}\n`));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      controller.close();
    },
  });

  return ctx.stream(stream);
});
```

### Client Disconnect Handling

```typescript
app.get('/long-running', async (ctx) => {
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

  return ctx.stream(stream);
});
```

## Next Steps

- [Decorators Guide](./decorators.md) - Optional decorator API
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Examples](./examples.md) - Runnable examples
