# Examples

This guide provides links to runnable example applications that demonstrate Setu-TS capabilities.
Each example is a complete, tested application that proves specific framework features.

## Running Examples

All examples are located in the [`apps/`](../apps/) directory. To run an example:

```bash
# Navigate to the example
cd apps/<example-name>

# Run the application
deno task start

# Run the smoke tests
deno task smoke
```

## Examples by Capability

### Getting Started

| Example                    | What It Proves                                                            | Run               |
| -------------------------- | ------------------------------------------------------------------------- | ----------------- |
| [minimal](../apps/minimal) | Simplest possible Setu-TS application with one route                      | `deno task start` |
| [rest](../apps/rest)       | REST API with common patterns (error handling, validation, health checks) | `deno task start` |

### Core Patterns

| Example                                | What It Proves                                   | Run               |
| -------------------------------------- | ------------------------------------------------ | ----------------- |
| [di-decorators](../apps/di-decorators) | Dependency injection and decorator usage         | `deno task start` |
| [database](../apps/database)           | Database operations with memory adapter          | `deno task start` |
| [CQRS](../apps/cqrs)                   | Command-Query Responsibility Segregation pattern | `deno task start` |
| [multi-tenancy](../apps/multi-tenancy) | Multi-tenant application with tenant resolution  | `deno task start` |

### Advanced Features

| Example                                | What It Proves                                                    | Run                                |
| -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| [microservices](../apps/microservices) | Cross-service communication via messaging broker                  | `deno task start` (requires Redis) |
| [realtime](../apps/realtime)           | Real-time communication with WebSocket/SSE and cross-replica sync | `deno task start` (requires Redis) |
| [graphql](../apps/graphql-demo)        | GraphQL server with schema-first and code-first support           | `deno task start`                  |
| [grpc](../apps/grpc)                   | gRPC and Connect-ES on the same port as HTTP routes               | `deno task start`                  |

### Platform-Specific

| Example                                    | What It Proves                                        | Run                                   |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------- |
| [cloudflare](../apps/cloudflare)           | Cloudflare Workers integration (KV, D1, Queues, Cron) | `deno task start` (requires Wrangler) |
| [compiled-binary](../apps/compiled-binary) | Compiled binary using `deno compile`                  | Build with `deno task build`          |

### Full-Stack

| Example                            | What It Proves                                      | Run               |
| ---------------------------------- | --------------------------------------------------- | ----------------- |
| [full-stack](../apps/full-stack)   | React Router SSR with database integration          | `deno task start` |
| [static-site](../apps/static-site) | Static file serving with caching and range requests | `deno task start` |

### Development

| Example                                          | What It Proves                         | Run               |
| ------------------------------------------------ | -------------------------------------- | ----------------- |
| [plugin-development](../apps/plugin-development) | Template for developing custom plugins | `deno task start` |

## Example Deep Dives

### minimal

The simplest possible Setu-TS application.

**What it demonstrates:**

- Basic application setup
- Single route handler
- JSON response
- Health check endpoint

**Key code:**

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
await app.register(RuntimePlugin);

app.get('/', async (ctx) => {
  return ctx.json({ message: 'Hello, World!' });
});

await app.start({ port: 3000 });
```

---

### rest

A complete REST API example.

**What it demonstrates:**

- RESTful routing
- Error handling with RFC 7807 Problem Details
- Request validation
- Health checks
- Metrics collection
- Logging

**Key code:**

```typescript
import { ExceptionsPlugin } from '@setu-ts/exceptions';
import { ValidationPlugin } from '@setu-ts/validation-plugin';

await app.register(ExceptionsPlugin);
await app.register(ValidationPlugin, { validator: 'zod' });

app.post('/items', async (ctx) => {
  const body = await ctx.request.json();
  // Validation happens automatically if schema is registered
  return ctx.json({ id: '1', ...body }, { status: 201 });
});
```

---

### di-decorators

Dependency injection and decorators.

**What it demonstrates:**

- `@Controller` and `@Get` decorators
- `@injectable()` for service registration
- `@inject('token')` for constructor injection
- Parameter decorators (`@Param`, `@Body`, `@Query`)

**Key code:**

```typescript
import { Controller, Get, inject, injectable } from '@setu-ts/decorator-plugin';

@injectable()
class UserService {
  async findAll() {
    return [{ id: '1', name: 'John' }];
  }
}

@Controller('/users')
@injectable()
class UserController {
  constructor(
    @inject('UserService') private readonly userService: UserService,
  ) {}

  @Get()
  async list() {
    return this.userService.findAll();
  }
}
```

---

### database

Database operations.

**What it demonstrates:**

- Database plugin configuration
- Repository pattern
- CRUD operations
- Transaction support

**Key code:**

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

await app.register(DatabasePlugin, {
  type: 'memory', // Use in-memory for development
});

const db = ctx.services.get<IDatabaseService>('database');
const items = await db.findAll('items');
const item = await db.findById('items', '1');
await db.create('items', { name: 'New Item' });
await db.update('items', '1', { name: 'Updated' });
await db.delete('items', '1');
```

---

### cqrs

Command-Query Responsibility Segregation.

**What it demonstrates:**

- Command bus for write operations
- Query bus for read operations
- Handler registration
- Pipeline behaviors

**Key code:**

```typescript
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';

await app.register(CqrsPlugin);

const cqrs = ctx.services.get<ICqrsFacade>('cqrs');

// Command
const result = await cqrs.command(new CreateItemCommand({ name: 'Item' }));

// Query
const items = await cqrs.query(new GetAllItemsQuery());
```

---

### microservices

Cross-service communication.

**What it demonstrates:**

- Message broker (Redis Streams)
- Request/reply pattern
- Event publishing/subscribing
- Service discovery

**Key code:**

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

await app.register(MessagingPlugin, {
  broker: 'redis-streams',
  redis: { host: 'localhost', port: 6379 },
});

const broker = ctx.services.get<IMessageBroker>('messaging');

// Subscribe
await broker.subscribe('items.created', async (message) => {
  console.log('Item created:', message.data);
});

// Publish
await broker.publish('items.created', { id: '1', name: 'New Item' });

// Request/Reply
const response = await broker.request<Request, Response>('service.method', data);
```

---

### realtime

Real-time communication with cross-replica synchronization.

**What it demonstrates:**

- WebSocket connections
- SSE streams
- Room broadcasting
- Cross-replica sync via Redis backplane

**Key code:**

```typescript
import { WebsocketPlugin } from '@setu-ts/websocket-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

await app.register(WebsocketPlugin, {
  rooms: {
    '/ws/chat': {
      onMessage: (ctx, message) => {
        ctx.room.broadcast({ type: 'message', from: ctx.context.user.id, data: message });
      },
    },
  },
});

await app.register(RealtimeBackplanePlugin, {
  transport: 'redis',
  redis: { host: 'localhost', port: 6379 },
});
```

---

### graphql

GraphQL server.

**What it demonstrates:**

- Schema-first GraphQL
- Code-first resolvers
- GraphiQL interface
- Subscription support

**Key code:**

```typescript
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';

await app.register(GraphqlPlugin, {
  schema: `
    type Query {
      hello: String
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'Hello, World!',
    },
  },
});
```

---

### cloudflare

Cloudflare Workers integration.

**What it demonstrates:**

- KV namespace access
- D1 database queries
- Queue production
- Cron trigger handling
- Cache API usage

**Key code:**

```typescript
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

await app.register(CloudflarePlugin);

// KV
const kv = ctx.services.get<ICloudflareBindings>('cloudflare').kv;
await kv.put('key', 'value');
const value = await kv.get('key');

// D1
const d1 = ctx.services.get<ICloudflareBindings>('cloudflare').d1;
const result = await d1.prepare('SELECT * FROM items').all();

// Queue
const queue = ctx.services.get<ICloudflareBindings>('cloudflare').queue;
await queue.send({ type: 'item-created', id: '1' });
```

---

### full-stack

React Router SSR.

**What it demonstrates:**

- React Router v7 framework mode
- SSR with streaming
- Form actions
- Session management
- Database integration

**Key code:**

```typescript
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';

await app.register(SessionPlugin, {
  secret: process.env.SESSION_SECRET!,
});

await app.register(ReactRouterPlugin, {
  build: () => import('./build/server.js'),
});
```

---

### plugin-development

Custom plugin template.

**What it demonstrates:**

- Plugin structure
- Service registration
- Middleware addition
- Route registration
- Testing patterns

**Key code:**

```typescript
import { IPlugin, IPluginContext } from '@setu-ts/common';

export function MyPlugin(options: MyPluginOptions): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    async register(ctx: IPluginContext) {
      // Register service
      ctx.services.register('my-service', new MyService(options));

      // Add middleware
      ctx.middleware.add(async (ctx, next) => {
        await next();
      });

      // Register routes
      ctx.router.get('/my-route', async (ctx) => {
        return ctx.json({ message: 'Hello from plugin' });
      });
    },
  };
}
```

## Smoke Tests

Each example includes smoke tests that verify core functionality:

```bash
# Run smoke tests
deno task smoke

# Example output:
# ✓ GET /health returns 200
# ✓ POST /items creates an item
# ✓ GET /items returns created items
```

Smoke tests are designed to be minimal but sufficient to prove the example works. They use the
framework's testing utilities and run without external dependencies (unless noted).

## Running Examples in CI

Examples are tested in CI via `check:apps`:

```bash
deno task check:apps
```

This command:

1. Type-checks each example
2. Runs smoke tests
3. Reports failures

## Contributing Examples

When adding a new example:

1. Create the example in `apps/<name>/`
2. Add a `deno.json` with `start` and `smoke` tasks
3. Add a smoke test file (`smoke.ts`)
4. Update this `examples.md` with the example description
5. Verify `deno task check:apps` passes

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Runtime Deployment](./runtime-deployment.md) - Deploy to production
