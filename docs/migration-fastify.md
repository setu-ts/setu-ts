# Migrating from Fastify

This guide helps you migrate from Fastify to Setu-TS. Setu-TS shares Fastify's philosophy of plugin
encapsulation and hooks, while adding dependency injection, TypeScript-first design, and runtime
independence.

## Key Differences

| Concept              | Fastify                     | Setu-TS                                |
| -------------------- | --------------------------- | -------------------------------------- |
| **Runtime**          | Node.js only                | Deno, Node.js, Bun, Cloudflare Workers |
| **Request/Response** | FastifyRequest/FastifyReply | Web-standard Request/Response          |
| **Plugin System**    | `fastify.register()`        | `app.register(plugin)`                 |
| **Encapsulation**    | Per-instance decoration     | Capability tokens, service registry    |
| **Decorators**       | `fastify.decorate()`        | Service registry                       |
| **Schema**           | JSON Schema (ajv)           | Zod (or custom validators)             |

## Basic Application

### Fastify

```typescript
import fastify from 'fastify';

const app = fastify({ logger: true });

app.get('/', async (request, reply) => {
  return { message: 'Hello' };
});

app.listen({ port: 3000 }, (err) => {
  if (err) throw err;
  console.log('Server listening on port 3000');
});
```

### Setu-TS

```typescript
import type { MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';

const app = createApplication();

await app.register(RuntimePlugin);
await app.register(LoggerPlugin);

app.get('/', async (ctx) => {
  return ctx.json({ message: 'Hello' });
});

await app.start({ port: 3000 });
console.log('Server listening on port 3000');
```

## Routes

### Fastify

```typescript
interface Params {
  id: string;
}

interface Querystring {
  search?: string;
}

interface Body {
  name: string;
  email: string;
}

app.get<{ Params; Querystring }>('/:id', async (request, reply) => {
  const { id } = request.params;
  const { search } = request.query;
  return { id, search };
});

app.post<{ Body }>('/users', async (request, reply) => {
  const body = request.body;
  return { created: body.name };
});
```

### Setu-TS

```typescript
app.get('/users/:id', async (ctx) => {
  const id = ctx.params.id;
  const search = ctx.request.url.searchParams.get('search');
  return ctx.json({ id, search });
});

app.post('/users', async (ctx) => {
  const body = await ctx.request.json();
  return ctx.json({ created: body.name }, { status: 201 });
});
```

## Route Groups

### Fastify

```typescript
app.register(async (fastify) => {
  fastify.get('/users', () => []);
  fastify.post('/users', () => ({}));
}, { prefix: '/api' });
```

### Setu-TS

```typescript
app.get('/api/users', async (ctx) => []);
app.post('/api/users', async (ctx) => ({}));

// Or use a route group
ctx.router.group('/api', (group) => {
  group.get('/users', async () => []);
  group.post('/users', async () => ({}));
});
```

## Hooks

### Fastify

```typescript
// onRequest
app.addHook('onRequest', (request, reply, done) => {
  console.log('onRequest');
  done();
});

// preHandler
app.addHook('preHandler', (request, reply, done) => {
  console.log('preHandler');
  done();
});

// preSerialization
app.addHook('preSerialization', (request, reply, payload, done) => {
  console.log('preSerialization');
  done();
});

// onResponse
app.addHook('onResponse', (request, reply, done) => {
  console.log('onResponse');
  done();
});

// onSend
app.addHook('onSend', (request, reply, payload, done) => {
  console.log('onSend');
  done();
});

// onError
app.addHook('onError', (request, reply, error, done) => {
  console.log('onError');
  done();
});
```

### Setu-TS

```typescript
// Using lifecycle hooks
ctx.lifecycle.onRequest((ctx) => {
  console.log('Request started:', ctx.request.url);
});

ctx.lifecycle.onResponse((ctx) => {
  console.log('Response sent:', ctx.response.snapshot().status);
});

ctx.lifecycle.onError((error, ctx) => {
  console.error('Request error:', error);
});

// Using middleware for transformation


const preSerializationMiddleware: MiddlewareFunction = async (ctx, next) => {
  await next();
  // Post-processing after response is generated
});

app.use(preSerializationMiddleware);
```

## Middleware

### Fastify

```typescript
app.use((req, res, next) => {
  console.log('Middleware');
  next();
});

// Route-specific
app.use('/api/*', apiMiddleware);
```

### Setu-TS

```typescript
const myMiddleware: MiddlewareFunction = async (ctx, next) => {
  console.log('Middleware');
  await next();
});

app.use(myMiddleware);

// Route-specific middleware
// Route-specific middleware is not supported in Setu-TS; use a middleware that checks ctx.request.path instead.
```

## Decorators

### Fastify

```typescript
// Register decorator
app.decorate('myUtil', {
  formatDate: (date: Date) => date.toISOString(),
});

// Use decorator
app.get('/', async (request, reply) => {
  return { date: app.myUtil.formatDate(new Date()) };
});
```

### Setu-TS

```typescript
// Register as a service
ctx.services.register('myUtil', {
  formatDate: (date: Date) => date.toISOString(),
});

// Use service
app.get('/', async (ctx) => {
  const myUtil = ctx.services.get('myUtil');
  return ctx.json({ date: myUtil.formatDate(new Date()) });
});
```

## Validation

### Fastify

```typescript
app.addSchema({
  $id: 'userSchema',
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name', 'email'],
});

app.post('/users', {
  schema: {
    body: 'userSchema',
  },
}, async (request, reply) => {
  return { created: true };
});
```

### Setu-TS

```typescript
import { z } from '@std/zod';

const userSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});

// Using validation plugin
app.post('/users', async (ctx) => {
  const result = userSchema.safeParse(await ctx.request.json());
  if (!result.success) {
    return ctx.json({ errors: result.error.errors }, { status: 400 });
  }
  const body = result.data;
  return ctx.json({ created: true }, { status: 201 });
});
```

## Error Handling

### Fastify

```typescript
app.setErrorHandler((error, request, reply) => {
  reply.status(error.statusCode || 500).send({
    error: error.message,
  });
});
```

### Setu-TS

```typescript
const errorMiddleware: MiddlewareFunction = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof HttpException) {
      return ctx.json(
        { error: error.message },
        { status: error.status },
      );
    }

    ctx.logger?.error('Unhandled error', { error });
    return ctx.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
});

app.use(errorMiddleware);
```

## Type Providers

### Fastify

```typescript
interface FastifySchema {
  body: { name: string; email: string };
}

app.post<FastifySchema>('/users', async (request, reply) => {
  const body = request.body; // Typed
  return { created: true };
});
```

### Setu-TS

```typescript
interface CreateUserData {
  name: string;
  email: string;
}

app.post('/users', async (ctx) => {
  const body = await ctx.request.json<CreateUserData>();
  return ctx.json({ created: true }, { status: 201 });
});
```

## Lifecycle Hooks

### Fastify

```typescript
// onReady
app.addHook('onReady', async () => {
  console.log('Ready!');
});

// onClose
app.addHook('onClose', async () => {
  console.log('Closing');
});
```

### Setu-TS

```typescript
ctx.lifecycle.onBootstrap(() => {
  console.log('Ready!');
});

ctx.lifecycle.onClose(() => {
  console.log('Closing');
});

// More detailed shutdown lifecycle
ctx.lifecycle.onStopping(() => {
  console.log('Stopping - no new requests');
});

ctx.lifecycle.onShutdown(() => {
  console.log('Shutdown - draining requests');
});
```

## Plugins

### Fastify

```typescript
async function authPlugin(fastify, options) {
  fastify.decorate('authenticate', async (request) => {
    if (!request.headers.authorization) {
      throw new Error('Missing authorization header');
    }
  });
}

app.register(authPlugin, {/* options */});
```

### Setu-TS

```typescript
export function AuthPlugin(options: AuthOptions): IPlugin {
  return {
    name: 'auth',
    version: '1.0.0',
    async register(ctx) {
      ctx.services.register('authenticate', async (request) => {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) {
          throw new Error('Missing authorization header');
        }
      });
    },
  };
}

await app.register(AuthPlugin(options));
```

## Server Decoration

### Fastify

```typescript
app.decorateRequest('user', null);

app.addHook('onRequest', async (request, reply) => {
  request.user = { id: 1, name: 'John' };
});
```

### Setu-TS

```typescript
const authMiddleware: MiddlewareFunction = async (ctx, next) => {
  // Set user on context
  ctx.user = { id: 1, name: 'John' };
  await next();
});

app.use(authMiddleware);
```

## Async Initialization

### Fastify

```typescript
const app = fastify();

await app.ready();
// App is ready but not listening
```

### Setu-TS

```typescript
const app = createApplication();

await app.register(RuntimePlugin);
await app.start();
// App is ready and listening (if port specified)
// Or ready for fetch (if no port)
```

## Testing

### Fastify

```typescript
import Fastify from 'fastify';

const app = Fastify();
app.get('/', async () => ({ hello: 'world' }));

const response = await app.inject({
  method: 'GET',
  url: '/',
});

console.log(response.json());
```

### Setu-TS

```typescript
import { createTestApp, inject } from '@setu-ts/testing';

const app = createTestApp();
app.get('/', async (ctx) => ctx.json({ hello: 'world' }));

const response = await inject(app, {
  method: 'GET',
  path: '/',
});

console.log(await response.json());
```

## Common Patterns

### Encapsulation

### Fastify

```typescript
app.register(async (child) => {
  child.decorate('childUtil', () => 'child');
  child.get('/child', () => ({ util: child.childUtil() }));
});

// parent cannot access childUtil
```

### Setu-TS

```typescript
// Use capability tokens for encapsulation
ctx.services.register('child-util', () => 'child');

// Register routes in a scoped manner
ctx.router.group('/child', (group) => {
  group.get('/', async (ctx) => {
    const util = ctx.services.get('child-util');
    return ctx.json({ util: util() });
  });
});
```

### Reply Decorators

### Fastify

```typescript
app.decorateReply('withUser', function (user) {
  this.user = user;
  return this;
});

app.get('/', async (request, reply) => {
  return reply.withUser({ id: 1 }).code(200);
});
```

### Setu-TS

```typescript
// Use context state
app.get('/', async (ctx) => {
  ctx.state.user = { id: 1 };
  return ctx.json({ user: ctx.state.user });
});
```

## Migration Checklist

- [ ] Replace `fastify()` with `createApplication()`
- [ ] Replace `app.get/post/put/delete` with programmatic routes
- [ ] Replace hooks with lifecycle hooks or middleware
- [ ] Replace decorators with service registration
- [ ] Replace JSON Schema validation with Zod
- [ ] Replace `app.inject()` with `inject()` from testing utilities
- [ ] Update logging to use `LoggerPlugin`
- [ ] Update error handling to use middleware
- [ ] Update deployment for target runtime

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Examples](./examples.md) - See real-world applications
