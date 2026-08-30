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
| [rest](../apps/rest-api)   | REST API with common patterns (error handling, validation, health checks) | `deno task start` |

### Core Patterns

| Example                                | What It Proves                                   | Run               |
| -------------------------------------- | ------------------------------------------------ | ----------------- |
| [di-decorators](../apps/di-decorators) | Dependency injection and decorator usage         | `deno task start` |
| [database](../apps/database)           | Database operations with memory adapter          | `deno task start` |
| [CQRS](../apps/cqrs)                   | Command-Query Responsibility Segregation pattern | `deno task start` |
| [multi-tenancy](../apps/multi-tenant)  | Multi-tenant application with tenant resolution  | `deno task start` |

### Advanced Features

| Example                                      | What It Proves                                                    | Run                                |
| -------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| [microservices](../apps/microservices)       | Cross-service communication via messaging broker                  | `deno task start` (requires Redis) |
| [realtime](../apps/realtime)                 | Real-time communication with WebSocket/SSE and cross-replica sync | `deno task start` (requires Redis) |
| [realtime-clients](../apps/realtime-clients) | SDK SSE resumption/auth and WebSocket keep-alive across runtimes  | `deno task smoke`                  |
| [graphql](../apps/graphql-demo)              | GraphQL server with schema-first and code-first support           | `deno task start`                  |
| [grpc](../apps/grpc)                         | gRPC and Connect-ES on the same port as HTTP routes               | `deno task start`                  |

### Platform-Specific

| Example                                    | What It Proves                                                              | Run                                   |
| ------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------- |
| [cloudflare](../apps/cloudflare)           | Cloudflare Workers integration (KV, D1, Queues, Cron, Messaging, Cache API) | `deno task start` (requires Wrangler) |
| [compiled-binary](../apps/compiled-binary) | Compiled binary using `deno compile`                                        | Build with `deno task build`          |

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
app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});

await app.start({ port: 3000 });
```

---

### rest

A complete REST API example.

**What it demonstrates:**

- RESTful routing
- Error handling with RFC 9457 Problem Details
- Request validation
- Health checks
- Metrics collection
- Logging

**Key code:**

```typescript
import { errorHandler } from '@setu-ts/exceptions';
import { ValidationPlugin } from '@setu-ts/validation-plugin';

// `errorHandler()` returns middleware; register it as the OUTERMOST layer
// (lowest priority) so it wraps the whole pipeline and formats any thrown
// error (HttpError or otherwise) as a JSON / RFC 9457 response.
app.middleware.add(errorHandler({ format: 'rfc9457' }), {
  priority: 0,
  name: 'error-handler',
});
app.register(ValidationPlugin({ errorFormat: 'rfc9457' }));

app.router.post('/items', async (ctx) => {
  const body: Record<string, unknown> = await ctx.request.json();
  // Validation happens automatically if schema is registered
  return ctx.response.status(201).json({ id: '1', ...body });
});
```

---

### di-decorators

Dependency injection and decorators.

**What it demonstrates:**

- `@Controller` and `@Get` decorators
- `@Injectable()` for service registration
- `@Inject('token')` for constructor injection
- Positional parameter binding (`@Params(Param(…), Body(), Query(…))`)

**Key code:**

```typescript
import { Controller, Get, Inject, Injectable } from '@setu-ts/decorator-plugin';

@Injectable({ token: 'UserService' })
class UserService {
  async findAll() {
    return [{ id: '1', name: 'John' }];
  }
}

@Controller('/users')
@Inject('UserService')
class UserController {
  constructor(private readonly userService: UserService) {}

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
import { CAPABILITIES } from '@setu-ts/common';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService, IRepository } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'memory', // Use in-memory for development
}));

const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
const itemsRepo = db.getRepository<{ id: string; name: string }>('items');
const items = await itemsRepo.findAll();
const item = await itemsRepo.findById('1');
await itemsRepo.create({ name: 'New Item' });
await itemsRepo.update('1', { name: 'Updated' });
await itemsRepo.delete('1');
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
import { CAPABILITIES, type CqrsCommand, type CqrsQuery } from '@setu-ts/common';

app.register(CqrsPlugin());

const cqrs = ctx.services.get<ICqrsFacade>(CAPABILITIES.CQRS);

// Command — pass a command object matching your command handler type
const result = await cqrs.commandBus.execute({} as unknown as CqrsCommand);

// Query — pass a query object matching your query handler type
const items = await cqrs.queryBus.execute({} as unknown as CqrsQuery);
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
import { CAPABILITIES, type MessageHandler } from '@setu-ts/common';

// The redis-streams arm is discriminated on `broker: 'redis-streams'`.
// `url` is the Redis connection URL (read when no client is injected);
// `defaultQueue` is the consumer group every consumer shares.
app.register(MessagingPlugin({
  broker: 'redis-streams',
  url: 'redis://localhost:6379',
  defaultQueue: 'items-consumers',
}));

const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

// Subscribe — the handler receives the message payload directly
await broker.subscribe('items.created', (message: { id: string; name: string }) => {
  console.log('Item created:', message);
});

// Publish
await broker.publish('items.created', { id: '1', name: 'New Item' });

// Request/Reply
const response = await broker.request('service.method', data);
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
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';

// WebSocketPlugin options carry heartbeat/idle/limit knobs only — rooms are
// application-level, created from the WebSocketService after registration.
app.register(WebSocketPlugin({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 }));

// The redis transport fans room broadcasts across replicas. It takes a
// connection `url` (and/or injected `client`/`subscriber`), not a `redis`
// object — a Redis connection in subscriber mode refuses other commands, so
// one connection cannot both publish and subscribe.
app.register(RealtimeBackplanePlugin({
  transport: 'redis',
  url: 'redis://localhost:6379',
}));

// Routes + rooms are registered on the service, not in plugin options.
const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
ws.route('/ws/chat', {
  onOpen: (conn) => ws.room('chat').add(conn),
  onMessage: (conn, message: string | Uint8Array) => {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const userData = conn.data.get('user') as { id?: string } | undefined;
    ws.room('chat').broadcast(text, { except: conn });
  },
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

app.register(GraphqlPlugin({
  typeDefs: `
    type Query {
      hello: String
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'Hello, World!',
    },
  },
}));
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
- Messaging: a `publish` in one `fetch` invocation observed arriving at a subscriber in a separate
  `queue` invocation
- `detectRuntime()` answering `'cloudflare-workers'` on the real platform, which only workerd can
  prove — the platform sends its own user agent

Its smoke check runs against **real workerd** through `wrangler dev`, not a fake.

**Key code:**

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin, type ICloudflareBindings } from '@setu-ts/cloudflare-plugin';
import { CAPABILITIES } from '@setu-ts/common';

// Deployment glue: `env` and `waitUntil` come from `cloudflare:workers` at
// runtime; declared here so the block type-checks off a Worker toolchain.
declare const env: Record<string, unknown>;
declare const waitUntil: (promise: Promise<unknown>) => void;

const app = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({ env, waitUntil }),
  ],
});

app.router.get('/', async (ctx) => {
  const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);

  // KV — resolve the `KV` namespace via its named accessor.
  await cf.kv('KV').put('key', 'value');
  const value = await cf.kv('KV').get('key');

  // D1 — resolve the `DB` database via its named accessor.
  const result = await cf.d1('DB').prepare('SELECT * FROM items').all();

  // Queue — resolve the `QUEUE` producer via its named accessor.
  await cf.queue('QUEUE').send({ type: 'item-created', id: '1' });

  return ctx.response.json({ value, rows: result.results.length });
});
```

---

### full-stack

React Router SSR.

**What it demonstrates:**

- React Router v8 framework mode
- SSR with streaming
- Form actions
- Session management
- Database integration

**Key code:**

```typescript
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
import type { SsrRequestHandler } from '@setu-ts/react-router-plugin';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { CAPABILITIES, type IRuntimeServices } from '@setu-ts/common';

const sessionSecret = app.services
  .get<IRuntimeServices>(CAPABILITIES.RUNTIME)
  .env.SESSION_SECRET;
if (sessionSecret === undefined) throw new Error('SESSION_SECRET is required');
app.register(SessionPlugin({ secret: sessionSecret }));

app.register(ReactRouterPlugin({
  // Absolute path/URL to the React Router Vite server build (default export
  // = ServerBuild). Derive one with
  // `new URL('./build/server/index.js', import.meta.url).href`.
  serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
  // Optional seam for lazy loading the RR runtime. Returns SsrRuntime since v0.2.0.
  loadRequestHandler: async (serverBuildPath, mode) => {
    const build = await import(serverBuildPath);
    const { createRequestHandler, RouterContextProvider } = await import('npm:react-router@8');
    return {
      handler: createRequestHandler(build, mode) as SsrRequestHandler,
      createLoadContext: () => new RouterContextProvider(),
    };
  },
}));
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
import type { IPlugin, IPluginContext } from '@setu-ts/common';

export function MyPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    async register(ctx: IPluginContext) {
      // Register service
      ctx.services.register('my-service', new MyService());

      // Add middleware
      ctx.middleware.add(async (requestCtx, next) => {
        await next();
      });

      // Register routes
      ctx.router.get('/my-route', async (ctx) => {
        return ctx.response.json({ message: 'Hello from plugin' });
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
- [Docker and Kubernetes](./deployment.md) - Containerize and orchestrate an example
