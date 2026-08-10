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

**Options:** Plugins can be passed inline at creation time (equivalent to calling `register()`
immediately after):

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});
```

Or registered individually:

```typescript
const app = createApplication();
app.register(RuntimePlugin());
```

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
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
app.router.get('/users', async (ctx) => {
  const usersRepo = ctx.services
    .get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository('users');
  const users = await usersRepo.findAll();
  return ctx.response.json(users);
});
```

#### `router.post(path, handler)`, `router.put(path, handler)`, `router.patch(path, handler)`, `router.delete(path, handler)`

Register route handlers for other HTTP methods.

```typescript
const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
const usersRepo = db.getRepository<{ id: string; name: string }>('users');
app.router.post('/users', async (ctx) => {
  const user = await usersRepo.create({ name: 'alice' });
  return ctx.response.json(user);
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
import { createApplication } from '@setu-ts/kernel';
import { inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication({ plugins: [RuntimePlugin()] });
app.router.get('/health', (ctx) => ctx.response.json({ status: 'up' }));
await app.start();

const response = await inject(app, {
  method: 'GET',
  url: '/health',
});
if (response.statusCode !== 200 || response.json<{ status: string }>().status !== 'up') {
  throw new Error('health injection failed');
}
await app.stop();
```

## Router

### Route Handler Context

Route handlers receive a context object with the following properties:

```typescript
// The actual IRequestContext interface (from @setu-ts/common) — see the real
// declaration in packages/common/src/http.ts for the authoritative contract.
// Key members:
//   request: IRequest           (see IRequest below)
//   response: IResponse         (fluent terminal methods, no ResponseOptions bag)
//   services: IServiceRegistry  (typed capability resolution)
//   params: Readonly<Record<string, string>>
//   state: Map<string, unknown>
//   signal: AbortSignal         (aborts when the client disconnects)
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

### Response Methods (fluent API)

`IResponse` methods return `HandlerResult` (terminal) or `IResponse` (fluent). There is no separate
`ResponseOptions` bag — each method carries its own parameters:

```typescript
// Fluent setters (chainable)
ctx.response.status(200);
ctx.response.header('X-Custom', 'value');

// Terminal methods (return HandlerResult)
ctx.response.json({ key: 'value' });
ctx.response.text('Hello');
ctx.response.redirect('/other', 302);
ctx.response.stream(readableStream);

// Read the final snapshot after the handler completes
const snapshot = ctx.response.snapshot();
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
const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
```

### `has(token)`

Check if a service is registered.

```typescript
if (ctx.services.has(CAPABILITIES.CACHE)) {
  const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
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

Shutdown lifecycle hooks. The kernel owns the guard, drain, and socket close. The actual shutdown
order is: **stopping hooks while requests are still accepted → refuse new requests → drain in-flight
requests → close the server socket → shutdown hooks → close hooks**. A rejecting stopping hook is
reported only after the remaining shutdown phases finish.

```typescript
ctx.lifecycle.onStopping(() => {
  // Tell an external load balancer or service registry to stop sending traffic.
});

ctx.lifecycle.onShutdown(() => {
  // Flush buffers and close resources after the kernel drains and closes the socket.
});

ctx.lifecycle.onClose(() => {
  // Release resources
});
```

## Request/Response

### IRequest (exact contract from `@setu-ts/common`)

Transcribed exactly from the `IRequest` interface in `@setu-ts/common`; mutable middleware-owned
fields deliberately remain mutable.

```typescript
interface IRequest {
  readonly method: HttpMethod; // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  readonly url: string;
  readonly path: string;
  readonly headers: Headers;
  readonly ip?: string;
  user?: IPrincipal; // populated by auth middleware
  tenant?: ITenant; // populated by multi-tenancy middleware
  signal?: AbortSignal; // fires on client disconnect

  // Body readers (consume the body exactly once)
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}
```

**Note:** `IRequest` has no `query` field (query parsing happens in the router), no `body` field
(body is read through the dedicated methods above), and no `bodyUsed` property.

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
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
ctx.health.register('database', async () => {
  return { status: 'up', data: { timestamp: runtime.now() } };
});
```

## Metrics

### Obtaining the Metrics Service

Resolve `IMetricsService` through the capability token:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ICounter, IMetricsService } from '@setu-ts/common';

const metrics = ctx.services.get<IMetricsService>(CAPABILITIES.METRICS);
```

### Creating a Custom Counter

Use `counter()` to get or create an `ICounter`, then call `inc()` with labels:

```typescript
const counter = metrics.counter('my_requests_total', {
  help: 'Total requests handled by my service',
  labels: ['method', 'path'],
});

// Increment the counter explicitly in your middleware or handler
counter.inc(1, { method: 'GET', path: '/users' });
```

**Note:** A custom contributed counter is NOT automatically observed by any built-in HTTP collector.
The built-in HTTP collectors track their own metrics (`http_requests_total`,
`http_request_duration_seconds`, etc.). To record a custom counter you must call `inc()` (or
`observe()`) explicitly.

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
  platform(): RuntimePlatform;
  version(): string;
  hostname(): string;
  uuid(): string;
  randomBytes(length: number): Uint8Array;
  readonly subtle: SubtleCrypto;
  now(): number;
  hrtime(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  exit(code?: number): never;
  readonly fs?: IFileSystem;
  readonly workers?: IWorkerHost;
  readonly dns?: IDnsResolver;
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
import { createApplication } from '@setu-ts/kernel';
import { inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication({ plugins: [RuntimePlugin()] });
app.router.post('/test', async (ctx) => {
  return ctx.response.status(201).json(await ctx.request.json<{ foo: string }>());
});
await app.start();

const response = await inject(app, {
  method: 'POST',
  url: '/test',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ foo: 'bar' }),
});
if (response.statusCode !== 201 || response.json<{ foo: string }>().foo !== 'bar') {
  throw new Error('request injection failed');
}
await app.stop();
```

### `createMockPlugin(options?)`

Create a mock plugin.

```typescript
import { createMockPlugin } from '@setu-ts/testing';

const mockPlugin = createMockPlugin({
  name: 'my-service',
  service: mockMyService,
});
```

## Streaming

### Streaming Responses

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    runtime.setTimeout(resolve, ms);
  });

app.router.get('/stream', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new TextEncoder().encode(`Line ${i}\n`));
        await delay(100);
      }
      controller.close();
    },
  });

  return ctx.response.stream(stream);
});
```

### Client Disconnect Handling

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    runtime.setTimeout(resolve, ms);
  });

app.router.get('/long-running', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!ctx.signal.aborted) {
          controller.enqueue(new TextEncoder().encode('data\n'));
          await delay(1000);
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
