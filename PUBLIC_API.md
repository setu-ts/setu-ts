# Hono Enterprise — Public API Contract

> **This document describes how developers use the framework.** Implementation details are
> intentionally omitted.

---

## Table of Contents

1. [Installation](#installation)
2. [Minimal Application](#minimal-application)
3. [createApplication()](#createapplication)
4. [RuntimePlugin()](#runtimeplugin)
5. [LoggerPlugin()](#loggerplugin)
6. [ConfigPlugin()](#configplugin)
7. [ValidationPlugin()](#validationplugin)
8. [DatabasePlugin()](#databaseplugin)
9. [AuthenticationPlugin()](#authenticationplugin)
10. [CachePlugin()](#cacheplugin)
11. [EventsPlugin()](#eventsplugin)
12. [CQRS](#cqrs)
13. [Messaging](#messaging)
14. [Queue](#queue)
15. [Scheduler](#scheduler)
16. [HttpClient](#httpclient)
17. [Storage](#storage)
18. [Mail](#mail)
19. [Notifications](#notifications)
20. [Feature Flags](#feature-flags)
21. [Health](#health)
22. [Metrics](#metrics)
23. [Telemetry](#telemetry)
24. [OpenAPI](#openapi)
25. [CLI](#cli)
26. [REST API Application](#rest-api-application)
27. [Microservice Application](#microservice-application)
28. [CQRS Application](#cqrs-application)
29. [Plugin Creation](#plugin-creation)
30. [Custom Middleware](#custom-middleware)
31. [Custom Decorators](#custom-decorators)
32. [Programmatic vs Decorator API](#programmatic-vs-decorator-api)
33. [Developer Ergonomics](#developer-ergonomics)
34. [API Reference: @hono-enterprise/common](#api-reference-hono-enterprisecommon)
35. [API Reference: @hono-enterprise/kernel](#api-reference-hono-enterprisekernel)
36. [API Reference: @hono-enterprise/runtime](#api-reference-hono-enterpriseruntime)

---

## Installation

Packages are published to [JSR](https://jsr.io) under the `@hono-enterprise` scope and are
consumable from every runtime:

```bash
# Deno
deno add jsr:@hono-enterprise/kernel jsr:@hono-enterprise/runtime

# npm / pnpm / yarn (via JSR's npm compatibility layer)
npx jsr add @hono-enterprise/kernel @hono-enterprise/runtime
pnpm dlx jsr add @hono-enterprise/kernel @hono-enterprise/runtime

# bun
bunx jsr add @hono-enterprise/kernel @hono-enterprise/runtime
```

Add plugins as needed:

```bash
deno add jsr:@hono-enterprise/logger-plugin jsr:@hono-enterprise/config-plugin \
         jsr:@hono-enterprise/validation-plugin jsr:@hono-enterprise/database-plugin \
         jsr:@hono-enterprise/auth-plugin jsr:@hono-enterprise/openapi-plugin
```

Or use a starter bundle:

```bash
deno add jsr:@hono-enterprise/rest-starter
```

---

## Minimal Application

The smallest possible application — just the kernel and runtime:

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/', (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});

await app.start({ port: 3000 });
```

No decorators. No DI. No reflection. Just a router and a runtime.

---

## createApplication()

The entry point to the framework.

### Signature

```typescript
function createApplication(options?: ApplicationOptions): Application;

interface ApplicationOptions {
  plugins?: IPlugin[];
  onError?: (error: Error, ctx: RequestContext) => void;
  onRequest?: (ctx: RequestContext) => void | Promise<void>;
  onResponse?: (ctx: RequestContext) => void | Promise<void>;
  gracefulShutdown?: boolean;
  shutdownTimeout?: number;
}

interface Application {
  register(plugin: IPlugin): Application;
  router: RouterApi;
  middleware: MiddlewareApi;
  services: ServiceRegistry;
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  inject(request: InjectRequest): Promise<InjectResponse>;
}

interface StartOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
}
```

### Usage

```typescript
const app = createApplication();

// Register plugins programmatically
app.register(RuntimePlugin());
app.register(LoggerPlugin({ level: 'info' }));

// Register an inline plugin
app.register({
  name: 'hello-plugin',
  version: '1.0.0',
  register(ctx) {
    ctx.router.get('/hello', (ctx) => ctx.response.json({ hello: 'world' }));
  },
});

await app.start({ port: 3000 });
```

### Testing Without a Server

```typescript
const app = createApplication({ plugins: [RuntimePlugin()] });

app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));

const response = await app.inject({ method: 'GET', url: '/users' });
console.log(response.statusCode); // 200
console.log(response.json()); // [{ id: 1 }]
```

---

## RuntimePlugin()

Provides runtime-agnostic services (UUID, timers, crypto, env, HTTP server).

### Registration

```typescript
import { RuntimePlugin } from '@hono-enterprise/runtime';

app.register(RuntimePlugin({
  httpAdapter: 'auto', // 'node' | 'deno' | 'bun' | 'auto'
}));
```

### Accessing Runtime Services

```typescript
app.router.get('/info', (ctx) => {
  const runtime = ctx.services.get<IRuntimeServices>('runtime');

  return ctx.response.json({
    platform: runtime.platform(),
    version: runtime.version(),
    hostname: runtime.hostname(),
    requestId: runtime.uuid(),
  });
});
```

### Available Runtime Services

```typescript
interface IRuntimeServices {
  platform(): 'node' | 'deno' | 'bun' | 'cloudflare-workers';
  version(): string;
  hostname(): string;

  uuid(): string;
  randomBytes(length: number): Uint8Array;
  getRandomValues(buffer: Uint8Array): Uint8Array;

  now(): number;
  hrtime(): [number, number];
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;

  env: Record<string, string | undefined>;
  exit(code?: number): never;

  fs?: IFileSystem;
}
```

---

## LoggerPlugin()

Provides structured logging via a capability token.

### Registration

```typescript
import { LoggerPlugin } from '@hono-enterprise/logger-plugin';

app.register(LoggerPlugin({
  level: 'info',
  transport: 'pino', // 'pino' | 'console' | 'noop'
  pretty: false,
  redact: ['password', 'token', 'authorization'],
  requestLogging: true,
  slowRequestThreshold: 5000, // ms
}));
```

### Usage in Routes

```typescript
app.router.get('/users/:id', async (ctx) => {
  const logger = ctx.services.get<ILogger>('logger');

  logger.info('Fetching user', { userId: ctx.params.id });

  const user = await getUser(ctx.params.id);

  logger.debug('User fetched', { userId: user.id, duration: ctx.request.duration });

  return ctx.response.json(user);
});
```

### Child Loggers

```typescript
app.middleware.add(async (ctx, next) => {
  const logger = ctx.services.get<ILogger>('logger');
  const requestLogger = logger.child({
    requestId: ctx.request.id,
    correlationId: ctx.request.headers.get('x-correlation-id'),
  });

  ctx.services.register('logger', requestLogger, { override: true });
  await next();
});
```

### Logger Interface

```typescript
interface ILogger {
  fatal(msg: string, metadata?: Record<string, unknown>): void;
  error(msg: string, metadata?: Record<string, unknown>): void;
  warn(msg: string, metadata?: Record<string, unknown>): void;
  info(msg: string, metadata?: Record<string, unknown>): void;
  debug(msg: string, metadata?: Record<string, unknown>): void;
  trace(msg: string, metadata?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
  setLevel(level: LogLevel): void;
}
```

---

## ConfigPlugin()

Provides strongly-typed configuration with environment validation.

### Registration

```typescript
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
import { z } from 'zod';

const AppConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

app.register(ConfigPlugin({
  envFilePath: ['.env.local', '.env'],
  validationSchema: AppConfigSchema,
  isGlobal: true,
  cache: true,
  expandVariables: true,
}));
```

### Usage

```typescript
app.router.get('/config', (ctx) => {
  const config = ctx.services.get<IConfig>('config');

  return ctx.response.json({
    port: config.get<number>('PORT'),
    env: config.get<string>('NODE_ENV'),
    hasRedis: config.has('REDIS_URL'),
    redisUrl: config.get<string>('REDIS_URL', { default: 'redis://localhost:6379' }),
  });
});
```

### Config Interface

```typescript
interface IConfig {
  get<T>(key: string, options?: { default?: T; throwOnMissing?: boolean }): T;
  getOrThrow<T>(key: string): T;
  has(key: string): boolean;
  set(key: string, value: unknown): void;
  getAll(): Record<string, unknown>;
  parseBoolean(value: string): boolean;
  parseNumber(value: string): number;
  parseArray(value: string): string[];
  parseJSON<T>(value: string): T;
}
```

---

## ValidationPlugin()

Provides Zod-based validation with standardized errors.

### Registration

```typescript
import { ValidationPlugin } from '@hono-enterprise/validation-plugin';

app.register(ValidationPlugin({
  errorFormat: 'rfc7807', // 'default' | 'rfc7807' | 'nestjs' | custom
  whitelist: true,
  forbidNonWhitelisted: false,
  sanitize: true,
}));
```

### Programmatic Validation

```typescript
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  age: z.number().int().min(18).max(120),
  role: z.enum(['admin', 'user', 'guest']).default('user'),
});

app.router.post('/users', {
  middleware: [
    // Validate body against schema
    (ctx, next) => {
      const validation = ctx.services.get<IValidationService>('validation');
      const result = validation.validate(CreateUserSchema, ctx.request.body);

      if (!result.success) {
        return ctx.response.status(400).json({ errors: result.error });
      }

      ctx.state.set('validatedBody', result.data);
      return next();
    },
  ],
  handler: async (ctx) => {
    const body = ctx.state.get<z.infer<typeof CreateUserSchema>>('validatedBody');
    // body is fully typed and validated
    const user = await createUser(body);
    return ctx.response.status(201).json(user);
  },
});
```

### Validation Middleware Helpers

```typescript
import { validateBody, validateParams, validateQuery } from '@hono-enterprise/validation-plugin';

app.router.get('/users', {
  middleware: [validateQuery(ListUsersQuerySchema)],
  handler: async (ctx) => {
    const query = ctx.state.get('validatedQuery');
    // query is typed
  },
});

app.router.put('/users/:id', {
  middleware: [
    validateParams(z.object({ id: z.string().uuid() })),
    validateBody(UpdateUserSchema),
  ],
  handler: async (ctx) => {/* ... */},
});
```

### Sanitization

```typescript
const validation = ctx.services.get<IValidationService>('validation');

const sanitized = validation.sanitize(userInput, {
  htmlEncode: true,
  stripTags: true,
  maxLength: 1000,
  trim: true,
});
```

### Error Response Format (RFC 7807)

```json
{
  "type": "https://hono-enterprise.dev/errors/validation",
  "title": "Validation Error",
  "status": 400,
  "detail": "Request body validation failed",
  "instance": "/users",
  "errors": [
    {
      "field": "email",
      "message": "Invalid email address",
      "code": "invalid_string"
    }
  ]
}
```

---

## DatabasePlugin()

Provides database access with repository pattern and unit of work.

### Registration

```typescript
import { DatabasePlugin } from '@hono-enterprise/database-plugin';

app.register(DatabasePlugin({
  type: 'prisma',
  options: {
    url: config.get('DATABASE_URL'),
    logQueries: config.get('NODE_ENV') === 'development',
    poolSize: 10,
  },
}));
```

### Repository Pattern

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

app.router.get('/users', async (ctx) => {
  const db = ctx.services.get<IDatabaseService>('database');
  const userRepo = db.getRepository<User>('User');

  const users = await userRepo.findAll({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
    limit: 20,
    offset: 0,
  });

  return ctx.response.json(users);
});

app.router.get('/users/:id', async (ctx) => {
  const db = ctx.services.get<IDatabaseService>('database');
  const user = await db.getRepository<User>('User').findById(ctx.params.id);

  if (!user) {
    return ctx.response.status(404).json({ error: 'User not found' });
  }

  return ctx.response.json(user);
});

app.router.post('/users', async (ctx) => {
  const db = ctx.services.get<IDatabaseService>('database');
  const body = ctx.state.get('validatedBody');

  const user = await db.getRepository<User>('User').create({
    name: body.name,
    email: body.email,
  });

  return ctx.response.status(201).json(user);
});
```

### Unit of Work (Transactions)

```typescript
app.router.post('/orders', async (ctx) => {
  const db = ctx.services.get<IDatabaseService>('database');

  const order = await db.transaction(async (uow) => {
    const orderRepo = uow.getRepository<Order>('Order');
    const inventoryRepo = uow.getRepository<Inventory>('Inventory');
    const paymentRepo = uow.getRepository<Payment>('Payment');

    // All operations in same transaction
    const newOrder = await orderRepo.create(ctx.request.body);
    await inventoryRepo.decrement(newOrder.productId, newOrder.quantity);
    await paymentRepo.create({ orderId: newOrder.id, amount: newOrder.total });

    return newOrder;
  });

  return ctx.response.status(201).json(order);
});
```

### Database Interface

```typescript
interface IDatabaseService {
  getRepository<Entity>(entity: string): IRepository<Entity>;
  transaction<T>(work: (uow: IUnitOfWork) => Promise<T>): Promise<T>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  migrate(): Promise<void>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

interface IRepository<Entity> {
  findById(id: string): Promise<Entity | null>;
  findAll(options?: FindOptions): Promise<Entity[]>;
  create(data: Partial<Entity>): Promise<Entity>;
  update(id: string, data: Partial<Entity>): Promise<Entity>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  count(options?: CountOptions): Promise<number>;
}
```

### Multiple Databases

```typescript
app.register(DatabasePlugin({
  type: 'prisma',
  name: 'primary',
  options: { url: config.get('PRIMARY_DATABASE_URL') },
}));

app.register(DatabasePlugin({
  type: 'prisma',
  name: 'analytics',
  options: { url: config.get('ANALYTICS_DATABASE_URL') },
}));

// Access by name
app.router.get('/analytics', async (ctx) => {
  const primaryDb = ctx.services.get<IDatabaseService>('database:primary');
  const analyticsDb = ctx.services.get<IDatabaseService>('database:analytics');
  // ...
});
```

---

## AuthenticationPlugin()

Provides JWT, API key, RBAC, and guards.

### Registration

```typescript
import { AuthenticationPlugin } from '@hono-enterprise/auth-plugin';

app.register(AuthenticationPlugin({
  jwt: {
    secret: config.get('JWT_SECRET'),
    expiresIn: '1h',
    refreshExpiresIn: '7d',
    issuer: 'my-app',
    audience: 'my-app-users',
  },
  apiKey: {
    header: 'X-API-Key',
    validate: async (key) => {
      const user = await apiKeyService.validate(key);
      return user ? { id: user.id, roles: user.roles } : null;
    },
  },
  rbac: {
    roles: {
      admin: {
        permissions: ['*'],
        inherits: ['manager'],
      },
      manager: {
        permissions: ['users:read', 'users:write', 'reports:read'],
        inherits: ['user'],
      },
      user: {
        permissions: ['profile:read', 'profile:write'],
      },
    },
  },
  rateLimit: {
    windowMs: 60000,
    max: 100,
    storage: 'memory', // 'memory' | 'redis'
  },
}));
```

### Login (Issue Token)

```typescript
app.router.post('/auth/login', async (ctx) => {
  const auth = ctx.services.get<IAuthService>('authentication');
  const { email, password } = ctx.request.body;

  const user = await userService.verifyCredentials(email, password);
  if (!user) {
    return ctx.response.status(401).json({ error: 'Invalid credentials' });
  }

  const accessToken = auth.jwt.sign({
    userId: user.id,
    roles: user.roles,
  });

  const refreshToken = auth.jwt.signRefresh({
    userId: user.id,
  });

  return ctx.response.json({ accessToken, refreshToken });
});
```

### Protecting Routes

```typescript
import { requireAuth, requireRole, requirePermission } from '@hono-enterprise/auth-plugin';

// Require authentication
app.router.get('/profile', {
  middleware: [requireAuth()],
  handler: async (ctx) => {
    return ctx.response.json(ctx.request.user);
  },
});

// Require specific role
app.router.delete('/users/:id', {
  middleware: [requireAuth(), requireRole('admin')],
  handler: async (ctx) => { /* ... */ },
});

// Require specific permission
app.router.post('/users', {
  middleware: [requireAuth(), requirePermission('users:write')],
  handler: async (ctx) => { /* ... */ },
});

// Require any of multiple roles
app.router.get('/reports', {
  middleware: [requireAuth(), requireAnyRole(['admin', 'manager'])],
  handler: async (ctx) => { /* ... */ },
});

// Public route (bypass auth)
app.router.get('/health', {
  middleware: [public()],
  handler: async (ctx) => ctx.response.json({ status: 'ok' }),
});
```

### Accessing the Current User

```typescript
app.router.get('/me', {
  middleware: [requireAuth()],
  handler: async (ctx) => {
    const user = ctx.request.user;
    return ctx.response.json({
      id: user.id,
      roles: user.roles,
      permissions: user.permissions,
    });
  },
});
```

### API Key Authentication

```typescript
app.router.get('/api/data', {
  middleware: [requireApiKey()],
  handler: async (ctx) => {
    // ctx.request.user is populated from API key validation
    return ctx.response.json({ data: 'protected' });
  },
});
```

---

## CachePlugin()

Provides caching with multiple stores.

### Registration

```typescript
import { CachePlugin } from '@hono-enterprise/cache-plugin';

app.register(CachePlugin({
  store: 'redis',
  options: {
    url: config.get('REDIS_URL'),
    prefix: 'myapp:',
    defaultTTL: 3600,
  },
}));
```

### Programmatic API

```typescript
app.router.get('/users/:id', async (ctx) => {
  const cache = ctx.services.get<ICache>('cache');
  const cacheKey = `user:${ctx.params.id}`;

  // Try cache
  const cached = await cache.get<User>(cacheKey);
  if (cached) {
    return ctx.response.json(cached);
  }

  // Fetch from database
  const user = await getUser(ctx.params.id);

  // Cache for 1 hour
  await cache.set(cacheKey, user, 3600);

  return ctx.response.json(user);
});
```

### Cache Middleware

```typescript
import { cacheMiddleware } from '@hono-enterprise/cache-plugin';

app.router.get('/users/:id', {
  middleware: [
    cacheMiddleware({
      ttl: 3600,
      key: (ctx) => `user:${ctx.params.id}`,
      bypass: (ctx) => ctx.request.query.refresh === 'true',
    }),
  ],
  handler: async (ctx) => {
    const user = await getUser(ctx.params.id);
    return ctx.response.json(user);
  },
});
```

### Cache Interface

```typescript
interface ICache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  getMany<T>(keys: string[]): Promise<(T | null)[]>;
  setMany<T>(entries: Array<[string, T]>, ttl?: number): Promise<void>;
  deleteMany(keys: string[]): Promise<boolean[]>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<void>;
}
```

---

## EventsPlugin()

Provides in-memory event bus for domain events.

### Registration

```typescript
import { EventsPlugin } from '@hono-enterprise/events-plugin';

app.register(EventsPlugin({
  async: true,
  errorHandler: (error, event) => {
    const logger = ctx.services.get('logger');
    logger.error('Event handler failed', { error, eventType: event.type });
  },
}));
```

### Defining Events

```typescript
import { DomainEvent } from '@hono-enterprise/events-plugin';

class UserCreatedEvent extends DomainEvent<{ userId: string; email: string }> {
  readonly type = 'UserCreated';
}

class OrderPlacedEvent extends DomainEvent<{ orderId: string; total: number }> {
  readonly type = 'OrderPlaced';
}
```

### Publishing Events

```typescript
app.router.post('/users', async (ctx) => {
  const eventBus = ctx.services.get<IEventBus>('events');
  const user = await createUser(ctx.request.body);

  await eventBus.publish(
    new UserCreatedEvent({
      userId: user.id,
      email: user.email,
    }),
  );

  return ctx.response.status(201).json(user);
});
```

### Subscribing to Events

```typescript
// In a plugin
app.register({
  name: 'user-event-handlers',
  version: '1.0.0',
  dependencies: ['events'],
  register(ctx) {
    const eventBus = ctx.services.get<IEventBus>('events');

    eventBus.subscribe<UserCreatedEvent>('UserCreated', async (event) => {
      const mailer = ctx.services.get<IMailer>('mail');
      await mailer.send({
        to: event.data.email,
        subject: 'Welcome!',
        body: 'Thank you for joining.',
      });
    });
  },
});
```

### Event Interface

```typescript
interface IEventBus {
  publish(event: DomainEvent): Promise<void>;
  publishBatch(events: DomainEvent[]): Promise<void>;
  subscribe<T extends DomainEvent>(
    type: string,
    handler: (event: T) => Promise<void>,
  ): Subscription;
  unsubscribe(subscription: Subscription): void;
  getSubscriptions(type: string): Subscription[];
}
```

---

## CQRS

Provides command/query separation with buses.

### Registration

```typescript
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';

app.register(CqrsPlugin({
  behaviors: ['logging', 'validation', 'timing'],
}));
```

### Defining Commands and Queries

```typescript
import { ICommand, IQuery } from '@hono-enterprise/cqrs-plugin';

class CreateUserCommand implements ICommand {
  constructor(
    public readonly data: { name: string; email: string },
    public readonly id: string = crypto.randomUUID(),
    public readonly createdAt: Date = new Date(),
  ) {}
}

class GetUserQuery implements IQuery {
  constructor(
    public readonly data: { id: string },
    public readonly id: string = crypto.randomUUID(),
    public readonly createdAt: Date = new Date(),
  ) {}
}
```

### Implementing Handlers

```typescript
import { ICommandHandler, IQueryHandler } from '@hono-enterprise/cqrs-plugin';

class CreateUserHandler implements ICommandHandler<CreateUserCommand, string> {
  constructor(private db: IDatabaseService) {}

  async handle(command: CreateUserCommand): Promise<string> {
    const user = await this.db.getRepository<User>('User').create(command.data);
    return user.id;
  }
}

class GetUserHandler implements IQueryHandler<GetUserQuery, User> {
  constructor(private db: IDatabaseService) {}

  async handle(query: GetUserQuery): Promise<User> {
    const user = await this.db.getRepository<User>('User').findById(query.data.id);
    if (!user) throw new Error('User not found');
    return user;
  }
}
```

### Registering Handlers

```typescript
app.register({
  name: 'user-handlers',
  version: '1.0.0',
  dependencies: ['cqrs', 'database'],
  register(ctx) {
    const commandBus = ctx.services.get<ICommandBus>('command-bus');
    const queryBus = ctx.services.get<IQueryBus>('query-bus');
    const db = ctx.services.get<IDatabaseService>('database');

    commandBus.register('CreateUserCommand', new CreateUserHandler(db));
    queryBus.register('GetUserQuery', new GetUserHandler(db));
  },
});
```

### Using in Routes

```typescript
app.router.post('/users', async (ctx) => {
  const commandBus = ctx.services.get<ICommandBus>('command-bus');
  const userId = await commandBus.execute(new CreateUserCommand(ctx.request.body));
  return ctx.response.status(201).json({ id: userId });
});

app.router.get('/users/:id', async (ctx) => {
  const queryBus = ctx.services.get<IQueryBus>('query-bus');
  const user = await queryBus.execute(new GetUserQuery({ id: ctx.params.id }));
  return ctx.response.json(user);
});
```

---

## Messaging

Provides message broker abstraction.

### Registration

```typescript
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';

app.register(MessagingPlugin({
  broker: 'rabbitmq',
  options: {
    url: config.get('RABBITMQ_URL'),
    exchange: 'myapp.events',
    exchangeType: 'topic',
    durable: true,
  },
}));
```

### Publishing Messages

```typescript
app.router.post('/orders', async (ctx) => {
  const broker = ctx.services.get<IMessageBroker>('messaging');
  const order = await createOrder(ctx.request.body);

  await broker.publish('order.created', {
    orderId: order.id,
    total: order.total,
    customerId: order.customerId,
  }, {
    correlationId: ctx.request.id,
    persistent: true,
  });

  return ctx.response.status(201).json(order);
});
```

### Subscribing to Messages

```typescript
app.register({
  name: 'order-processor',
  version: '1.0.0',
  dependencies: ['messaging'],
  register(ctx) {
    const broker = ctx.services.get<IMessageBroker>('messaging');

    broker.subscribe('order.created', async (message, metadata) => {
      console.log('Processing order', message.orderId);
      await processOrder(message);
    }, {
      queue: 'order-processor',
      durable: true,
      prefetch: 10,
    });
  },
});
```

### Multiple Brokers

```typescript
app.register(MessagingPlugin({
  broker: 'rabbitmq',
  name: 'events',
  options: { url: config.get('EVENTS_RABBITMQ_URL') },
}));

app.register(MessagingPlugin({
  broker: 'kafka',
  name: 'audit',
  options: { brokers: config.get('KAFKA_BROKERS').split(',') },
}));

// Access by name
const eventsBroker = ctx.services.get<IMessageBroker>('messaging:events');
const auditBroker = ctx.services.get<IMessageBroker>('messaging:audit');
```

---

## Queue

Provides background job queue.

### Registration

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({
  adapter: 'redis',
  options: {
    url: config.get('REDIS_URL'),
    concurrency: 5,
  },
}));
```

### Adding Jobs

```typescript
app.router.post('/users', async (ctx) => {
  const queue = ctx.services.get<IQueue>('queue');
  const user = await createUser(ctx.request.body);

  // Add a background job
  await queue.add('send-welcome-email', {
    userId: user.id,
    email: user.email,
  });

  // Add a delayed job
  await queue.add('send-reminder', {
    userId: user.id,
  }, { delay: 86400000 }); // 24 hours

  return ctx.response.status(201).json(user);
});
```

### Processing Jobs

```typescript
app.register({
  name: 'job-processors',
  version: '1.0.0',
  dependencies: ['queue', 'mail'],
  register(ctx) {
    const queue = ctx.services.get<IQueue>('queue');
    const mailer = ctx.services.get<IMailer>('mail');

    queue.process('send-welcome-email', async (job) => {
      await mailer.send({
        to: job.data.email,
        subject: 'Welcome!',
        body: 'Thank you for joining.',
      });
    }, { concurrency: 3 });

    queue.process('send-reminder', async (job) => {
      await sendReminder(job.data.userId);
    });
  },
});
```

### Recurring Jobs

```typescript
const queue = ctx.services.get<IQueue>('queue');

// Every hour
await queue.addRecurring('cleanup-old-sessions', {}, { cron: '0 * * * *' });

// Every 5 minutes
await queue.addRecurring('sync-data', {}, { every: 300000 });
```

### Job Options

```typescript
await queue.add('process-payment', paymentData, {
  priority: 1,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
  removeOnComplete: 100,
  removeOnFail: 50,
});
```

---

## Scheduler

Provides cron jobs and scheduled tasks.

### Registration

```typescript
import { SchedulerPlugin } from '@hono-enterprise/scheduler-plugin';

app.register(SchedulerPlugin({
  timezone: 'UTC',
  distributedLock: {
    enabled: true,
    storage: 'redis',
    url: config.get('REDIS_URL'),
  },
}));
```

### Scheduling Jobs

```typescript
app.register({
  name: 'scheduled-jobs',
  version: '1.0.0',
  dependencies: ['scheduler'],
  register(ctx) {
    const scheduler = ctx.services.get<IScheduler>('scheduler');

    // Cron expression
    scheduler.cron('cleanup-temp-files', '0 2 * * *', async (job) => {
      await cleanupTempFiles();
    });

    // Every 5 minutes
    scheduler.every('health-check', 300000, async (job) => {
      await runHealthCheck();
    });

    // One-time delayed job
    scheduler.delay('send-followup', 86400000, async (job) => {
      await sendFollowupEmail(job.data.userId);
    }, { data: { userId: '123' } });

    // With retry
    scheduler.cron('sync-external-api', '*/30 * * * *', async (job) => {
      await syncFromExternalApi();
    }, {
      retry: {
        limit: 3,
        delay: 10000,
        backoff: 'exponential',
      },
    });
  },
});
```

### Managing Jobs

```typescript
const scheduler = ctx.services.get<IScheduler>('scheduler');

// Pause
await scheduler.pause('cleanup-temp-files');

// Resume
await scheduler.resume('cleanup-temp-files');

// Remove
await scheduler.remove('cleanup-temp-files');

// Get next run time
const nextRun = await scheduler.getNextRun('cleanup-temp-files');
```

---

## HttpClient

Provides an HTTP client for external API calls.

### Registration

```typescript
import { HttpClientPlugin } from '@hono-enterprise/http-client-plugin';

app.register(HttpClientPlugin({
  baseURL: 'https://api.external.com',
  timeout: 5000,
  retries: 3,
  retryDelay: 1000,
  headers: {
    'User-Agent': 'my-app/1.0',
  },
}));
```

### Usage

```typescript
app.router.get('/weather', async (ctx) => {
  const http = ctx.services.get<IHttpClient>('http-client');

  const response = await http.get('/weather', {
    params: { city: 'London' },
    headers: { 'X-API-Key': config.get('WEATHER_API_KEY') },
  });

  return ctx.response.json(response.data);
});

// POST
const result = await http.post('/webhook', {
  event: 'order.created',
  data: { orderId: '123' },
});

// With retry and circuit breaker
const data = await http.get('/unstable-api', {
  retry: { limit: 3, backoff: 'exponential' },
  circuitBreaker: { threshold: 5, timeout: 30000 },
});
```

---

## Storage

Provides file storage abstraction.

### Registration

```typescript
import { StoragePlugin } from '@hono-enterprise/storage-plugin';

app.register(StoragePlugin({
  provider: 's3',
  options: {
    bucket: config.get('S3_BUCKET'),
    region: config.get('AWS_REGION'),
    accessKeyId: config.get('AWS_ACCESS_KEY_ID'),
    secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY'),
  },
}));
```

### Usage

```typescript
app.router.post('/upload', {
  middleware: [storage.upload({ fieldname: 'file', maxSize: 10 * 1024 * 1024 })],
  handler: async (ctx) => {
    const storage = ctx.services.get<IStorage>('storage');
    const file = ctx.request.file('file');

    const key = `uploads/${Date.now()}-${file.name}`;
    await storage.put(key, file.data);

    const url = await storage.getSignedUrl(key, { expiresIn: 3600 });

    return ctx.response.json({ url, key });
  },
});

app.router.get('/files/:key', async (ctx) => {
  const storage = ctx.services.get<IStorage>('storage');
  const file = await storage.get(ctx.params.key);
  return ctx.response.send(file, { type: 'application/octet-stream' });
});
```

---

## Mail

Provides email sending.

### Registration

```typescript
import { MailPlugin } from '@hono-enterprise/mail-plugin';

app.register(MailPlugin({
  provider: 'smtp',
  options: {
    host: config.get('SMTP_HOST'),
    port: 587,
    auth: {
      user: config.get('SMTP_USER'),
      pass: config.get('SMTP_PASS'),
    },
  },
  defaults: {
    from: 'noreply@myapp.com',
  },
}));
```

### Usage

```typescript
app.router.post('/users', async (ctx) => {
  const mailer = ctx.services.get<IMailer>('mail');
  const user = await createUser(ctx.request.body);

  await mailer.send({
    to: user.email,
    subject: 'Welcome to MyApp',
    html: '<h1>Welcome!</h1><p>Thank you for joining.</p>',
    text: 'Welcome! Thank you for joining.',
  });

  // Using templates
  await mailer.sendTemplate('welcome', {
    to: user.email,
  }, {
    name: user.name,
    verificationUrl: `https://myapp.com/verify?token=${user.verificationToken}`,
  });

  return ctx.response.status(201).json(user);
});
```

---

## Notifications

Provides multi-channel notifications.

### Registration

```typescript
import { NotificationPlugin } from '@hono-enterprise/notification-plugin';

app.register(NotificationPlugin({
  channels: {
    email: { provider: 'mail' },
    sms: {
      provider: 'twilio',
      options: { accountSid: config.get('TWILIO_SID'), authToken: config.get('TWILIO_TOKEN') },
    },
    push: { provider: 'fcm', options: { serverKey: config.get('FCM_SERVER_KEY') } },
    slack: { provider: 'slack', options: { webhookUrl: config.get('SLACK_WEBHOOK') } },
  },
}));
```

### Usage

```typescript
app.router.post('/orders', async (ctx) => {
  const notifier = ctx.services.get<INotifier>('notification');
  const order = await createOrder(ctx.request.body);

  // Multi-channel
  await notifier.send({
    channels: ['email', 'sms'],
    to: { email: order.customerEmail, phone: order.customerPhone },
    subject: 'Order Confirmed',
    body: `Your order ${order.id} has been confirmed.`,
  });

  // Channel-specific
  await notifier.sendSlack({
    channel: '#orders',
    message: `New order: ${order.id}`,
  });

  return ctx.response.status(201).json(order);
});
```

---

## Feature Flags

Provides feature flag capability.

### Registration

```typescript
import { FeatureFlagsPlugin } from '@hono-enterprise/feature-flags-plugin';

app.register(FeatureFlagsPlugin({
  provider: 'config',
  options: {
    flags: {
      'new-dashboard': { enabled: true, percentage: 50 },
      'beta-features': { enabled: false, users: ['user1', 'user2'] },
      'dark-mode': { enabled: true },
    },
  },
}));
```

### Usage

```typescript
app.router.get('/dashboard', async (ctx) => {
  const flags = ctx.services.get<IFeatureFlags>('feature-flags');
  const user = ctx.request.user;

  if (flags.isEnabled('new-dashboard', { userId: user?.id })) {
    return ctx.response.json({ dashboard: 'new' });
  }

  return ctx.response.json({ dashboard: 'old' });
});

// Middleware
app.router.get('/beta', {
  middleware: [flags.middleware('beta-features', { fallback: '/not-found' })],
  handler: async (ctx) => {/* ... */},
});
```

---

## Health

Provides health check endpoints.

### Registration

```typescript
import { HealthPlugin } from '@hono-enterprise/health-plugin';

app.register(HealthPlugin({
  endpoints: {
    health: '/health',
    live: '/live',
    ready: '/ready',
  },
  indicators: [
    'database',
    'cache',
    'queue',
  ],
}));
```

### Custom Health Indicators

```typescript
app.register({
  name: 'custom-health',
  version: '1.0.0',
  dependencies: ['health'],
  register(ctx) {
    const health = ctx.services.get<IHealthService>('health');

    health.registerIndicator('external-api', async () => {
      const http = ctx.services.get<IHttpClient>('http-client');
      try {
        await http.get('/health', { timeout: 3000 });
        return { status: 'up', data: { responseTime: 123 } };
      } catch {
        return { status: 'down', data: { error: 'Connection failed' } };
      }
    });
  },
});
```

### Response

```json
GET /health
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": { "status": "up", "latency": 5 },
    "cache": { "status": "up", "latency": 2 },
    "queue": { "status": "up", "latency": 10 },
    "external-api": { "status": "down", "error": "Connection failed" }
  }
}
```

---

## Metrics

Provides Prometheus metrics.

### Registration

```typescript
import { MetricsPlugin } from '@hono-enterprise/metrics-plugin';

app.register(MetricsPlugin({
  endpoint: '/metrics',
  defaultMetrics: true,
  httpMetrics: true,
  customMetrics: [
    { name: 'users_total', help: 'Total users', type: 'counter' },
    { name: 'active_connections', help: 'Active connections', type: 'gauge' },
  ],
}));
```

### Custom Metrics

```typescript
app.router.post('/users', async (ctx) => {
  const metrics = ctx.services.get<IMetricsService>('metrics');
  const user = await createUser(ctx.request.body);

  metrics.counter('users_total').inc();
  metrics.gauge('active_connections').inc();

  return ctx.response.status(201).json(user);
});

// Histogram
app.router.get('/search', async (ctx) => {
  const metrics = ctx.services.get<IMetricsService>('metrics');
  const histogram = metrics.histogram('search_duration_seconds', {
    labels: ['query_type'],
    buckets: [0.1, 0.5, 1, 5],
  });

  const start = Date.now();
  const results = await search(ctx.request.query);
  histogram.observe({ query_type: 'full-text' }, (Date.now() - start) / 1000);

  return ctx.response.json(results);
});
```

### Prometheus Endpoint

```
GET /metrics

# HELP users_total Total users
# TYPE users_total counter
users_total 1234

# HELP active_connections Active connections
# TYPE active_connections gauge
active_connections 42

# HELP http_request_duration_seconds HTTP request duration
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1"} 100
http_request_duration_seconds_bucket{le="0.5"} 150
...
```

---

## Telemetry

Provides OpenTelemetry distributed tracing.

### Registration

```typescript
import { TelemetryPlugin } from '@hono-enterprise/telemetry-plugin';

app.register(TelemetryPlugin({
  serviceName: 'my-service',
  serviceVersion: '1.0.0',
  exporter: 'otlp',
  endpoint: config.get('OTLP_ENDPOINT'),
  instrumentations: ['http', 'database', 'queue'],
  sampling: {
    type: 'traceidratio',
    ratio: 0.1,
  },
}));
```

### Manual Spans

```typescript
app.router.post('/orders', async (ctx) => {
  const telemetry = ctx.services.get<ITelemetryService>('telemetry');

  const order = await telemetry.withSpan('create-order', async (span) => {
    span.setAttribute('customerId', ctx.request.body.customerId);
    span.setAttribute('total', ctx.request.body.total);

    const order = await createOrder(ctx.request.body);

    span.setAttribute('orderId', order.id);
    span.setStatus('ok');

    return order;
  });

  return ctx.response.status(201).json(order);
});
```

---

## OpenAPI

Provides automatic OpenAPI documentation.

### Registration

```typescript
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';

app.register(OpenApiPlugin({
  endpoint: '/docs',
  specEndpoint: '/openapi.json',
  title: 'My API',
  version: '1.0.0',
  description: 'A sample API built with Hono Enterprise',
  servers: [
    { url: 'https://api.myapp.com', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  },
}));
```

### Defining Route Schemas

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});

const CreateUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
});

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

app.router.post('/users', {
  schema: {
    body: CreateUserSchema,
    response: {
      201: UserSchema,
      400: ErrorSchema,
      409: ErrorSchema,
    },
    tags: ['Users'],
    summary: 'Create a new user',
    description: 'Creates a new user account',
    security: [{ bearerAuth: [] }],
  },
  handler: async (ctx) => {/* ... */},
});
```

### Accessing the Spec

```typescript
// The spec is available at /openapi.json
// The Swagger UI is available at /docs

// Programmatic access
const openapi = ctx.services.get<IOpenApiService>('openapi');
const spec = openapi.getSpec();
```

---

## CLI

Provides scaffolding and code generation.

### Commands

```bash
# Create a new project
hono-enterprise new my-app
hono-enterprise new my-app --template rest
hono-enterprise new my-app --template microservice

# Generate code
hono-enterprise generate plugin my-plugin
hono-enterprise generate controller UserController
hono-enterprise generate service UserService
hono-enterprise generate route users
hono-enterprise generate middleware rate-limit
hono-enterprise generate guard admin-only
hono-enterprise generate health-indicator external-api
hono-enterprise generate command-handler CreateUser
hono-enterprise generate query-handler GetUser
hono-enterprise generate event-handler UserCreatedHandler
hono-enterprise generate job send-welcome-email
hono-enterprise generate migration add_users_table

# Aliases
hono-enterprise g controller UserController
hono-enterprise g service UserService

# Dry run
hono-enterprise g controller UserController --dry-run

# Custom schematics
hono-enterprise g custom my-schematic
```

### Generated Plugin Example

```bash
hono-enterprise g plugin my-plugin
```

Generates:

```typescript
// src/plugins/my-plugin.ts
import type { IPlugin } from '@hono-enterprise/common';

export interface MyPluginOptions {
  // Add your options here
}

export function MyPlugin(options: MyPluginOptions = {}): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    register(ctx) {
      // Register services
      // ctx.services.register('my-service', new MyService(options));

      // Register routes
      // ctx.router.get('/my-route', (ctx) => ctx.response.json({ ok: true }));

      // Register health checks
      // ctx.health.register('my-service', async () => ({ status: 'up' }));

      // Register lifecycle hooks
      ctx.lifecycle.onShutdown(() => {
        console.log('My plugin shutting down');
      });
    },
  };
}
```

---

## REST API Application

A complete REST API using the REST starter:

```typescript
import { createRestApp } from '@hono-enterprise/rest-starter';
import { z } from 'zod';

const app = await createRestApp({
  port: 3000,
  config: {
    validationSchema: z.object({
      PORT: z.coerce.number().default(3000),
      DATABASE_URL: z.string().url(),
      JWT_SECRET: z.string().min(32),
    }),
  },
  // Values resolve from the validated config above — never process.env (runtime independence)
  database: {
    type: 'prisma',
    urlFromConfig: 'DATABASE_URL',
  },
  auth: {
    jwt: { secretFromConfig: 'JWT_SECRET', expiresIn: '1h' },
  },
  openapi: {
    title: 'My API',
    version: '1.0.0',
  },
});

// Define schemas
const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
});

const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

// Routes
app.router.get('/users', {
  schema: {
    response: { 200: z.array(UserSchema) },
    tags: ['Users'],
    summary: 'List all users',
  },
  handler: async (ctx) => {
    const db = ctx.services.get('database');
    const users = await db.getRepository('User').findAll();
    return ctx.response.json(users);
  },
});

app.router.post('/users', {
  middleware: [app.services.auth.requireAuth()],
  schema: {
    body: CreateUserSchema,
    response: { 201: UserSchema, 400: z.object({ error: z.string() }) },
    tags: ['Users'],
    summary: 'Create a user',
    security: [{ bearerAuth: [] }],
  },
  handler: async (ctx) => {
    const db = ctx.services.get('database');
    const user = await db.getRepository('User').create(ctx.state.get('validatedBody'));
    return ctx.response.status(201).json(user);
  },
});

app.router.get('/users/:id', {
  schema: {
    params: z.object({ id: z.string().uuid() }),
    response: { 200: UserSchema, 404: z.object({ error: z.string() }) },
    tags: ['Users'],
    summary: 'Get a user by ID',
  },
  handler: async (ctx) => {
    const db = ctx.services.get('database');
    const user = await db.getRepository('User').findById(ctx.params.id);
    if (!user) return ctx.response.status(404).json({ error: 'Not found' });
    return ctx.response.json(user);
  },
});

await app.start();
console.log('API running at http://localhost:3000');
console.log('Docs at http://localhost:3000/docs');
```

---

## Microservice Application

A microservice with messaging, queue, and telemetry:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';

const app = await createMicroserviceApp({
  port: 3001,
  serviceName: 'order-service',
  // Values resolve from ConfigPlugin's validated environment — never process.env
  database: { type: 'prisma', urlFromConfig: 'DATABASE_URL' },
  messaging: {
    broker: 'rabbitmq',
    urlFromConfig: 'RABBITMQ_URL',
    exchange: 'orders',
  },
  queue: {
    adapter: 'redis',
    urlFromConfig: 'REDIS_URL',
  },
  telemetry: {
    serviceName: 'order-service',
    exporter: 'otlp',
    endpointFromConfig: 'OTLP_ENDPOINT',
  },
});

// Subscribe to events from other services
app.register({
  name: 'event-subscribers',
  version: '1.0.0',
  dependencies: ['messaging'],
  register(ctx) {
    const broker = ctx.services.get('messaging');

    broker.subscribe('user.created', async (message) => {
      console.log('New user created', message.userId);
      // Create a welcome order or similar
    });
  },
});

// Process background jobs
app.register({
  name: 'job-processors',
  version: '1.0.0',
  dependencies: ['queue'],
  register(ctx) {
    const queue = ctx.services.get('queue');

    queue.process('process-payment', async (job) => {
      await processPayment(job.data);
    }, { concurrency: 5 });
  },
});

// API endpoints
app.router.post('/orders', async (ctx) => {
  const db = ctx.services.get('database');
  const broker = ctx.services.get('messaging');
  const queue = ctx.services.get('queue');

  const order = await db.getRepository('Order').create(ctx.request.body);

  // Publish event
  await broker.publish('order.created', { orderId: order.id });

  // Queue background job
  await queue.add('process-payment', { orderId: order.id });

  return ctx.response.status(201).json(order);
});

await app.start();
```

---

## CQRS Application

A CQRS application with event sourcing:

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { LoggerPlugin } from '@hono-enterprise/logger-plugin';
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
import { DatabasePlugin } from '@hono-enterprise/database-plugin';
import { EventsPlugin } from '@hono-enterprise/events-plugin';
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    LoggerPlugin({ level: 'info' }),
    ConfigPlugin({ validationSchema: AppConfigSchema }),
    DatabasePlugin({ type: 'prisma' }), // reads DATABASE_URL via the config capability
    EventsPlugin(),
    CqrsPlugin({ behaviors: ['logging', 'validation', 'timing'] }),
    OpenApiPlugin({ title: 'CQRS API', version: '1.0.0' }),
  ],
});

// Register handlers
app.register({
  name: 'command-handlers',
  version: '1.0.0',
  dependencies: ['cqrs', 'database', 'events'],
  register(ctx) {
    const commandBus = ctx.services.get('command-bus');
    const db = ctx.services.get('database');
    const eventBus = ctx.services.get('events');

    commandBus.register('CreateUser', new CreateUserHandler(db, eventBus));
    commandBus.register('UpdateUser', new UpdateUserHandler(db, eventBus));
    commandBus.register('DeleteUser', new DeleteUserHandler(db, eventBus));
  },
});

app.register({
  name: 'query-handlers',
  version: '1.0.0',
  dependencies: ['cqrs', 'database'],
  register(ctx) {
    const queryBus = ctx.services.get('query-bus');
    const db = ctx.services.get('database');

    queryBus.register('GetUser', new GetUserHandler(db));
    queryBus.register('ListUsers', new ListUsersHandler(db));
    queryBus.register('SearchUsers', new SearchUsersHandler(db));
  },
});

// Routes use command/query buses
app.router.post('/users', async (ctx) => {
  const commandBus = ctx.services.get('command-bus');
  const userId = await commandBus.execute({
    type: 'CreateUser',
    data: ctx.request.body,
  });
  return ctx.response.status(201).json({ id: userId });
});

app.router.get('/users/:id', async (ctx) => {
  const queryBus = ctx.services.get('query-bus');
  const user = await queryBus.execute({
    type: 'GetUser',
    data: { id: ctx.params.id },
  });
  return ctx.response.json(user);
});

await app.start({ port: 3000 });
```

---

## Plugin Creation

### Basic Plugin

```typescript
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

export function RateLimitPlugin(options: RateLimitOptions): IPlugin {
  return {
    name: 'rate-limit',
    version: '1.0.0',
    dependencies: ['logger'],
    provides: ['rate-limit'],
    register(ctx: IPluginContext) {
      const logger = ctx.services.get('logger');

      // Register a service
      const rateLimiter = new RateLimiterService(options);
      ctx.services.register('rate-limit', rateLimiter);

      // Register middleware
      ctx.middleware.add((ctx, next) => {
        const ip = ctx.request.ip;
        if (!rateLimiter.check(ip)) {
          return ctx.response.status(429).json({
            error: 'Too Many Requests',
            message: options.message || 'Rate limit exceeded',
          });
        }
        return next();
      }, { priority: 100 });

      // Register health check
      ctx.health.register('rate-limit', async () => ({
        status: 'up',
        data: { requests: rateLimiter.getRequestCount() },
      }));

      // Register CLI command
      ctx.cli.register('rate-limit:stats', () => {
        console.log('Rate limit stats:', rateLimiter.getStats());
      });

      logger.info('Rate limit plugin registered', { windowMs: options.windowMs, max: options.max });
    },
  };
}
```

### Plugin with Configuration

```typescript
export function DatabasePlugin(options: DatabasePluginOptions): IPlugin {
  return {
    name: 'database',
    version: '1.0.0',
    dependencies: ['logger', 'config'],
    provides: ['database'],
    register(ctx) {
      const config = ctx.services.get('config');
      const logger = ctx.services.get('logger');

      // Validate environment
      ctx.environment.validate({
        DATABASE_URL: { required: true, type: 'string' },
      });

      // Use config or options
      const url = options.url ?? config.get('DATABASE_URL');
      const db = new DatabaseService({ ...options, url });

      ctx.services.register('database', db);

      // Health check
      ctx.health.register('database', async () => {
        const healthy = await db.isHealthy();
        return { status: healthy ? 'up' : 'down', data: { url } };
      });

      // Metrics
      ctx.metrics.register('db_query_duration_seconds', {
        type: 'histogram',
        help: 'Database query duration',
        labels: ['operation'],
        buckets: [0.01, 0.1, 0.5, 1, 5],
      });

      // Lifecycle
      ctx.lifecycle.onShutdown(async () => {
        logger.info('Closing database connection');
        await db.close();
      });
    },
  };
}
```

### Plugin with Decorators

```typescript
export function MyPlugin(options: MyPluginOptions): IPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    dependencies: ['decorator-plugin'],
    register(ctx) {
      // Register custom decorators
      ctx.decorators.register('MyRoute', (metadata, target, propertyKey) => {
        // Register route from decorator metadata
        ctx.router.get(metadata.path, target[propertyKey]);
      });

      // Register a service that works with decorators
      ctx.services.register('my-service', new MyService(options));
    },
  };
}
```

---

## Custom Middleware

### Programmatic Middleware

```typescript
// Define middleware as a function
function requestLogger(): MiddlewareFunction {
  return async (ctx, next) => {
    const logger = ctx.services.get<ILogger>('logger');
    const start = Date.now();

    logger.info('Request received', {
      method: ctx.request.method,
      path: ctx.request.path,
      requestId: ctx.request.id,
    });

    await next();

    const duration = Date.now() - start;
    logger.info('Response sent', {
      method: ctx.request.method,
      path: ctx.request.path,
      status: ctx.response.status,
      duration,
    });

    if (duration > 5000) {
      logger.warn('Slow request detected', { duration, path: ctx.request.path });
    }
  };
}

// Register globally
app.middleware.add(requestLogger(), { priority: 50 });

// Register for specific route
app.router.get('/users', {
  middleware: [requestLogger()],
  handler: async (ctx) => {/* ... */},
});
```

### Middleware with Options

```typescript
function rateLimit(options: { max: number; windowMs: number }): MiddlewareFunction {
  const requests = new Map<string, number[]>();

  return async (ctx, next) => {
    const ip = ctx.request.ip;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    const userRequests = (requests.get(ip) || []).filter((t) => t > windowStart);
    userRequests.push(now);
    requests.set(ip, userRequests);

    if (userRequests.length > options.max) {
      return ctx.response.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    }

    return next();
  };
}

app.middleware.add(rateLimit({ max: 100, windowMs: 60000 }));
```

### Middleware Class

```typescript
class AuthMiddleware implements IMiddleware {
  constructor(private authService: IAuthService) {}

  async handle(ctx: RequestContext, next: () => Promise<void>): Promise<void> {
    const token = ctx.request.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) {
      return ctx.response.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const user = await this.authService.verifyToken(token);
      ctx.request.user = user;
      return next();
    } catch {
      return ctx.response.status(401).json({ error: 'Invalid token' });
    }
  }
}

// Register
const auth = app.services.get<IAuthService>('authentication');
app.middleware.add(new AuthMiddleware(auth));
```

---

## Custom Decorators

> Decorators require the `DecoratorPlugin` to be registered.

### Using Built-in Decorators

```typescript
import { Body, Controller, Get, Params, Post } from '@hono-enterprise/decorator-plugin';
import { CurrentUser, UseGuards } from '@hono-enterprise/auth-plugin';

@Controller('/users')
class UserController {
  constructor(private userService: UserService) {}

  @Get('/')
  @ApiTags('Users')
  @ApiOperation('List all users')
  async list() {
    return this.userService.findAll();
  }

  @Get('/:id')
  async getById(@Params('id') id: string) {
    return this.userService.findById(id);
  }

  @Post('/')
  @UseGuards(requireAuth())
  async create(@Body() body: CreateUserDto, @CurrentUser() user: User) {
    return this.userService.create(body, user.id);
  }
}
```

### Defining Custom Decorators

```typescript
import { createDecorator } from '@hono-enterprise/decorator-plugin';

// Method decorator
export const Cacheable = (ttl: number) => createDecorator('cacheable', { ttl });

// Parameter decorator
export const CurrentTenant = () => createParameterDecorator('current-tenant');

// Usage
@Controller('/api')
class ApiController {
  @Get('/data')
  @Cacheable(3600)
  async getData(@CurrentTenant() tenant: Tenant) {
    return this.service.getDataForTenant(tenant.id);
  }
}
```

### How Decorators Work

Decorators store metadata in a plain object. The `DecoratorPlugin` reads this metadata and registers
routes, services, and middleware with the kernel. No reflection is required — the metadata store is
explicit.

```typescript
// This is what the decorator does internally:
// Stores metadata in a plain object
metadataStore.controllers.set(UserController, {
  path: '/users',
  routes: [
    { method: 'GET', path: '/', handler: 'list' /* ... */ },
    { method: 'POST', path: '/', handler: 'create' /* ... */ },
  ],
});

// DecoratorPlugin reads this and calls:
app.router.get('/users', userController.list.bind(userController));
app.router.post('/users', {
  middleware: [requireAuth()],
  handler: userController.create.bind(userController),
});
```

---

## Programmatic vs Decorator API

The framework provides both APIs for every feature. They are equivalent.

### Routing

**Programmatic:**

```typescript
app.router.post('/users', {
  middleware: [requireAuth(), validateBody(CreateUserSchema)],
  schema: { body: CreateUserSchema, response: { 201: UserSchema } },
  handler: async (ctx) => {
    const userService = ctx.services.get('userService');
    const user = await userService.create(ctx.state.get('validatedBody'));
    return ctx.response.status(201).json(user);
  },
});
```

**Decorator:**

```typescript
@Controller('/users')
class UserController {
  @Post('/')
  @UseGuards(requireAuth())
  @ValidateBody(CreateUserSchema)
  @ApiResponse(201, UserSchema)
  async create(@Body() body: CreateUserDto) {
    return this.userService.create(body);
  }
}
```

### Service Registration

**Programmatic:**

```typescript
app.register({
  name: 'services',
  version: '1.0.0',
  register(ctx) {
    ctx.services.register('userService', new UserService());
    ctx.services.register('orderService', new OrderService());
  },
});
```

**Decorator (requires DiPlugin):**

```typescript
@Injectable()
class UserService {/* ... */}

@Injectable()
class OrderService {/* ... */}

// DiPlugin auto-discovers @Injectable classes
```

### Event Handling

**Programmatic:**

```typescript
app.register({
  name: 'event-handlers',
  version: '1.0.0',
  dependencies: ['events'],
  register(ctx) {
    const eventBus = ctx.services.get('events');
    eventBus.subscribe('UserCreated', handleUserCreated);
  },
});
```

**Decorator:**

```typescript
@EventHandler('UserCreated')
class UserCreatedHandler {
  async handle(event: UserCreatedEvent) {/* ... */}
}
```

---

## Developer Ergonomics

### Type Safety

Everything is fully typed. No `any` in public APIs.

```typescript
// Config is typed
const port = config.get<number>('PORT'); // number
const url = config.getOrThrow<string>('DATABASE_URL'); // string

// Services are typed
const db = ctx.services.get<IDatabaseService>('database');
const user = await db.getRepository<User>('User').findById('123'); // User | null

// Routes are typed
app.router.get('/users/:id', {
  schema: {
    params: z.object({ id: z.string().uuid() }),
    response: { 200: UserSchema },
  },
  handler: async (ctx) => {
    const id = ctx.params.id; // string (validated as UUID)
    // ...
  },
});
```

### Error Messages

Standardized error responses across the framework:

```json
{
  "type": "https://hono-enterprise.dev/errors/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "User with id 123 not found",
  "instance": "/users/123"
}
```

### IDE Support

- Full TypeScript intellisense
- JSDoc on all public APIs
- Type inference for services, config, and routes
- Auto-completion for plugin options

### Hot Reload

```bash
# Development with hot reload
hono-enterprise dev

# Or with file watching
deno task dev  # runs `deno run --watch` under the hood
```

### Debugging

```typescript
// Enable debug logging
app.register(LoggerPlugin({ level: 'debug', pretty: true }));

// Debug specific plugin
app.register(LoggerPlugin({
  level: 'debug',
  filter: (level, msg, metadata) => {
    return metadata?.plugin === 'database';
  },
}));
```

### Testing

```typescript
import { createTestApp } from '@hono-enterprise/testing';

const app = await createTestApp({
  plugins: [
    RuntimePlugin(),
    LoggerPlugin({ transport: 'noop' }),
    DatabasePlugin({ type: 'memory' }),
  ],
});

// Inject requests without a server
const response = await app.inject({
  method: 'POST',
  url: '/users',
  body: { name: 'John', email: 'john@example.com' },
});

expect(response.statusCode).toBe(201);
expect(response.json().name).toBe('John');
```

### Mocking Plugins

```typescript
import { createMockPlugin, createTestApp } from '@hono-enterprise/testing';

const mockDb = createMockPlugin({
  name: 'database',
  service: {
    getRepository: () => ({
      findAll: async () => [{ id: '1', name: 'John' }],
      findById: async (id) => ({ id, name: 'John' }),
    }),
  },
});

const app = await createTestApp({
  plugins: [RuntimePlugin(), mockDb],
});
```

### Graceful Shutdown

```typescript
const app = createApplication({
  gracefulShutdown: true,
  shutdownTimeout: 10000,
});

// Framework handles SIGTERM and SIGINT automatically
// Calls onShutdown hooks for all plugins
// Waits for in-flight requests to complete
// Closes database connections, message brokers, etc.
```

### Composition Over Configuration

Start minimal and add plugins as needed:

```typescript
// Start with just kernel + runtime
const app = createApplication({
  plugins: [RuntimePlugin()],
});

// Add logging
app.register(LoggerPlugin());

// Add config
app.register(ConfigPlugin({ validationSchema: AppConfigSchema }));

// Add database
app.register(DatabasePlugin({ type: 'prisma' }));

// Add auth
app.register(AuthenticationPlugin({ jwt: { secret: config.get('JWT_SECRET') } }));

// Add OpenAPI docs
app.register(OpenApiPlugin({ title: 'My API', version: '1.0.0' }));

await app.start();
```

### Replace Any Plugin

```typescript
// Replace the default logger with a custom one
app.register({
  name: 'logger',
  version: '1.0.0',
  provides: ['logger'],
  register(ctx) {
    ctx.services.register('logger', new MyCustomLogger(), { override: true });
  },
});

// Replace the database with a mock
app.register({
  name: 'database',
  version: '1.0.0',
  provides: ['database'],
  register(ctx) {
    ctx.services.register('database', new MockDatabase(), { override: true });
  },
});
```

---

## API Reference: @hono-enterprise/common

The contract layer every other package builds on. Implemented in **Milestone 1**; this section is
the authoritative export list (AI_GUIDELINES §10.5). All exports carry full JSDoc.

### Values (runtime exports)

| Export                        | Kind     | Purpose                                                                                               |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                | const    | Standard capability tokens — the single source of truth                                               |
| `createCapabilityToken(name)` | function | Validates and creates a custom (optionally dot-namespaced) token; throws `TypeError` on invalid names |
| `PLUGIN_PRIORITY`             | const    | Well-known plugin priority bands (`HIGHEST`…`LOWEST`)                                                 |
| `ok(value)` / `err(error)`    | function | `Result` constructors                                                                                 |
| `isOk(r)` / `isErr(r)`        | function | `Result` type guards                                                                                  |
| `unwrap(r)`                   | function | Returns the `Ok` value or throws the `Err` error                                                      |
| `some(value)` / `none()`      | function | `Option` constructors (`none()` returns a frozen singleton)                                           |
| `isSome(o)` / `isNone(o)`     | function | `Option` type guards                                                                                  |
| `fromNullable(v)`             | function | Converts `T \| null \| undefined` to `Option<T>`                                                      |

### Types

| Group               | Exports                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens              | `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                  |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PluginPriority`                                                                                                                            |
| Utilities           | `Result<T, E>`, `Ok<T>`, `Err<E>`, `Option<T>`, `Some<T>`, `None`                                                                                                                                                                        |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, `StartOptions`                                                                                                                                                                              |
| Plugin context APIs | `IMiddlewareApi`, `MiddlewareOptions`, `IRouterApi`, `IEnvironmentApi`, `EnvVarSpec`, `IHealthApi`, `IMetricsApi`, `IOpenApiApi`, `IDecoratorApi`, `DecoratorHandler`, `ICliApi`, `CliCommandHandler`, `ILifecycleApi`, `IMetadataStore` |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory<T>`                                                                                                                                                                               |
| HTTP                | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `NextFunction`, `RouteHandler`, `RouteDefinition`, `RouteSchema`, `HandlerResult`                                                                       |
| Runtime             | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`, `TimerHandle`, `ServerHandle`, `StatResult`                                                                                                                                           |
| DI (optional)       | `IContainer`, `Constructor<T>`, `ServiceScope`, `Provider<T>`, `ClassProvider<T>`, `FactoryProvider<T>`, `ValueProvider<T>`, `ProviderOptions`                                                                                           |
| Logging             | `ILogger`, `LogMetadata`                                                                                                                                                                                                                 |
| Config              | `IConfig`                                                                                                                                                                                                                                |
| Validation          | `IValidationService`, `ValidationTarget`, `ValidationIssue`                                                                                                                                                                              |
| Health              | `IHealthIndicator`, `HealthIndicatorFn`, `HealthCheckResult`                                                                                                                                                                             |
| Metrics             | `IMetric`, `MetricConfig`                                                                                                                                                                                                                |
| Auth                | `IPrincipal`, `IJwtService`, `JwtSignOptions`                                                                                                                                                                                            |
| Database            | `IOrmAdapter`, `ITransaction`                                                                                                                                                                                                            |
| Cache               | `ICacheStore`                                                                                                                                                                                                                            |
| Events              | `IEventBus`, `IDomainEvent<T>`, `EventHandler<T>`, `Unsubscribe`                                                                                                                                                                         |
| Messaging           | `IMessageBroker`, `ISubscription`, `MessageHandler<T>`, `MessageMetadata`, `SubscribeOptions`                                                                                                                                            |
| Queue               | `IQueue`, `IJob<T>`, `JobProcessor<T>`, `AddJobOptions`, `ProcessOptions`, `RecurringOptions`                                                                                                                                            |
| Secrets             | `ISecretManager`                                                                                                                                                                                                                         |
| Audit               | `IAuditLogger`, `AuditEntry`                                                                                                                                                                                                             |
| Resilience          | `ICircuitBreaker`, `CircuitState`                                                                                                                                                                                                        |
| Storage             | `IStorage`, `SignedUrlOptions`                                                                                                                                                                                                           |
| Mail                | `IMailer`, `MailMessage`                                                                                                                                                                                                                 |
| Notifications       | `INotifier`, `NotificationMessage`                                                                                                                                                                                                       |
| Feature flags       | `IFeatureFlags`, `FlagContext`                                                                                                                                                                                                           |
| Multi-tenancy       | `ITenantResolver`, `ITenant`                                                                                                                                                                                                             |

Contract notes:

- `IPluginContext.runtime` is **non-optional**: a runtime provider is mandatory and registers first,
  so every plugin may rely on it (ARCHITECTURE.md §7).
- Schema positions (`RouteSchema`, `IValidationService`, `IOpenApiApi`) are typed `unknown` so
  `common` carries no validator dependency; the validation plugin narrows them (Zod by default).
- `HandlerResult` is an opaque brand only the kernel constructs; handlers obtain it from `IResponse`
  terminal methods (`json`, `text`, `send`, `redirect`).
- **Contribution-token pattern**: `HTTP_ADAPTER` and the five contribution tokens
  (`HEALTH_INDICATOR`, `METRIC_REGISTRATION`, `OPENAPI_SCHEMA`, `CLI_COMMAND`, `DECORATOR_HANDLER`)
  are multi-provider capabilities. The kernel collects plugin contributions registered under these
  tokens via `services.getAll()`; the corresponding first-party plugins aggregate and expose them.
  `HTTP_ADAPTER` is single-provider — the runtime plugin registers its `IHttpAdapter` there.
- `METADATA_STORE` (`'metadata-store'`) is the single-provider capability backing
  `IPluginContext.metadata`; the DecoratorPlugin registers its `IMetadataStore` there. It is
  distinct from `OPENAPI` so an OpenAPI plugin registering under `OPENAPI` does not populate
  `ctx.metadata`.

---

## API Reference: @hono-enterprise/kernel

The plugin kernel: resolves plugin dependencies, builds the middleware pipeline and router,
validates environment variables, and dispatches requests. Implemented in **Milestone 2**; this
section is the authoritative export list (AI_GUIDELINES §10.5). All exports carry full JSDoc.

### Values (runtime exports)

| Export              | Kind     | Purpose                                                           |
| ------------------- | -------- | ----------------------------------------------------------------- |
| `createApplication` | function | Creates a kernel application with optional pre-registered plugins |

### Types

| Export               | Kind | Purpose                                                                            |
| -------------------- | ---- | ---------------------------------------------------------------------------------- |
| `ApplicationOptions` | type | Options for `createApplication` (`{ plugins?: IPlugin[] }`)                        |
| `IKernelApplication` | type | `IApplication` extended with `inject()` for serverless request injection           |
| `InjectRequest`      | type | Synthetic request shape for `inject()` (`{ method, url, headers?, body? }`)        |
| `InjectResponse`     | type | Response shape returned by `inject()` (`{ statusCode, headers, body, json<T>() }`) |

Contract notes:

- **Listening requires** `CAPABILITIES.HTTP_ADAPTER` (registered by the runtime plugin) **and** a
  `port` option. Without either, `start()` skips server creation — `inject()` and tests need no
  server.
- The kernel emits only **bare 404/500 JSON** (`{ error: 'Not Found' }` /
  `{ error: 'Internal Server Error' }`). Error formatting belongs to the exceptions package, not the
  kernel.
- **Contribution-token pattern**: `ctx.health.register()`, `ctx.metrics.register()`,
  `ctx.openapi.addSchema()`, `ctx.cli.register()`, and `ctx.decorators.register()` funnel
  contributions into multi-provider services under the Step-1 tokens; consumers retrieve them with
  `services.getAll()`.
- `ctx.runtime` is a lazy getter that resolves `CAPABILITIES.RUNTIME` on access, so the runtime
  plugin itself does not trip over it during its own registration.
- Route middleware uses the same `next()`-chaining semantics as the global pipeline: a stage that
  responds without calling `next()` short-circuits, and the handler does not run. As
  defense-in-depth, a stage that responds AND calls `next()` still does not let downstream stages
  overwrite the response (the chain stops once the response is ended).

---

## API Reference: @hono-enterprise/runtime

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, and Bun.

> **M3 provides runtime services only; HTTP server adapters are deferred to a dedicated milestone.**

### Values (runtime exports)

| Export                            | Kind     | Purpose                                                                                    |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `RuntimePlugin`                   | function | Creates the runtime plugin (registers `CAPABILITIES.RUNTIME`)                              |
| `detectRuntime`                   | function | Detects the current runtime platform (`'node' \| 'deno' \| 'bun' \| 'cloudflare-workers'`) |
| `createDenoRuntimeServices`       | function | Creates `IRuntimeServices` backed by Deno APIs                                             |
| `createNodeRuntimeServices`       | function | Creates `IRuntimeServices` backed by Node.js APIs                                          |
| `createBunRuntimeServices`        | function | Creates `IRuntimeServices` backed by Bun APIs                                              |
| `createCloudflareRuntimeServices` | function | Stub — throws (Cloudflare Workers not yet implemented)                                     |

### Types

| Export           | Kind | Purpose                                                        |
| ---------------- | ---- | -------------------------------------------------------------- |
| `RuntimeOptions` | type | Options for `RuntimePlugin` (`{ platform?: RuntimePlatform }`) |
| `GlobalScope`    | type | Injectable global scope shape for `detectRuntime`              |
| `DenoHost`       | type | Host interface for the Deno adapter (extension point)          |
| `DenoFileInfo`   | type | File info returned by `DenoHost.stat()`                        |
| `DenoDirEntry`   | type | Directory entry returned by `DenoHost.readdir()`               |
| `NodeHost`       | type | Host interface for the Node adapter (extension point)          |
| `NodeFsInfo`     | type | File info returned by `NodeHost.stat()`                        |
| `BunHost`        | type | Host interface for the Bun adapter (extension point)           |
| `BunFileInfo`    | type | File info returned by `BunHost.stat()`                         |

Contract notes:

- **M3 provides runtime services only; HTTP server adapters are deferred to a dedicated milestone.**
  The `IHttpAdapter` contract hands the adapter a `Promise<IResponse>`, but `IResponse` is
  write-only (no read/snapshot surface), so an adapter cannot serialize the response without
  reaching into kernel internals. That seam needs its own design pass against the kernel.
- The `RuntimePlugin` is **mandatory** in every application. It registers at
  `PLUGIN_PRIORITY.HIGHEST` so its services are available to all other plugins during registration.
- Each adapter factory accepts an injectable `*Host` interface (the documented extension point for
  custom runtimes). The default host binds to the real runtime global via a single sanctioned `as`
  cast; no other casts are used.
- `detectRuntime()` accepts an injectable `globals` parameter (default `globalThis`) so all
  detection branches are testable without real runtimes.

---

## Summary

The Hono Enterprise public API is designed for developer experience:

1. **Start minimal** — Just kernel + runtime, add plugins as needed
2. **Everything is replaceable** — Any plugin can be swapped via capability tokens
3. **Full programmatic API** — No feature requires decorators or reflection
4. **Optional decorators** — Available for those who prefer NestJS-style DX
5. **Type-safe** — Full TypeScript support with no `any` in public APIs
6. **Runtime independent** — Runs on Node.js, Deno, Bun, and Cloudflare Workers (future)
7. **Testable** — Built-in test utilities, mock plugins, request injection
8. **Enterprise-ready** — Auth, secrets, audit, resilience, multi-tenancy, feature flags
