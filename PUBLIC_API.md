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
9. [AuthPlugin()](#authplugin)
10. [CachePlugin()](#cacheplugin)
11. [HttpSecurityPlugin()](#httpsecurityplugin)
12. [EventsPlugin()](#eventsplugin)
13. [CQRS](#cqrs)
14. [Messaging](#messaging)
15. [Queue](#queue)
16. [Scheduler](#scheduler)
17. [HttpClient](#httpclient)
18. [Storage](#storage)
19. [Mail](#mail)
20. [Notifications](#notifications)
21. [Feature Flags](#feature-flags)
22. [Health](#health)
23. [Metrics](#metrics)
24. [Telemetry](#telemetry)
25. [OpenAPI](#openapi)
26. [CLI](#cli)
27. [REST API Application](#rest-api-application)
28. [Microservice Application](#microservice-application)
29. [CQRS Application](#cqrs-application)
30. [Plugin Creation](#plugin-creation)
31. [Custom Middleware](#custom-middleware)
32. [Custom Decorators](#custom-decorators)
33. [Service Discovery](#service-discovery)
34. [Programmatic vs Decorator API](#programmatic-vs-decorator-api)
35. [Developer Ergonomics](#developer-ergonomics)
36. [API Reference: @hono-enterprise/common](#api-reference-hono-enterprisecommon)
37. [API Reference: @hono-enterprise/kernel](#api-reference-hono-enterprisekernel)
38. [API Reference: @hono-enterprise/runtime](#api-reference-hono-enterpriseruntime)
39. [API Reference: @hono-enterprise/graphql-plugin](#api-reference-hono-enterprisegraphql-plugin)
40. [SDK — Client SDK (@hono-enterprise/sdk)](#sdk--client-sdkhono-enterprisesdk)

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

## Full Stack Application

A full-featured service with caching, events, scheduling, and more:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';

const app = createFullStackApp({
  cache: { store: 'memory' },
  events: {},
  audit: { storage: 'memory' },
  secrets: { provider: 'env' },
  storage: { provider: 'memory' },
  mail: { provider: 'log' },
});

app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));

await app.start({ port: 3002 });
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

await app.start();

const response = await app.inject({ method: 'GET', url: '/users' });
console.log(response.statusCode); // 200
console.log(response.json()); // [{ id: 1 }]
```

For testing, prefer `createTestApp()` — it calls `start()` automatically (without binding a socket),
so you can call `inject()` or `fetch()` directly. See
[Testing Package](#testing-package-hono-enterprisetesting) for the full API.

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
  subtle: SubtleCrypto;

  now(): number;
  hrtime(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;

  env: Record<string, string | undefined>;
  exit(code?: number): never;

  fs?: IFileSystem;
  workers?: IWorkerHost;
  dns?: IDnsResolver;
}
```

`IFileSystem` provides `readFile`/`writeFile`/`stat`/`readdir`/`mkdir`/`rm`, plus an **optional**
`realPath(path): Promise<string>` that canonicalizes a path following symlinks. `realPath` is
implemented by the Node/Deno/Bun runtime adapters and absent on runtimes that cannot canonicalize;
callers must degrade gracefully when it is not present (e.g. the React Router plugin's static-asset
handler uses it for symlink-safe containment when available, falling back to lexical containment).

`workers` is an **optional** `IWorkerHost` for spawning worker threads. It is implemented by the
Node/Deno/Bun runtime adapters and **absent on Cloudflare Workers** (no threads on the edge).
Callers must degrade gracefully when it is not present — the `WorkerPoolPlugin` fails `run()` with a
typed `WorkerPoolUnavailableError` rather than throwing at startup.

```typescript
interface IWorkerHost {
  spawn(specifier: string): IWorkerHandle;
  availableParallelism(): number;
}

interface IWorkerHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  terminate(): Promise<void>;
}
```

`dns` is an **optional** `IDnsResolver` for name resolution. It is implemented by the Node, Deno,
and Bun runtime adapters and **absent on Cloudflare Workers**, whose network access is `fetch` —
that resolves names internally and exposes no lookup surface. Callers must degrade gracefully when
it is not present; the `ServiceDiscoveryPlugin`'s `'dns'` provider throws a typed
`DiscoveryUnavailableError` during `register()`, naming the alternatives.

| Member    | Node | Deno | Bun | Workers |
| --------- | ---- | ---- | --- | ------- |
| `fs`      | ✅   | ✅   | ✅  | ❌      |
| `workers` | ✅   | ✅   | ✅  | ❌      |
| `dns`     | ✅   | ✅   | ✅  | ❌      |

```typescript
interface IDnsResolver {
  resolveSrv(hostname: string): Promise<readonly SrvRecord[]>;
  resolveHost(hostname: string): Promise<readonly string[]>;
}

interface SrvRecord {
  readonly host: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}
```

`SrvRecord.host` is deliberately named that rather than reusing a runtime's own spelling: Deno calls
the field `target` and Node calls it `name`, and passing either through unchanged would type-check
on both runtimes while producing `undefined` hostnames on one. `resolveHost` concatenates `A` and
`AAAA` results and rejects only when **both** families fail, because an IPv4-only host has no `AAAA`
record at all. The runtime package exports both resolver factories: `createNodeDnsResolver(dns?)`
(shared by the Node and Bun adapters, over `node:dns/promises`) and `createDenoDnsResolver(host)`
(over `Deno.resolveDns`).

The runtime package also exports the worker host factories `createWebWorkerHost(globals?)`
(Deno/Bun, over the web `Worker` API) and `createNodeWorkerHost(mods?)` (Node, over
`node:worker_threads`), each behind an injectable seam, plus a `@hono-enterprise/runtime/worker`
subpath whose sole export is `defineWorkerTask` (see the WorkerPoolPlugin section).

---

## LoggerPlugin()

Provides structured logging via a capability token. The plugin depends on `RuntimePlugin` and
registers its `ILogger` under `CAPABILITIES.LOGGER` at `PLUGIN_PRIORITY.HIGH` (100) so logging is
available before most other plugins register.

### Registration

```typescript
import { LoggerPlugin } from '@hono-enterprise/logger-plugin';

app.register(LoggerPlugin({
  level: 'info', // minimum level to emit (default 'info')
  transport: 'console', // 'console' | 'pino' | 'noop' (default 'console')
  pretty: false, // pretty-print console output
  redact: ['password', 'token', 'authorization'], // dot-paths to redact
  requestLogging: true, // register request/response middleware
  slowRequestThreshold: 5000, // ms — warn when slower (default 5000)
  excludePaths: ['/health'], // paths excluded from request logging
}));
```

### Transports

| Transport   | Description                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `'console'` | Runtime-independent JSON lines (or pretty text) via `console`. Default.                        |
| `'pino'`    | Pino-backed, loaded via `await import('npm:pino')` or injected factory. `register()` is async. |
| `'noop'`    | Discards all output. For tests or disabling logging.                                           |

### Usage in Routes

```typescript
import { CAPABILITIES, ILogger } from '@hono-enterprise/common';

app.router.get('/users/:id', async (ctx) => {
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);

  logger.info('Fetching user', { userId: ctx.params.id });

  const user = await getUser(ctx.params.id);

  logger.debug('User fetched', { userId: user.id });

  return ctx.response.json(user);
});
```

### Child Loggers

```typescript
app.middleware.add(async (ctx, next) => {
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  const requestLogger = logger.child({
    requestId: ctx.id,
    correlationId: ctx.request.headers.get('x-correlation-id') ?? undefined,
  });

  ctx.services.register(CAPABILITIES.LOGGER, requestLogger, { override: true });
  await next();
});
```

### Logger Interface

```typescript
interface ILogger {
  readonly level: LogLevel;
  fatal(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  debug(message: string, metadata?: LogMetadata): void;
  trace(message: string, metadata?: LogMetadata): void;
  child(bindings: LogMetadata): ILogger;
}

type LogMetadata = Readonly<Record<string, unknown>>;
type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
```

### Standalone Logger Implementations

The logger implementations can be used directly without the plugin, e.g. in tests or scripts:

```typescript
import { ConsoleLogger, NoopLogger, PinoLogger } from '@hono-enterprise/logger-plugin';

const consoleLogger = new ConsoleLogger(runtime, { level: 'debug', pretty: true });
const noopLogger = new NoopLogger();
// PinoLogger uses async construction (import('npm:pino') is async):
const pinoLogger = await PinoLogger.create({ level: 'info', redact: ['password'] });
```

### Request Logging Middleware

```typescript
import { createRequestLoggerMiddleware } from '@hono-enterprise/logger-plugin';

app.middleware.add(createRequestLoggerMiddleware({
  slowRequestThreshold: 1000,
  excludePaths: ['/health'],
}));
```

The middleware resolves `CAPABILITIES.LOGGER` on each request, creates a child logger bound to
`requestId`, and logs:

- Incoming request (method, path)
- Outgoing response (status, duration in ms)
- Slow request warning when duration exceeds `slowRequestThreshold`
- Unhandled errors with stack traces

---

## ConfigPlugin()

Provides strongly-typed configuration with environment validation and `.env` file loading.
Configuration is an immutable application-startup snapshot — values are loaded once at startup and
never mutated. Hot reload is deferred (the runtime contract has no file-watching abstraction).

### Registration

```typescript
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';
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
  expandVariables: true,
}));
```

### Usage

```typescript
app.router.get('/config', (ctx) => {
  const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);

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
  get<T>(key: string): T | undefined;
  get<T>(key: string, options: { readonly default: T }): T;
  getOrThrow<T>(key: string): T;
  has(key: string): boolean;
}
```

### ConfigPluginOptions

```typescript
interface ConfigPluginOptions {
  readonly envFilePath?: string | readonly string[];
  readonly validationSchema?: StructuralSchema<unknown>;
  readonly expandVariables?: boolean;
  readonly instance?: IConfig;
}
```

- **`envFilePath`** — Path or paths to `.env` files. Defaults to no file loading. When supplied, the
  runtime must provide `fs` (absent on edge platforms).
- **`validationSchema`** — A Zod-compatible schema for startup validation. The schema's `parse()` is
  called once after merging and expansion; the parsed output is stored as the configuration
  snapshot, preserving Zod coercions and defaults.
- **`expandVariables`** — When `true` (default), expand `${NAME}` references in values using the
  final merged configuration.
- **`instance`** — An already-loaded snapshot to register verbatim. Present → **nothing is read**
  from the environment or from disk and the three options above are ignored; absent → configuration
  loads normally. This exists so an application can resolve configuration before its plugins are
  constructed and then hand the plugin that same object, rather than letting it load a second
  snapshot a moment later that the composition never saw.

### loadConfig()

```typescript
import { loadConfig } from '@hono-enterprise/config-plugin';
import { createRuntimeServices } from '@hono-enterprise/runtime';

const config = await loadConfig(createRuntimeServices(), {
  envFilePath: ['.env.local', '.env'],
});
const port = config.get<number>('PORT', { default: 3000 });
```

`(runtime: IRuntimeServices, options?: ConfigPluginOptions) => Promise<IConfig>` — the same
implementation `ConfigPlugin.register` uses, reachable without an application. Use it when
configuration must be read before any plugin exists (choosing which plugins to register, for
instance); inside an application, resolve `CAPABILITIES.CONFIG` from the registry instead.

Merging, expansion, and validation behave identically on both paths because there is only one: the
plugin delegates to this function and registers what it returns. Pass the result back as
`ConfigPlugin({ instance: config })` so the application holds exactly one snapshot —
`createFullStackAppFromConfig` does precisely that.

### StructuralSchema\<T\>

```typescript
interface StructuralSchema<T> {
  parse(input: unknown): T;
}
```

Minimal schema interface compatible with Zod's `parse(unknown)` API. Consumers supply a Zod schema
without `config-plugin` depending on Zod.

### Configuration Precedence

Values are merged in the following order (highest precedence first):

1. **Environment variables** (`runtime.env`)
2. **Earlier file paths** (`.env.local` overrides `.env`)
3. **Later file paths**

`undefined` entries in `runtime.env` are filtered out.

Variable references are expanded only after all sources have been merged, so file values may
reference `runtime.env`, runtime values may reference files, and references may cross file
boundaries. Cycles or missing references fail startup unless expansion is disabled.

### Dotenv Parsing

Configured files use strict parsing. Blank lines, comments, optional `export` prefixes, quoted and
unquoted values, common double-quoted escapes, empty values, and inline comments are supported.
Malformed entries, invalid keys, and unterminated quotes fail startup with a line number but do not
include rejected values in the error message.

Schema validation failures use a stable, value-free error message so validator diagnostics cannot
leak configuration secrets.

### Edge Runtimes

On edge platforms where `runtime.fs` is `undefined`, `envFilePath` must not be set. Attempting to do
so throws a clear startup error.

### Hot Reload

**Deferred.** Configuration is an immutable application-startup snapshot.

---

## ValidationPlugin()

Provides schema-based request validation with standardized error responses. Schemas are duck-typed
via a structural `safeParse()` interface — no hard Zod dependency in the plugin itself.

### Registration

```typescript
import { ValidationPlugin } from '@hono-enterprise/validation-plugin';

app.register(ValidationPlugin({
  errorFormat: 'rfc7807', // 'default' | 'rfc7807' | 'nestjs' | custom function
}));
```

### ValidationPluginOptions

```typescript
interface ValidationPluginOptions {
  /** Error response format. Defaults to 'default'. */
  readonly errorFormat?: ErrorFormat | ValidationErrorFormatter;

  /**
   * Strip properties the schema does not declare. Applied once per middleware
   * at registration time via the schema's own `.strip()` (Zod-style). A schema
   * without `.strip()` is used unchanged.
   */
  readonly whitelist?: boolean;

  /**
   * Reject payloads carrying properties the schema does not declare. Applied
   * once per middleware at registration time via the schema's own `.strict()`
   * (Zod-style), and takes precedence over `whitelist` when both are set. A
   * schema without `.strict()` is used unchanged.
   */
  readonly forbidNonWhitelisted?: boolean;
}
```

### Programmatic Validation

```typescript
import { z } from 'zod';
import { CAPABILITIES, IValidationService } from '@hono-enterprise/common';

const CreateUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  age: z.number().int().min(18).max(120),
  role: z.enum(['admin', 'user', 'guest']).default('user'),
});

app.router.post('/users', {
  middleware: [
    async (ctx, next) => {
      const validation = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
      const body = await ctx.request.json();
      const result = validation.validate(CreateUserSchema, body);

      if (!result.success) {
        return ctx.response.status(400).json({ errors: result.error });
      }

      ctx.state.set('validatedBody', result.value);
      await next();
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

The helpers resolve `IValidationService` from the request context automatically. Validated values
are stored in `ctx.state` under `validated:<target>` keys.

```typescript
import { z } from 'zod';
import {
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from '@hono-enterprise/validation-plugin';

app.router.get('/users', {
  middleware: [validateQuery(ListUsersQuerySchema)],
  handler: async (ctx) => {
    const query = ctx.state.get<z.infer<typeof ListUsersQuerySchema>>('validatedQuery');
    // query is validated
  },
});

app.router.put('/users/:id', {
  middleware: [
    validateParams(z.object({ id: z.string().uuid() })),
    validateBody(UpdateUserSchema),
  ],
  handler: async (ctx) => {
    const params = ctx.state.get('validatedParams');
    const body = ctx.state.get('validatedBody');
    // both are validated
  },
});
```

### Using the Service's middleware() Method

The `IValidationService.middleware()` method builds middleware with the formatter chosen at plugin
construction time:

```typescript
import { CAPABILITIES, IValidationService } from '@hono-enterprise/common';

app.router.post('/users', (ctx, next) => {
  const validation = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
  return validation.middleware(CreateUserSchema, 'body')(ctx, next);
});
```

### Sanitization

Sanitization is a standalone export (not a method on `IValidationService`):

```typescript
import { SanitizationRules, sanitize } from '@hono-enterprise/validation-plugin';

const rules: SanitizationRules = {
  htmlEncode: true,
  stripTags: true,
  maxLength: 1000,
  trim: true,
};

const clean = sanitize(userInput, rules);
```

You can also create a reusable sanitizer function:

```typescript
import { createSanitizer } from '@hono-enterprise/validation-plugin';

const sanitizer = createSanitizer({ htmlEncode: true, maxLength: 500 });
const clean1 = sanitizer(inputA);
const clean2 = sanitizer(inputB);
```

### Error Response Formats

#### Default format

```json
{
  "message": "Validation failed with 2 issue(s).",
  "errors": [
    { "field": "email", "message": "Invalid email address", "code": "invalid_string" }
  ]
}
```

#### RFC 7807 Problem Details

```json
{
  "type": "https://hono-enterprise.dev/errors/validation",
  "title": "Validation Error",
  "status": 400,
  "detail": "The request contains 1 validation error(s).",
  "instance": "/users",
  "errors": [
    { "field": "email", "message": "Invalid email address", "code": "invalid_string" }
  ]
}
```

#### NestJS format

```json
{
  "statusCode": 400,
  "message": ["email: Invalid email address"],
  "error": "Bad Request",
  "errors": [
    { "field": "email", "message": "Invalid email address", "code": "invalid_string" }
  ]
}
```

### Custom Error Formatter

```typescript
import { ValidationPlugin } from '@hono-enterprise/validation-plugin';

app.register(ValidationPlugin({
  errorFormat: (issues) => ({
    ok: false,
    fields: issues.map((i) => ({ name: i.path, reason: i.message })),
  }),
}));
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
  const body = await ctx.request.json<{ name: string; email: string }>();

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
  const primaryDb = ctx.services.get<IDatabaseService>('database.primary');
  const analyticsDb = ctx.services.get<IDatabaseService>('database.analytics');
  // ...
});
```

---

## AuthPlugin()

Provides JWT and API-key authentication, local credential verification, RBAC authorization with role
hierarchy, and short-circuiting route guards. All cryptography (HS256/RS256 JWT, PBKDF2-SHA256
password hashing) runs through Web Crypto via `IRuntimeServices`, so the package has **zero npm
dependencies**.

Registers three services under existing capability tokens:

- `IJwtService` under `CAPABILITIES.JWT` (`'jwt'`) — sign/verify/decode JWTs.
- `IAuthService` under `CAPABILITIES.AUTH` (`'authentication'`) — passive strategy chain + login.
- `IAuthorizationService` under `CAPABILITIES.AUTHORIZATION` (`'authorization'`) — RBAC checks.

> **Phasing (M16b, shipped):** **refresh tokens** and **rate limiting** shipped in M16b as
> standalone additions — `RefreshTokenService` (app-instantiated; NOT an `IAuthStrategy`, since a
> refresh token arrives in the request body, not as a passive header credential) and
> `rateLimitMiddleware` (a decoupled middleware factory with no capability token). Neither is an
> `AuthPlugin` option: the plugin's option shape, `provides`, and registration are unchanged from
> M16. `IJwtService` still exposes only `sign`/`verify`/`decode` — a refresh token is a signed JWT
> carrying `type: 'refresh'` and a `jti`.

### Exports

| Export                    | File                                      | Description                                                           |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `AuthPlugin`              | `src/plugin/auth-plugin.ts`               | Plugin factory                                                        |
| `AuthPluginOptions`       | `src/interfaces/index.ts`                 | Plugin factory options (`jwt` / `apiKey` / `local` / `rbac`)          |
| `JwtOptions`              | `src/interfaces/index.ts`                 | JWT config (key material, algorithm, expected aud/iss, header/scheme) |
| `ApiKeyOptions`           | `src/interfaces/index.ts`                 | API-key strategy config (header + `validate` callback)                |
| `LocalOptions`            | `src/interfaces/index.ts`                 | Local credential config (`verify` callback)                           |
| `PasswordHasher`          | `src/services/password-hasher.ts`         | PBKDF2-SHA256 hash/verify utility                                     |
| `authMiddleware`          | `src/middleware/auth-middleware.ts`       | Global middleware: authenticates and populates `ctx.request.user`     |
| `requireAuth`             | `src/guards/index.ts`                     | Guard: require an authenticated principal (401)                       |
| `requireRole`             | `src/guards/index.ts`                     | Guard: require a role (401/403)                                       |
| `requirePermission`       | `src/guards/index.ts`                     | Guard: require a permission (401/403)                                 |
| `requireAnyRole`          | `src/guards/index.ts`                     | Guard: require any of the given roles                                 |
| `requireAllPermissions`   | `src/guards/index.ts`                     | Guard: require all of the given permissions                           |
| `publicRoute`             | `src/guards/index.ts`                     | Guard: explicitly allow unauthenticated access                        |
| `RefreshTokenService`     | `src/services/refresh-token-service.ts`   | Refresh tokens: `issue` / `refresh` (rotation) / `revoke`             |
| `RefreshTokenOptions`     | `src/services/refresh-token-service.ts`   | `RefreshTokenService` constructor options                             |
| `TokenPair`               | `src/services/refresh-token-service.ts`   | `{ accessToken, refreshToken }` returned by `issue`/`refresh`         |
| `RefreshTokenStore`       | `src/stores/refresh-token-store.ts`       | Pluggable async store interface for refresh-token records             |
| `RefreshTokenRecord`      | `src/stores/refresh-token-store.ts`       | Record shape store implementations produce/consume                    |
| `MemoryRefreshTokenStore` | `src/stores/refresh-token-store.ts`       | Default in-memory store with lazy expiry                              |
| `rateLimitMiddleware`     | `src/middleware/rate-limit-middleware.ts` | Fixed-window rate limiter middleware factory (429 short-circuit)      |
| `RateLimitOptions`        | `src/middleware/rate-limit-middleware.ts` | `rateLimitMiddleware(options)` parameter                              |
| `RateLimitStore`          | `src/stores/rate-limit-store.ts`          | Pluggable store interface (`increment`/`reset`)                       |
| `RateLimitResult`         | `src/stores/rate-limit-store.ts`          | `{ count, resetTime }` returned by `increment`                        |
| `MemoryRateLimitStore`    | `src/stores/rate-limit-store.ts`          | Default in-memory fixed-window store                                  |
| `RedisRateLimitStore`     | `src/stores/redis-rate-limit-store.ts`    | Redis-backed store (inject-or-lazy `npm:ioredis@5.x`)                 |
| `IAuthService`            | re-export                                 | From `@hono-enterprise/common`                                        |
| `IJwtService`             | re-export                                 | From `@hono-enterprise/common`                                        |
| `IAuthorizationService`   | re-export                                 | From `@hono-enterprise/common`                                        |
| `IAuthStrategy`           | re-export                                 | From `@hono-enterprise/common`                                        |
| `IPrincipal`              | re-export                                 | From `@hono-enterprise/common`                                        |
| `JwtSignOptions`          | re-export                                 | From `@hono-enterprise/common`                                        |
| `RbacConfig`              | re-export                                 | From `@hono-enterprise/common`                                        |
| `RoleDefinition`          | re-export                                 | From `@hono-enterprise/common`                                        |

### Registration

```typescript
import { authMiddleware, AuthPlugin } from '@hono-enterprise/auth-plugin';

app.register(AuthPlugin({
  jwt: {
    secret: config.get('JWT_SECRET'), // HS256; use privateKey/publicKey PEMs for RS256
    audience: 'my-app-users', // expected `aud`, enforced on verify
    issuer: 'my-app', // expected `iss`, enforced on verify
  },
  apiKey: {
    header: 'X-API-Key',
    validate: (key) => apiKeyService.validate(key), // (key) => Promise<IPrincipal | null>
  },
  local: {
    // (identifier, secret) => Promise<IPrincipal | null>
    verify: (identifier, secret) => userService.checkPassword(identifier, secret),
  },
  rbac: {
    roles: {
      admin: { permissions: ['*'], inherits: ['manager'] },
      manager: { permissions: ['users:read', 'users:write'], inherits: ['user'] },
      user: { permissions: ['profile:read', 'profile:write'] },
    },
  },
}));

// Global middleware: authenticates every request and sets ctx.request.user.
app.middleware.add(authMiddleware());
```

### Login (Issue Token)

`IAuthService.verifyCredentials({ identifier, secret })` resolves to an `IPrincipal | null`; mint a
JWT with the separate `IJwtService` resolved from `'jwt'` (or issue an access + refresh pair with
`RefreshTokenService` — see Refresh Tokens below).

```typescript
import type { IAuthService, IJwtService } from '@hono-enterprise/common';

app.router.post('/auth/login', async (ctx) => {
  const auth = ctx.services.get<IAuthService>('authentication');
  const jwt = ctx.services.get<IJwtService>('jwt');
  const { username, password } = await ctx.request.json();

  const principal = await auth.verifyCredentials({ identifier: username, secret: password });
  if (!principal) {
    return ctx.response.status(401).json({ error: 'Invalid credentials' });
  }

  const accessToken = await jwt.sign(
    { sub: principal.id, roles: principal.roles },
    { expiresIn: '1h', audience: 'my-app-users', issuer: 'my-app' },
  );
  return ctx.response.json({ accessToken });
});
```

### Refresh Tokens (M16b)

`RefreshTokenService` is an **app-instantiated** class (like `PasswordHasher`) — it is NOT an
`AuthPlugin` option and registers no service. A refresh token is a signed JWT carrying
`type: 'refresh'` and a random `jti`; a pluggable server-side store tracks each `jti` so the service
can **rotate** (each `refresh` revokes the presented token and mints a fresh pair — replay of a
rotated token returns `null`) and **revoke** (logout). `refresh()`/`revoke()` never throw on a bad
token: an invalid, expired, or tampered token yields `null`/`false`. The access token uses the
`accessToken` options; the refresh token uses `refreshTokenExpiresIn` (default `'7d'`). Both carry
the configured `audience`/`issuer` so `verify` enforces them. `MemoryRefreshTokenStore` is the
default backend (single-process; lazy expiry on `get`); a Redis-backed `RefreshTokenStore` is
deferred — the async interface makes it a later drop-in.

```typescript
import { MemoryRefreshTokenStore, RefreshTokenService } from '@hono-enterprise/auth-plugin';
import type { IJwtService, IRuntimeServices } from '@hono-enterprise/common';

const jwt = app.services.get<IJwtService>('jwt');
const runtime = app.services.get<IRuntimeServices>('runtime');
const refresh = new RefreshTokenService({
  jwt,
  store: new MemoryRefreshTokenStore(runtime),
  runtime,
  accessToken: { expiresIn: '15m', audience: 'my-app-users', issuer: 'my-app' },
  refreshTokenExpiresIn: '30d',
});

// Login: issue the pair after verifying credentials
app.router.post('/auth/login', async (ctx) => {
  const principal = await auth.verifyCredentials({ identifier, secret });
  if (!principal) return ctx.response.status(401).json({ error: 'Invalid credentials' });
  return ctx.response.json(await refresh.issue(principal)); // { accessToken, refreshToken }
});

// Refresh: rotate the pair (the presented refresh token is revoked)
app.router.post('/auth/refresh', async (ctx) => {
  const { refreshToken } = await ctx.request.json<{ refreshToken: string }>();
  const pair = await refresh.refresh(refreshToken);
  if (!pair) return ctx.response.status(401).json({ error: 'Invalid refresh token' });
  return ctx.response.json(pair);
});

// Logout: revoke the refresh token
app.router.post('/auth/logout', async (ctx) => {
  const { refreshToken } = await ctx.request.json<{ refreshToken: string }>();
  await refresh.revoke(refreshToken);
  return ctx.response.json({ ok: true });
});
```

### Rate Limiting (M16b)

`rateLimitMiddleware(options)` is a **standalone** fixed-window limiter — added via
`app.middleware.add(...)` like `authMiddleware`, independent of `AuthPlugin` (it never reads the
principal unless your `keyGenerator` does) and registered under **no capability token**. Requests
are counted per key (default `ctx.request.ip ?? 'anonymous'`) in a `windowMs` window; when the count
exceeds `max` the middleware **short-circuits with 429** (downstream stages, including the handler,
do not run) and a JSON body `{ error: 'Too Many Requests', message }`. Headers: always `Retry-After`
on 429; with `standardHeaders` (default `true`) also `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` — `RateLimit-Reset` and `Retry-After` are both **delta-seconds** until the window
resets (IETF draft semantics), never epoch timestamps. The default store is an in-memory
fixed-window counter (single-process); pass `store: new RedisRateLimitStore({ url, runtime })` for
multi-instance deployments (ioredis is inject-or-lazy: pass `client` to inject, otherwise
`npm:ioredis@5.x` is lazily imported on first use).

```typescript
import { rateLimitMiddleware, RedisRateLimitStore } from '@hono-enterprise/auth-plugin';

// Global: 100 requests per minute per client IP (in-memory store)
app.middleware.add(rateLimitMiddleware({ windowMs: 60_000, max: 100 }));

// Per-route, keyed by authenticated user, Redis-backed
app.router.post('/expensive', {
  middleware: [
    rateLimitMiddleware({
      windowMs: 60_000,
      max: 5,
      keyGenerator: (ctx) => ctx.request.user?.id ?? ctx.request.ip ?? 'anonymous',
      store: new RedisRateLimitStore({ url: 'redis://localhost:6379', runtime }),
      message: 'Too many expensive calls — try again shortly',
    }),
  ],
  handler: async (ctx) => {/* ... */},
});
```

### Protecting Routes

Guards are free `MiddlewareFunction` factories. The authorization guards resolve
`IAuthorizationService` from `'authorization'`, return **401** when no principal is attached and
**403** when the check fails, and short-circuit (they do **not** call `next()`). `authMiddleware`
always calls `next()`, so an unauthenticated request still reaches the guard. (`publicRoute` is used
instead of `public` because `public` is a reserved word.) Role hierarchy is resolved transitively,
and the wildcard permission `'*'` — held directly or granted by any (direct or inherited) role —
satisfies every permission check.

```typescript
import {
  publicRoute,
  requireAllPermissions,
  requireAnyRole,
  requireAuth,
  requirePermission,
  requireRole,
} from '@hono-enterprise/auth-plugin';

// Require authentication
app.router.get('/profile', {
  middleware: [requireAuth()],
  handler: async (ctx) => ctx.response.json(ctx.request.user),
});

// Require a role (admin satisfies 'user' via the configured `inherits` hierarchy)
app.router.delete('/users/:id', {
  middleware: [requireAuth(), requireRole('admin')],
  handler: async (ctx) => {/* ... */},
});

// Require a permission
app.router.post('/users', {
  middleware: [requireAuth(), requirePermission('users:write')],
  handler: async (ctx) => {/* ... */},
});

// Require any of several roles / all of several permissions
app.router.get('/reports', {
  middleware: [requireAuth(), requireAnyRole(['admin', 'manager'])],
  handler: async (ctx) => {/* ... */},
});
app.router.post('/bulk', {
  middleware: [requireAuth(), requireAllPermissions(['users:read', 'users:write'])],
  handler: async (ctx) => {/* ... */},
});

// Explicitly public route
app.router.get('/health', {
  middleware: [publicRoute()],
  handler: async (ctx) => ctx.response.json({ status: 'ok' }),
});
```

### Accessing the Current User

`authMiddleware` writes the authenticated principal to `ctx.request.user` (one of the two
middleware-written fields on `IRequest` — the other is `tenant`, written by the multi-tenancy plugin
— so the shipped `@CurrentUser` decorator resolves it).

```typescript
app.router.get('/me', {
  middleware: [requireAuth()],
  handler: async (ctx) => {
    const user = ctx.request.user!;
    return ctx.response.json({ id: user.id, roles: user.roles, permissions: user.permissions });
  },
});
```

### Password Hashing

`PasswordHasher` is an exported utility for provisioning passwords and verifying them inside a
`local.verify` callback. It draws a random salt and derives a 32-byte key with PBKDF2-SHA256 (100
000 iterations) via `runtime.subtle` / `runtime.randomBytes`.

```typescript
import { PasswordHasher } from '@hono-enterprise/auth-plugin';

const hasher = new PasswordHasher(runtime); // IRuntimeServices resolved from the 'runtime' token
const stored = await hasher.hash('correct horse battery staple');
const ok = await hasher.verify(stored, 'correct horse battery staple'); // true
```

---

## HttpSecurityPlugin()

Provides HTTP transport security as a middleware-only plugin: CORS, security response headers, CSRF
(stateless Origin/Referer validation), request-size limiting, and IP resolution. Registers **no
capability token** and **no service** — each concern is registered as global middleware via
`ctx.middleware.add(...)` and also exported as a standalone factory for per-route use.

**Defaults:** Security headers are ON by default; CORS, CSRF, request-size, and IP-security are
opt-in via their option blocks. Each concern is secure-by-default when enabled.

### Registration

```typescript
import { HttpSecurityPlugin } from '@hono-enterprise/http-security-plugin';

app.register(HttpSecurityPlugin({
  cors: { origin: 'https://example.com', credentials: true },
  csrf: { trustedOrigins: ['https://example.com'] },
  requestSize: { maxBodySize: 2_097_152 },
  ipSecurity: { trustProxy: true },
}));
```

### Exports

| Export                           | Description                            |
| -------------------------------- | -------------------------------------- |
| `HttpSecurityPlugin`             | Plugin factory                         |
| `corsMiddleware`                 | CORS middleware factory                |
| `securityHeadersMiddleware`      | Security headers middleware factory    |
| `csrfMiddleware`                 | CSRF middleware factory                |
| `requestSizeMiddleware`          | Request-size middleware factory        |
| `ipSecurityMiddleware`           | IP security middleware factory         |
| `HttpSecurityPluginOptions`      | Plugin factory options (type)          |
| `CorsOptions`                    | CORS middleware options (type)         |
| `CorsOriginMatcher`              | Dynamic origin matcher function (type) |
| `SecurityHeadersOptions`         | Security headers options (type)        |
| `ContentSecurityPolicyOptions`   | CSP directive options (type)           |
| `StrictTransportSecurityOptions` | HSTS options (type)                    |
| `CsrfOptions`                    | CSRF middleware options (type)         |
| `RequestSizeOptions`             | Request-size options (type)            |
| `IpSecurityOptions`              | IP security options (type)             |

### Options

| Option         | Type                     | Default            | Description                                        |
| -------------- | ------------------------ | ------------------ | -------------------------------------------------- |
| `cors?`        | `CorsOptions`            | —                  | Presence enables CORS (priority 200).              |
| `headers?`     | `SecurityHeadersOptions` | default secure set | Omitted → defaults ON. `{ enabled: false }` → off. |
| `csrf?`        | `CsrfOptions`            | —                  | Presence enables CSRF (priority 270).              |
| `requestSize?` | `RequestSizeOptions`     | —                  | Presence enables size limiting (priority 180).     |
| `ipSecurity?`  | `IpSecurityOptions`      | —                  | Presence enables IP resolution (priority 120).     |

### Per-concern Behavior

#### CORS (`corsMiddleware`)

Origin matching via `origin` (boolean/string/array/function). Preflight (`OPTIONS` + `Origin` +
`Access-Control-Request-Method`) → 204 short-circuit with `Access-Control-Allow-Origin`,
`Access-Control-Allow-Methods`, and (when configured) `Access-Control-Allow-Headers` /
`Access-Control-Max-Age`. Credentials reflect specific origin (never `*`). Non-preflight disallowed
origins call `next()` without CORS headers (browser enforces block).

`Vary: Origin` is appended to **every** response for a request carrying an `Origin` header —
including a denied one — so a shared cache cannot serve an allowed origin's response to a denied
origin or the reverse.

`origin: true` (reflect any origin) combined with `credentials: true` **throws at construction**:
reflecting an arbitrary origin while allowing credentials lets any site the user visits read
credentialed responses. List the origins, or pass a `CorsOriginMatcher`.

#### Security Headers (`securityHeadersMiddleware`)

Sets headers **before** `next()` so they persist through handler and downstream short-circuits.
Default set: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
CSP and Permissions-Policy have no default (explicitly configure to enable). Per-header `false`
omits that header.

#### CSRF (`csrfMiddleware`)

Stateless Origin/Referer validation for unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`). The
request's own origin (from `request.url`) is always implicitly trusted. `trustedOrigins` adds
further allowed origins. Both headers absent → pass through (non-browser clients). Optional
`customHeader` requires that header on unsafe methods (403 when absent).

#### Request Size (`requestSizeMiddleware`)

Checks `Content-Length` against `maxBodySize` (default 1 MiB). Over limit → 413 short-circuit
without reading body. Absent or malformed `Content-Length` → pass through.

#### IP Security (`ipSecurityMiddleware`)

Resolves client IP and publishes to `ctx.state.set('clientIp', ip)`. When `trustProxy: true`, reads
the configured `ipHeader` (default `X-Forwarded-For`) and takes the leftmost address. Never
short-circuits.

**`trustProxy` is the only working source on the first-party adapters.** The fallback to
`request.ip` is vestigial since M23: a web `Request` carries no peer address, so the shared `fetch`
mapping cannot populate `IRequest.ip` and `clientIp` is `undefined` unless the proxy header is
present. The fallback is retained for a custom `IHttpAdapter` that does set it.

---

## CachePlugin()

Provides caching with multiple stores (Memory, Redis, Noop) and a transparent response-caching
middleware.

Registers `ICacheStore` under `CAPABILITIES.CACHE`.

### Exports

| Export                   | File                                 | Description                              |
| ------------------------ | ------------------------------------ | ---------------------------------------- |
| `CachePlugin`            | `src/plugin/cache-plugin.ts`         | Plugin factory                           |
| `CacheService`           | `src/services/cache-service.ts`      | Wrapper applying prefix + defaultTTL     |
| `MemoryStore`            | `src/stores/memory-store.ts`         | In-memory LRU + TTL store                |
| `RedisStore`             | `src/stores/redis-store.ts`          | Redis store via ioredis                  |
| `NoopStore`              | `src/stores/noop-store.ts`           | No-op store (dev/test)                   |
| `cacheMiddleware`        | `src/middleware/cache-middleware.ts` | Transparent response-caching middleware  |
| `CacheStoreType`         | `src/interfaces/index.ts`            | `'memory' \| 'redis' \| 'noop'`          |
| `CacheStoreOptions`      | `src/interfaces/index.ts`            | Store-specific options                   |
| `CachePluginOptions`     | `src/interfaces/index.ts`            | Plugin factory options                   |
| `IRedisClient`           | `src/interfaces/index.ts`            | Structural ioredis shape                 |
| `CacheMiddlewareOptions` | `src/interfaces/index.ts`            | Middleware options                       |
| `CachedResponsePayload`  | `src/interfaces/index.ts`            | Cached response shape                    |
| `ICacheStore`            | `src/interfaces/index.ts`            | Re-export from `@hono-enterprise/common` |

### Registration

```typescript
import { CachePlugin } from '@hono-enterprise/cache-plugin';

// Memory store (default)
app.register(CachePlugin());

// Redis store with URL
app.register(CachePlugin({
  store: 'redis',
  options: { url: 'redis://localhost:6379', prefix: 'myapp:' },
}));

// Named multi-cache instance
app.register(CachePlugin({ name: 'session', options: { maxSize: 500 } }));
```

### Programmatic API

```typescript
import type { ICacheStore } from '@hono-enterprise/common';

app.router.get('/users/:id', async (ctx) => {
  const cache = ctx.services.get<ICacheStore>('cache');
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

Transparent response-caching middleware that stores full HTTP responses (status, headers, body) and
replays them on cache HIT without invoking the handler.

```typescript
import { cacheMiddleware } from '@hono-enterprise/cache-plugin';

app.router.get('/users/:id', {
  middleware: [
    cacheMiddleware({
      ttlSeconds: 3600,
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

### ICacheStore Interface

```typescript
interface ICacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
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
  publish<T>(event: IDomainEvent<T>): Promise<void>;
  publishBatch(events: IDomainEvent[]): Promise<void>; // non-generic: batches are heterogeneous
  subscribe<T>(type: string, handler: EventHandler<T>): Unsubscribe; // returns an Unsubscribe fn
}
```

### EventsPlugin Exports

- **`EventsPlugin`** — Plugin factory that configures and registers the in-memory event bus with the
  given dispatch options (`async`, `errorHandler`).
- **`InMemoryEventBus`** — In-memory publish/subscribe event bus implementing `IEventBus`.
- **`DomainEvent`** — Base class for domain events, generated by `defineDomainEvent`.
- **`IntegrationEvent`** — Semantic subclass of `DomainEvent` for integration events (no additional
  fields).
- **`defineDomainEvent`** — Factory that binds `DomainEvent` and `IntegrationEvent` to a runtime,
  returning event IDs and timestamps from the runtime's `uuid` and `now` services.
- **`IEventHandler`** — Class-based event handler interface with a `handle(event)` method.
- **`subscribeHandler`** — Function that adapts an `IEventHandler` instance to the `EventHandler`
  signature and subscribes it to the bus; returns an `Unsubscribe` function.

**Re-exports from `@hono-enterprise/common`:** `IEventBus`, `IDomainEvent`, `EventHandler`,
`Unsubscribe`.

---

## SsePlugin()

Provides Server-Sent Events (SSE) for real-time, one-way server-to-client messaging over
`text/event-stream`. Built on the Milestone 42 `IResponse.stream()` primitive and
`IRequestContext.signal` abort lifecycle.

### Registration

```typescript
import { SsePlugin } from '@hono-enterprise/sse-plugin';

app.register(SsePlugin({
  heartbeatMs: 15000,
  retryMs: 3000,
}));
```

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ISseService } from '@hono-enterprise/common';

app.router.get('/events', async (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  const conn = sse.open(ctx);

  // Send immediately after handler returns — the stream stays open
  conn.send({ id: '1', data: 'hello' });

  return conn.result;
});

// Broadcast to a named channel
app.router.post('/broadcast', async (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  sse.channel('updates').publish({ data: { msg: 'announcement' } });
  return ctx.response.json({ ok: true });
});
```

### Options

| Option          | Type      | Default | Description                                                                                                                                                                                   |
| --------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatMs`   | `number`  | omitted | When set, sends `: heartbeat\n\n` at this interval.                                                                                                                                           |
| `retryMs`       | `number`  | omitted | When set, sends `retry: <ms>\n\n` as the first frame.                                                                                                                                         |
| `scalingNotice` | `boolean` | `true`  | Logs one `info` line at registration when no realtime backplane is registered, stating that channels broadcast in-process only. `false` silences the message; channel delivery is unaffected. |

Omitting an option disables that behaviour (no timer created).

### Interface Reference

- `ISseService.open(ctx): ISseConnection` — opens a new SSE connection; sets headers, returns a
  connection with `result` (`HandlerResult`) the handler must return.
- `ISseService.channel(name): SseChannel` — get-or-create a named broadcast channel.
- `ISseService.connectionCount: number` — current open connections.
- `ISseConnection.send(msg)` — enqueue an encoded SSE frame (`id:`, `event:`, `data:` / multi-line
  `data:`, `retry:` + blank-line terminator).
- `ISseConnection.comment(text)` — enqueue a comment frame (`: text\n\n`).
- `ISseConnection.close()` — close the connection (idempotent).
- `ISseConnection.lastEventId` — the value of the `Last-Event-ID` request header (for resume logic).
- `SseChannel.publish(msg)` — broadcast to every open member, skipping closed ones.

### Exports

| Symbol                                                      | Kind              | Description                                                         |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `SsePlugin`                                                 | function          | Plugin factory — registers `ISseService` under `CAPABILITIES.SSE`   |
| `SseService`                                                | class             | The `ISseService` implementation                                    |
| `SseConnection`                                             | class             | A live SSE connection over a `ReadableStream`                       |
| `SsePluginOptions`                                          | interface         | `heartbeatMs`, `retryMs`, `scalingNotice`                           |
| `ChannelPublisher`                                          | type              | Forwards a local publish to other replicas; supplied by a backplane |
| `ISseConnection`, `ISseService`, `SseChannel`, `SseMessage` | type (re-export)  | From `@hono-enterprise/common`                                      |
| `CAPABILITIES`                                              | const (re-export) | From `@hono-enterprise/common`                                      |

### Notes

- Built entirely on web-standard `ReadableStream`; no platform-specific server socket APIs.
- **Channels are in-process until a backplane is registered.** Register
  [`RealtimeBackplanePlugin`](#realtimebackplaneplugin) and every `publish` also reaches members on
  other replicas; with no `CAPABILITIES.REALTIME_BACKPLANE` provider the behavior is unchanged.
  `SseChannel.size` keeps reporting **local** membership either way. `SseChannelImpl.publishLocal`
  is the local-only delivery path the backplane subscriber uses; applications call `publish`.
- Cloudflare Workers and other edge platforms bound long-lived connections by their own limits — the
  plugin opens the stream the same way everywhere, but the platform may truncate the connection.
- The `inject()` method cannot read a streaming body and throws when it meets one; SSE integration
  tests must use a real socket (`app.start({ port })` + `fetch()`).

---

## WebSocketPlugin()

Provides full-duplex, bidirectional real-time messaging, completing the real-time story that
`SsePlugin` covers one-way. Registers an `IWebSocketService` under `CAPABILITIES.WEBSOCKET`. Added
in Milestone 46.

The RFC 6455 handshake is performed by the runtime's HTTP adapter through the optional
`IHttpAdapter.setUpgradeRouter` seam, so the same application code runs on Node, Deno, Bun, and
Cloudflare Workers. The plugin never creates a server and never touches a runtime API.

### Registration

```typescript
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';

app.register(WebSocketPlugin({
  maxConnections: 10_000,
  heartbeatMs: 30_000,
  heartbeatPayload: 'ping',
  idleTimeoutMs: 90_000,
  maxMessageBytes: 1_048_576,
}));
```

### Options

| Option             | Type      | Default  | Behavior                                                                                                                                                                                    |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConnections`   | `number`  | `0`      | Simultaneous open connections across all routes; `0` is unlimited. At the limit, upgrades get HTTP 503.                                                                                     |
| `heartbeatMs`      | `number`  | `0`      | Heartbeat interval; `0` disables it and creates no timer.                                                                                                                                   |
| `heartbeatPayload` | `string`  | `'ping'` | The text frame sent each tick. Read only when `heartbeatMs > 0`.                                                                                                                            |
| `idleTimeoutMs`    | `number`  | `0`      | Inbound silence after which a connection is closed with `1001`; `0` disables. Requires `heartbeatMs > 0` — otherwise `WebSocketPlugin()` throws, so the option can never be silently inert. |
| `maxMessageBytes`  | `number`  | `0`      | Largest inbound frame; `0` is unlimited. A larger frame closes with `1009` and never reaches `onMessage`.                                                                                   |
| `scalingNotice`    | `boolean` | `true`   | Logs one `info` line at registration when no realtime backplane is registered, stating that rooms broadcast in-process only. `false` silences the message; room delivery is unaffected.     |

### Usage

```typescript
import { CAPABILITIES, type IWebSocketService } from '@hono-enterprise/common';

const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

ws.route('/ws/chat', {
  onOpen: (conn, { query, headers }) => {
    conn.data.set('room', query.room ?? 'lobby');
    ws.room(query.room ?? 'lobby').add(conn);
  },
  onMessage: (conn, data) => {
    ws.room(conn.data.get('room') as string).broadcast(data, { except: conn });
  },
  onClose: (conn, { code, reason }) => logger.info('closed', { code, reason }),
  onError: (conn, error) => logger.error('socket error', { error }),
}, { protocols: ['chat'] });
```

### Exports

| Export                      | Kind     | Purpose                                                                |
| --------------------------- | -------- | ---------------------------------------------------------------------- |
| `WebSocketPlugin`           | function | Creates the plugin                                                     |
| `WebSocketService`          | class    | The `IWebSocketService` implementation registered under the token      |
| `WebSocketConnection`       | class    | The `IWebSocketConnection` implementation                              |
| `Room`                      | class    | The `WebSocketRoom` implementation                                     |
| `RoomRegistry`              | class    | Owns live rooms, creating on demand and discarding when empty          |
| `WsRouteTable`              | class    | Exact-path route table with subprotocol selection                      |
| `HeartbeatSweeper`          | class    | The interval implementing `heartbeatMs` / `idleTimeoutMs`              |
| `WebSocketUnavailableError` | class    | Thrown by `route()` when the adapter offers no upgrade seam            |
| `resolveOptions`            | function | Applies option defaults and rejects a contradictory configuration      |
| `frameByteLength`           | function | Measures a frame in bytes (text by UTF-8 encoding, not string length)  |
| `buildContext`              | function | Builds the `WebSocketConnectionContext` from an upgrade request        |
| `parseRequestedProtocols`   | function | Parses a `Sec-WebSocket-Protocol` header into tokens                   |
| `selectProtocol`            | function | Picks the subprotocol to echo, or refuses                              |
| `WebSocketPluginOptions`    | type     | The options above                                                      |
| `WsRoute`, `WsRouteMatch`   | type     | Route table entry and match result                                     |
| `HeartbeatOptions`          | type     | Resolved heartbeat configuration                                       |
| `RoomMembershipListener`    | type     | Join/leave callbacks a `RoomRegistry` gives each `Room` it creates     |
| `RoomPublisher`             | type     | Forwards a local broadcast to other replicas; supplied by a backplane  |
| `LocalBroadcastOptions`     | type     | `broadcastLocal` options — adds `exceptId` to exclude by connection ID |

### Notes

- **Routes match on exact path.** Variable data travels in the query string and reaches `onOpen` via
  `WebSocketConnectionContext.query`. Pattern parameters (`:id`) are deliberately not supported: the
  kernel's matcher is internal to `@hono-enterprise/kernel` and hand-rolling a second one would
  duplicate logic.
- **The heartbeat is an application-level frame, not an RFC 6455 ping.** The web `WebSocket` API on
  Deno and Cloudflare Workers exposes no `ping()`, so a protocol ping would silently no-op on half
  the supported runtimes.
- **Node requires `npm:ws`.** It is an optional dependency, loaded lazily on the first accepted
  upgrade (AI_GUIDELINES §12.2) — a plain HTTP application never loads it. `loadWsModule` throws
  with the install command when it is absent. The other three runtimes need no dependency.
- **Upgrades on Node arrive on the raw `upgrade` event, not the `fetch` path**, so they are only
  available after `listen()`. On Bun, upgrades likewise only work through `listen()`, since
  `server.upgrade` requires the serve-time `websocket` handlers. Deno and Workers upgrade on the
  `fetch` path.
- **A custom adapter without `setUpgradeRouter` degrades gracefully**: the service still registers,
  the health indicator reports `available: false`, and `route()` throws `WebSocketUnavailableError`.
- **Rooms are in-process until a backplane is registered.** Register
  [`RealtimeBackplanePlugin`](#realtimebackplaneplugin) and every `broadcast` also reaches members
  on other replicas; with no `CAPABILITIES.REALTIME_BACKPLANE` provider the behavior is unchanged.
  `RoomBroadcastOptions.except` is honored on **every** replica: connection IDs come from
  `runtime.uuid()` and are globally unique, so the frame carries the excluded ID. `Room.size` keeps
  reporting **local** membership either way. `Room.broadcastLocal` is the local-only delivery path
  the backplane subscriber uses (its `LocalBroadcastOptions` adds `exceptId`); applications call
  `broadcast`.
- A `RoomRegistry` keeps a reverse `connection → rooms` index, so evicting a disconnecting peer
  costs only the rooms that peer had actually joined rather than a scan of every live room. The
  index is maintained through the `RoomMembershipListener` the registry gives each `Room` it
  creates; a standalone `new Room(name)` takes no listener and is not tracked.
- **A failing upgrade router is logged, then refused with `500`.** The service catches its own
  routing errors and reports them through the logger capability when one is registered — the HTTP
  adapter's `UpgradeRouterStore` backstop runs inside `@hono-enterprise/runtime`, which has no
  logger, so the cause would otherwise be lost. Register the LoggerPlugin to see it.
- **`app.inject()` cannot exercise a WebSocket**; tests must bind a real socket
  (`app.start({ port })` + `new WebSocket(...)`).
- A `websocket` health indicator reports `{ available, connections, rooms, routes }`. `onClose`
  closes every live connection with code `1001` and stops the heartbeat.

---

## RealtimeBackplanePlugin()

Provides cross-replica fan-out for WebSocket rooms and SSE channels. Registers an
`IRealtimeBackplane` under `CAPABILITIES.REALTIME_BACKPLANE` (`'realtime-backplane'`). Added in
Milestone 47.

Rooms and channels hold membership in in-process sets, so behind a load balancer a broadcast reaches
only the clients connected to the replica that issued it. `WebSocketPlugin` and `SsePlugin` resolve
this token **optionally**, so registering this plugin is the entire change; removing it restores
in-process behavior with no application code touched.

### Registration

```typescript
import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' }),
    WebSocketPlugin(),
    SsePlugin(),
  ],
});
```

Its priority is `PLUGIN_PRIORITY.HIGH`, so the transport is connected before either consumer
registers and subscribes.

### Options

Discriminated on `transport`.

| Option                  | Applies to       | Default                      | Description                                                         |
| ----------------------- | ---------------- | ---------------------------- | ------------------------------------------------------------------- |
| `transport`             | all              | `'memory'`                   | `'memory' \| 'messaging' \| 'redis' \| 'custom'`                    |
| `topic`                 | all but `memory` | `'hono-enterprise.realtime'` | Broker topic / Redis channel. Every replica must agree on it        |
| `origin`                | all              | a fresh `runtime.uuid()`     | This replica's identity. Override only to make a test deterministic |
| `bus`                   | `'memory'`       | `'default'`                  | Named in-process bus; separate names stay isolated                  |
| `url`                   | `'redis'`        | —                            | Connection URL, read only on the lazy `npm:ioredis@5.x` path        |
| `client` / `subscriber` | `'redis'`        | —                            | Injected client pair. **Required together** — see Notes             |
| `module`                | `'redis'`        | —                            | An `ioredis`-shaped module, for testing without the real driver     |
| `instance`              | `'custom'`       | —                            | The `IRealtimeBackplane` to register, used as-is                    |

### Transports

| `transport`   | Crosses processes | Dependencies                   | Notes                                                          |
| ------------- | ----------------- | ------------------------------ | -------------------------------------------------------------- |
| `'memory'`    | No                | None                           | The default, and a real single-process bus rather than a no-op |
| `'messaging'` | Yes               | A plugin providing `messaging` | Reuses all five existing brokers; adds no dependency           |
| `'redis'`     | Yes               | `npm:ioredis@5.x` (lazy)       | Redis pub/sub, over two connections                            |
| `'custom'`    | Depends           | None                           | Any `IRealtimeBackplane`                                       |

### Exports

| Symbol                                                                                               | Kind              | Description                                                   |
| ---------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| `RealtimeBackplanePlugin`                                                                            | function          | Plugin factory                                                |
| `createBackplane`                                                                                    | function          | Transport factory dispatching on the `transport` discriminant |
| `MemoryBackplane`                                                                                    | class             | In-process transport                                          |
| `MessagingBackplane`                                                                                 | class             | Transport over `CAPABILITIES.MESSAGING`                       |
| `RedisBackplane`                                                                                     | class             | Redis pub/sub transport                                       |
| `isRealtimeFrame`                                                                                    | function          | Guard narrowing arriving broker traffic to a `RealtimeFrame`  |
| `adaptRedisModule`                                                                                   | function          | Narrows an `ioredis` module to `IRedisModule`                 |
| `loadRedisModule`                                                                                    | function          | Real lazy `import('npm:ioredis@5.x')`                         |
| `RedisModuleError`                                                                                   | class             | Thrown when `ioredis` cannot be loaded or recognized          |
| `DEFAULT_TOPIC`                                                                                      | const             | `'hono-enterprise.realtime'`                                  |
| `IRedisBackplaneClient`                                                                              | interface         | Structural facade for an injected Redis client                |
| `IRedisModule`                                                                                       | interface         | Structural facade for the `ioredis` module                    |
| `RealtimeBackplanePluginOptions`                                                                     | type              | Discriminated union of the four transport arms                |
| `BackplaneCommonOptions`                                                                             | interface         | `topic` and `origin`, shared by every arm                     |
| `MemoryBackplaneOptions`                                                                             | interface         | The `'memory'` arm                                            |
| `MessagingBackplaneOptions`                                                                          | interface         | The `'messaging'` arm                                         |
| `RedisBackplaneOptions`                                                                              | interface         | The `'redis'` arm                                             |
| `CustomBackplaneOptions`                                                                             | interface         | The `'custom'` arm                                            |
| `IRealtimeBackplane`, `RealtimeFrame`, `RealtimeFrameHandler`, `RealtimeFrameKind`, `EncodedPayload` | type (re-export)  | From `@hono-enterprise/common`                                |
| `encodeFrameData`, `decodeFrameData`, `CAPABILITIES`                                                 | value (re-export) | From `@hono-enterprise/common`                                |

### Notes

- **Loop prevention is an origin stamp.** Every instance owns an `origin` (a `runtime.uuid()` by
  default); a subscriber drops frames carrying its own. An arriving frame is delivered through the
  consumer's local-only path and never re-published, so a broadcast is delivered exactly once per
  replica.
- **One topic carries both kinds.** `RealtimeFrame.kind` is `'ws-room'` or `'sse-channel'`, and each
  consumer ignores the other — a room and a channel may legitimately share a name.
- **Redis needs two connections.** A Redis connection in subscriber mode refuses every command other
  than (un)subscribe, so one connection cannot both publish and subscribe. That is a property of the
  protocol, not of `ioredis`. Injecting a `client` without a `subscriber` throws at construction
  rather than failing at the first publish; the lazy path builds both from `url`.
- **`transport: 'messaging'` with no messaging capability throws during `register()`**, rather than
  failing silently per request.
- **A remote frame never creates a room or channel.** It is delivered only to one that already
  exists locally, so a cluster-wide namespace cannot grow a replica's maps without bound.
- **Binary WebSocket frames are base64-encoded** for the wire (`encodeFrameData` /
  `decodeFrameData`, in `@hono-enterprise/common` because three packages need the identical shape).
  An `SseMessage` is already JSON-serializable and travels as its JSON encoding.
- **Delivery is at-most-once** and inherits the transport's guarantees. Frames are not persisted or
  replayed; a replica partitioned from the transport misses frames sent during the partition.
- **`RoomBroadcastOptions.except` is honored cluster-wide.** It names a live connection object,
  which means nothing in another process — but connection IDs come from `runtime.uuid()` and are
  therefore globally unique, so `RealtimeFrame.exceptId` carries the ID and every replica skips the
  matching member. Excluding a peer connected to a _different_ replica works for the same reason.
- **`Room.size` / `SseChannel.size` remain local.** A cluster-wide count is inherently asynchronous
  (a scatter-gather across replicas), so it cannot satisfy the synchronous committed `size` getter;
  exposing one is a contract decision — a separate async method — that a later milestone owns.

---

## SessionPlugin()

Cookie-backed sessions and session-backed form CSRF. Registers a `SessionService`
(`ISessionService`) under `CAPABILITIES.SESSION` (`'session'`). Added in Milestone 48.

The default is a self-contained **encrypted** cookie: AES-256-GCM under a key derived by
HKDF-SHA256, entirely through `IRuntimeServices.subtle` (the Milestone 16 `JwtService` precedent),
so the package has zero npm dependencies and works on Cloudflare Workers. Setting `store` moves the
payload server-side and leaves only an opaque id in the cookie, which is what makes immediate
revocation possible.

```typescript
import { getSession, SessionPlugin } from '@hono-enterprise/session-plugin';

const app = createApplication({
  plugins: [RuntimePlugin(), SessionPlugin({ secret: mySecret, csrf: {} })],
});

app.router.post('/login', (ctx) => {
  const session = getSession(ctx);
  session.set('userId', user.id);
  session.regenerate(); // new id, same data — defeats session fixation
  return ctx.response.json({ ok: true });
});
```

### Options

| Option               | Type                                   | Default                    | Behavior                                                                                                                                                                                               |
| -------------------- | -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `secret`             | `string \| readonly string[]`          | resolved                   | Index 0 seals; every entry can open, so rotation does not log users out                                                                                                                                |
| `secretName`         | `string`                               | `SESSION_SECRET`           | Name looked up in `CAPABILITIES.SECRETS` and then in `runtime.env`                                                                                                                                     |
| `mode`               | `'encrypt' \| 'sign'`                  | `'encrypt'`                | `'sign'` is HMAC-only and leaves the payload READABLE by the client                                                                                                                                    |
| `store`              | `'memory' \| 'cache' \| ISessionStore` | —                          | Omitted keeps the payload in the cookie; set moves it server-side                                                                                                                                      |
| `maxAge`             | `number` (seconds)                     | `7200`                     | Enforced from a stamp inside the payload, not from the cookie's `Max-Age`                                                                                                                              |
| `rolling`            | `boolean`                              | `false`                    | `true` re-issues on every response, extending expiry                                                                                                                                                   |
| `idleTimeoutMs`      | `number`                               | —                          | Expiry after this long with no requests. Refreshed by ANY request including a read-only one, so setting it commits on every response to advance the activity stamp; it does not extend absolute expiry |
| `maxCookieBytes`     | `number`                               | `4096`                     | Throws `SessionTooLargeError` rather than emitting a cookie browsers drop                                                                                                                              |
| `cookie.name`        | `string`                               | `hono_session`             |                                                                                                                                                                                                        |
| `cookie.path`        | `string`                               | `'/'`                      |                                                                                                                                                                                                        |
| `cookie.domain`      | `string`                               | —                          | Omitted produces a host-only cookie                                                                                                                                                                    |
| `cookie.sameSite`    | `'strict' \| 'lax' \| 'none'`          | `'lax'`                    | `'none'` forces `Secure`                                                                                                                                                                               |
| `cookie.secure`      | `boolean`                              | `true`                     | Escape hatch for plain-HTTP local development                                                                                                                                                          |
| `cookie.httpOnly`    | `boolean`                              | `true`                     |                                                                                                                                                                                                        |
| `csrf`               | `CsrfFormOptions`                      | —                          | Presence registers `csrfFormMiddleware` at priority 275                                                                                                                                                |
| `csrf.fieldName`     | `string`                               | `'_csrf'`                  | Form field carrying the token                                                                                                                                                                          |
| `csrf.headerName`    | `string`                               | —                          | Accepted alternative source; REQUIRED for `multipart/form-data`                                                                                                                                        |
| `csrf.ignoreMethods` | `readonly string[]`                    | `['GET','HEAD','OPTIONS']` | Methods that skip verification                                                                                                                                                                         |

### Exports

| Export                          | Kind      | Purpose                                                                    |
| ------------------------------- | --------- | -------------------------------------------------------------------------- |
| `SessionPlugin`                 | function  | The plugin factory                                                         |
| `SessionService`                | class     | `ISessionService` implementation registered under the token                |
| `getSession`                    | function  | The single accessor: `getSession(ctx): ISession`                           |
| `sessionMiddleware`             | function  | Load/commit middleware (registered at 260; exported for standalone wiring) |
| `csrfFormMiddleware`            | function  | Synchronizer-token middleware (registered at 275 when `csrf` is present)   |
| `getCsrfToken`                  | function  | Mints-and-stores on first call, then stable within the session             |
| `verifyCsrfToken`               | function  | Standalone verification for handlers and React Router actions              |
| `CSRF_SESSION_KEY`              | const     | Reserved session key holding the token (`'__csrf'`)                        |
| `MemorySessionStore`            | class     | `Map`-backed store; requires injected clock and timers                     |
| `CacheSessionStore`             | class     | Store over any `ICacheStore` resolved from `CAPABILITIES.CACHE`            |
| `SessionSecretMissingError`     | class     | Thrown during `register()` when no adequate secret resolves                |
| `SessionMiddlewareMissingError` | class     | Thrown by `getSession` when the middleware did not run                     |
| `CsrfTokenMismatchError`        | class     | Thrown by `verifyCsrfToken`; the middleware converts it to `403`           |
| `SessionTooLargeError`          | class     | Thrown when a committed cookie would exceed `maxCookieBytes`               |
| `SessionMode`                   | type      | `'encrypt' \| 'sign'`                                                      |
| `SessionPluginOptions`          | interface | The factory's parameter                                                    |
| `SessionCookieOptions`          | interface | The `cookie` block                                                         |
| `CsrfFormOptions`               | interface | The `csrf` block, and `verifyCsrfToken`'s options                          |
| `SessionServiceDeps`            | interface | Runtime capabilities the service is constructed with                       |
| `MemorySessionStoreDeps`        | interface | The memory store's required clock and timer injection                      |
| `CacheSessionStoreOptions`      | interface | The cache store's key namespacing                                          |

### Notes

- **Nothing in application code writes a `Set-Cookie`.** The middleware commits after `next()`
  returns, and only when the session is dirty, regenerated, destroyed, or `rolling` is on. A pure
  read emits no header, so sessions do not defeat downstream caching. This works after the handler
  called a terminal response method because the kernel's response builder appends headers without
  consulting whether it ended, and `snapshot()` hands the adapter its live `Headers` rather than a
  clone — cloning would collapse repeated `Set-Cookie` values into one comma-joined header.
- **A request that throws is not committed.** The error handler is about to replace the response,
  and persisting a half-applied mutation from a failed request is worse than dropping it.
- **`mode: 'sign'` does not hide its payload.** It protects integrity only; anyone holding the
  cookie can read its claims. It exists to pair with the store strategy, where the cookie carries
  nothing but an opaque id. `'encrypt'` is the default so the exposing choice is never accidental.
- **Expiry is server-authoritative.** A cookie's `Max-Age` is client-controlled, so `maxAge` is
  enforced from a wall-clock stamp inside the sealed payload. Both stamps come from `runtime.now()`
  rather than `hrtime()`, because they are serialized and compared across processes.
- **`ISession.set(key, undefined)` removes the key** rather than storing `undefined`. Storing it
  would make `has(key)` report a key that serialization drops, so presence would be `true` before a
  commit and `false` after the next load; treating it as an unset keeps `has` truthful across the
  round-trip.
- **A commit rejected for size persists nothing.** The `maxCookieBytes` guard runs before the store
  write, so a session whose cookie the browser would drop does not leave an unreachable row
  occupying its TTL.
- **An idle timeout is refreshed by activity, so it commits on every request.** `idleTimeoutMs`
  measures time since the last _request_, not since the last write, so any request — a read-only one
  included — advances the activity stamp. That requires re-issuing the cookie (and rewriting the
  stored entry on the store strategy) on every response, exactly as `rolling` does. It does not
  extend absolute expiry; `maxAge` stays absolute unless `rolling` is also set, and the two compose.
- **A destroyed session deletes every id it has held.** When `regenerate()` and `destroy()` happen
  in one request, `session.id` is the post-regeneration id that was never stored, while the cookie
  the client presented carries the previous one — so both are removed. Deleting only the current id
  would leave the earlier row readable until its TTL, and a stolen copy of the original cookie would
  keep authenticating after an explicit destroy.
- **Rotation is O(1).** Each key is addressed by a short non-secret `kid` (a truncated HKDF output
  under its own `info` label) carried in the envelope, so opening is a lookup rather than a trial
  decryption against every key.
- **The envelope is `v1.<kid>.<a>.<b>`.** Web Crypto's `subtle.encrypt` returns the authentication
  tag appended to the ciphertext, so unlike `node:crypto` there is no separate tag segment. Every
  malformed input decodes to "no session" rather than throwing.
- **The cookie strategy cannot revoke.** A stolen cookie stays valid until it expires, and mass
  invalidation means rotating the secret. Use a store when that matters.
- **`store: 'cache'` shares a blast radius** with application cache data: a `clear()` elsewhere logs
  everybody out. Keys are namespaced (`session:`), but a dedicated cache instance is the production
  recommendation.
- **Form CSRF here is a different mechanism** from `http-security-plugin`'s `csrfMiddleware`, not
  the same feature configured twice. That one is a stateless `Origin`/`Referer` check; this is a
  synchronizer token in session data. A progressive-enhancement `<Form>` post cannot set a custom
  header, so it can satisfy this and not that. Running both is intended — 270 then 275.
- **`multipart/form-data` bodies are not parsed** for the token; configure `csrf.headerName`.
  Parsing multipart would duplicate the storage plugin's parser, which this package may not import.
- **The `403` body does not disclose the reason.** It would tell an attacker whether the session or
  the token was at fault.
- **React Router** reaches the session through the Milestone 44 plugin's existing
  `populateLoadContext` hook, calling the same `getSession(ctx)`. No plugin imports another.
- A `session` health indicator reports `{ strategy, mode, keys, store }` and goes `down` when a
  configured store reports unhealthy. `onClose` closes the store.

---

## ReactRouterPlugin()

Embeds **React Router v7 framework mode** as a first-party plugin so a Hono Enterprise application
can serve a React frontend with Server-Side Rendering (SSR) and file-based routing. React Router's
framework-mode `createRequestHandler` is mounted behind a kernel catch-all route; static client
assets are served over `runtime.fs?.readFile`.

### Registration

```typescript
import { ReactRouterPlugin } from '@hono-enterprise/react-router-plugin';

app.register(ReactRouterPlugin({
  serverBuildPath: './build/server/index.js',
  assetsDir: './build/client/assets',
  assetUrlPrefix: '/assets/',
  basename: '/',
  mode: 'production',
}));
```

### Usage in Routes

The plugin registers its own catch-all route internally — the consumer does **not** manually
register SSR routes. The plugin owns all HTTP verbs at the configured `basename` pattern:

```typescript
import { CAPABILITIES, ISsrService } from '@hono-enterprise/common';

// The plugin handles SSR automatically at the catch-all.
// Custom routes take precedence based on static segment count:
// a custom route with MORE static segments wins over /* (e.g. /api/users/:id has 2, beats 1).
// Single-segment routes (e.g. /login, /health) registered AFTER ReactRouterPlugin
// tie with /* (both have 1 static segment) and are silently shadowed by SSR.
// Register single-segment routes BEFORE ReactRouterPlugin or use more-static routes.
app.router.get('/api/health', (ctx) => {
  return ctx.response.json({ status: 'ok' });
});
```

### Options

| Option                | Type                                                         | Default        | Description                                                                                           |
| --------------------- | ------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------- |
| `serverBuildPath`     | `string`                                                     | **(required)** | Path to the React Router Vite server build (default export = `ServerBuild`).                          |
| `loadRequestHandler`  | `(buildPath, mode) => Promise<SsrRuntime>`                   | omitted        | Injectable seam for lazy loading. When omitted, the default performs `await import(serverBuildPath)`. |
| `assetsDir`           | `string`                                                     | omitted        | Filesystem root of the built client bundle. Omit to disable the static-asset route.                   |
| `assetUrlPrefix`      | `string`                                                     | `/assets/`     | URL prefix for the asset route.                                                                       |
| `basename`            | `string`                                                     | `/`            | Mount prefix for the SSR catch-all. MUST match `react-router.config.ts` `basename` for flat routes.   |
| `populateLoadContext` | `(ctx: IRequestContext, context: RouterLoadContext) => void` | omitted        | Adds app values to the per-request React Router context, on top of the keys the plugin always sets.   |
| `mode`                | `'production' \| 'development'`                              | `'production'` | Passed to `createRequestHandler(build, mode)`.                                                        |

### Interface Reference

- `ISsrService.render(ctx): Promise<HandlerResult>` — delegates the request to React Router and
  writes back the result (streaming or buffered).
- `ReactRouterPlugin(options)` — returns an `IPlugin` with async `register()` that mounts the SSR
  catch-all, optional static-asset route, and a `react-router` health indicator.
- `createStaticAssetHandler({ fs, assetsDir, assetUrlPrefix })` — returns a `RouteHandler` for
  serving built client assets with immutable caching. Traversal containment: request paths
  containing `..` are rejected and every path is resolved under `assetsDir`; additionally, when the
  runtime provides `IFileSystem.realPath` (the Node/Deno/Bun adapters do), both the assets root and
  the target are canonicalized and the target must stay inside the root — so a symlink inside
  `assetsDir` pointing outside it is **not** served (404). When `realPath` is absent (edge
  runtimes), containment degrades to the lexical `..` guard.
- `assembleHandler(build, createRequestHandler, mode): SsrRequestHandler` — assembles an RR request
  handler from a pre-loaded `ServerBuild` and the `createRequestHandler` factory. Pure function;
  unit-testable without I/O.
- `loadRequestHandler(serverBuildPath, mode, options?): Promise<SsrRuntime>` — lazily imports the
  app-provided server build and `npm:react-router@8`, unwraps the `ServerBuild` (default export),
  and returns `{ handler, createLoadContext }`. Both come from the SAME module object so the
  provider instance is always an instance of the class the handler's `instanceof` check tests. The
  optional `options` parameter accepts `{ rrImportHook?: () => Promise<Record<string, unknown>> }` —
  a test-seam that replaces the `npm:react-router@8` import. Throws when the resolved module exposes
  no `RouterContextProvider` export (i.e. react-router earlier than 8).
- `createLoadContextFactory(rr): () => RouterLoadContext` — pure seam building the per-request
  context factory from a loaded `react-router` module namespace. **@throws** when the module has no
  `RouterContextProvider` export.
- `assertSsrRuntime(value): SsrRuntime` — validates an injected `loadRequestHandler` result during
  `register()`. **@throws** a message naming what was received when `handler` or `createLoadContext`
  is missing — notably for a bare handler function, the pre-`populateLoadContext` shape. Without
  this, a wrong-shaped seam registers cleanly and then fails every request with an opaque 500.
- `bridgeRequestToRR(ctx, handler, createLoadContext, populateLoadContext?): Promise<HandlerResult>`
  — bridges a kernel `IRequestContext` into a web `Request` (omitting the body for GET/HEAD), builds
  a fresh context provider, invokes the RR handler, and maps the resulting `Response` back onto
  `ctx.response`.
- `class SsrService implements ISsrService` — holds a resolved RR request handler, its
  `createLoadContext` factory, and the optional `populateLoadContext` hook; its `render(ctx)` method
  delegates to `bridgeRequestToRR` and returns the `HandlerResult`.
- `servicesContext: RouterContextKey<IServiceRegistry | null>` — context key holding the kernel
  service registry. Always set by the plugin.
- `userContext: RouterContextKey<IPrincipal | null>` — context key holding the authenticated
  principal, or `null` on an anonymous request.
- `contextKeyFor<T>(name, defaultValue): RouterContextKey<T>` — returns the key for a name,
  memoised, so the same name always yields the **same object**. Use it for any key an application
  declares for itself; see the note below on why a `{ defaultValue }` literal silently fails there.
- `interface RouterContextKey<T>` — `{ readonly defaultValue?: T }`. Structurally identical to React
  Router's `RouterContext<T>`, so keys from this package and keys from `createContext<T>()` are
  interchangeable.
- `interface RouterLoadContext` — `get<T>(key)` / `set<T>(key, value)`; the per-request `context`
  React Router passes to loaders, actions, and middleware.
- `interface SsrRuntime` —
  `{ handler: SsrRequestHandler; createLoadContext: () => RouterLoadContext }`.
- `type PopulateLoadContext` — `(ctx: IRequestContext, context: RouterLoadContext) => void`.

### Reading the load context in a route module

```typescript
import { servicesContext, userContext } from '@hono-enterprise/react-router-plugin';
import { CAPABILITIES, type ILogger } from '@hono-enterprise/common';

export async function loader({ context }: Route.LoaderArgs) {
  const services = context.get(servicesContext);
  const user = context.get(userContext); // null when anonymous
  services?.get<ILogger>(CAPABILITIES.LOGGER).info('ssr loader');
  return { user };
}
```

### Declaring your own context keys

An application that puts its own values on the request context — a session, a CSRF token, a service
it resolved once — must create those keys with `contextKeyFor`, not with a `{ defaultValue }`
literal:

```typescript
// app/lib/context-keys.server.ts
import { contextKeyFor } from '@hono-enterprise/react-router-plugin';
import type { ISession } from '@hono-enterprise/common';

export const sessionContext = contextKeyFor<ISession | null>('app.session', null);
```

Keys are matched by **identity**, and in a framework-mode application the declaring module reliably
exists twice: Vite inlines application modules into the server build, while the runtime loads
`honoe.config.ts` from source. Two hand-written key objects then look identical and match nothing —
`context.get()` returns the default, so a session reads as `null` and a CSRF token as an empty
string, with no error anywhere. Resolving by name through this package gives both copies the same
object.

That guarantee needs this package to be a **single module instance**, which means the server build
must treat `@hono-enterprise/*` as external:

```typescript
// vite.config.ts
export default defineConfig({
  environments: {
    ssr: {
      build: {
        rollupOptions: { external: ['@hono-enterprise/react-router-plugin'] },
      },
    },
  },
});
```

Declared under `environments.ssr.build`, deliberately: React Router builds through Vite's
Environment API, and neither a top-level `ssr.external` nor `environments.ssr.resolve.external`
reaches that build. `honoe new --template full-stack` emits all of this already.

The same externalisation is what lets a **server-only** module (`*.server.ts`) import a framework
package by value at all. Client-reachable modules must stick to `import type`, which is erased: the
client bundle has to inline what it imports and cannot resolve a JSR specifier.

### Notes

- **The React Router `context` is a real `RouterContextProvider`.** React Router 8 checks
  `initialContext instanceof RouterContextProvider` inside `createRequestHandler` and answers
  `500 Unexpected Server Error` for anything else — it does not degrade — and the static handler
  repeats the check nominally whenever route middleware runs. The plugin therefore constructs the
  provider from the same `react-router` module the handler came from. **Breaking change
  (unreleased):** the `getLoadContext` option and the `LoadContextFunction` type are removed,
  because a function returning `Record<string, unknown>` cannot produce a valid context under any
  wrapping. Migrate by mutating the provider instead of returning an object, and reading values
  through context keys:

  ```typescript
  // Before — produced a 500 on every SSR request against react-router@8.
  ReactRouterPlugin({
    serverBuildPath,
    getLoadContext: (ctx) => ({ db: myDb, user: ctx.request.user }),
  });

  // After
  import { createContext } from 'react-router';
  export const dbContext = createContext<Db | null>(null);

  ReactRouterPlugin({
    serverBuildPath,
    populateLoadContext: (_ctx, context) => context.set(dbContext, myDb),
  });
  // `servicesContext` and `userContext` are already set — populateLoadContext augments, never replaces.
  ```

- **Vite is never imported _by the plugin_.** In production the app feeds this plugin a compiled
  build; Vite stays an app-level, build-time concern. For a development loop with HMR and React Fast
  Refresh, the app runs Vite in-process and supplies a `loadRequestHandler` that returns a handler
  over a build thunk — no plugin change required. See
  [docs/react-router-dev.md](docs/react-router-dev.md) for the verified recipe, including the
  `base`-prefix proxy route and the version pins React Router requires.
- **`@react-router/node` is excluded.** Only core `react-router` (`createRequestHandler`) is lazy
  imported. `@react-router/node`'s `installGlobals()` is unnecessary on web-standard runtimes.
- **Static-asset serving uses `runtime.fs?.readFile`.** On edge platforms where `fs` is absent,
  assets degrade to a 404. SSR document rendering still works.
- **File-based routing (`flatRoutes`) is supported transparently.** It is baked into the compiled
  `ServerBuild` by the React Router Vite plugin at build time — M44 serves it without any plugin
  surface.
- `@react-router/fs-routes` (if used) is an app-level `devDependency`, never imported by the plugin.

---

## WorkerPoolPlugin()

Runs CPU-bound work (image processing, report generation, large data transforms) on **real worker
threads**, off the event loop, behind the capability model. Registers an `IWorkerPool` under
`CAPABILITIES.WORKER_POOL`. Task handlers are addressed by **module specifier**, never by closure —
closures cannot cross a thread boundary. Inputs and outputs travel by structured clone.

### Registration

```typescript
import { WorkerPoolPlugin } from '@hono-enterprise/worker-pool-plugin';

app.register(WorkerPoolPlugin({
  defaultPoolSize: 4, // default: runtime.workers.availableParallelism()
  taskTimeoutMs: 10_000, // default: 30_000; 0 disables
  maxQueue: 1024, // default: 1024
  pools: {
    // per-task-module overrides, keyed by the specifier passed to run()
    'file:///app/tasks/resize.ts': { size: 2, taskTimeoutMs: 60_000 },
  },
}));
```

### Authoring a task module

A task module is an ES module **your application owns**. It registers its handler at module top
level with `defineWorkerTask` from the runtime package's `./worker` subpath:

```typescript
// tasks/resize-image.ts — runs on a worker thread
import { defineWorkerTask } from '@hono-enterprise/runtime/worker';

defineWorkerTask<Uint8Array, Uint8Array>(async (imageBytes) => {
  return await resize(imageBytes);
});
```

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IWorkerPool } from '@hono-enterprise/common';

app.router.post('/thumbnail', async (ctx) => {
  const pool = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
  const bytes = await ctx.request.bytes();
  const thumb = await pool.run<Uint8Array, Uint8Array>(
    new URL('./tasks/resize-image.ts', import.meta.url).href,
    bytes,
    { timeoutMs: 15_000 }, // optional per-call timeout override
  );
  return ctx.response.header('content-type', 'image/png').send(thumb);
});
```

### Options

| Option            | Type                              | Default                  | Description                                            |
| ----------------- | --------------------------------- | ------------------------ | ------------------------------------------------------ |
| `defaultPoolSize` | `number`                          | `availableParallelism()` | Workers per pool.                                      |
| `maxQueue`        | `number`                          | `1024`                   | Pending-task bound per pool; exceeding it throws.      |
| `taskTimeoutMs`   | `number`                          | `30000`                  | Per-task timeout; `0` disables. Timed-out worker dies. |
| `pools`           | `Record<string, TaskPoolOptions>` | `{}`                     | Per-module `{ size?, maxQueue?, taskTimeoutMs? }`.     |
| `host`            | `IWorkerHost`                     | `runtime.workers`        | Injected host, wins over the runtime's; for tests.     |

### Interface Reference

- `IWorkerPool.run<TInput, TOutput>(taskModule, input, options?): Promise<TOutput>` — run a task,
  creating the pool for `taskModule` lazily on first use.
- `IWorkerPool.stats(): readonly TaskPoolStats[]` — one snapshot per pool
  (`{ taskModule, workers, busy, queued, completed, failed }`).
- `IWorkerPool.shutdown(): Promise<void>` — terminate every worker, reject pending tasks (called by
  the plugin's `onClose`).

### Errors (exported for `instanceof`)

- `WorkerPoolUnavailableError` — the runtime has no worker support (e.g. Cloudflare Workers) or the
  pool was shut down.
- `WorkerTaskError` — the task handler threw, or the worker crashed; carries `taskModule`,
  `remoteName`, and `remoteStack`.
- `WorkerTaskTimeoutError` — the task exceeded its timeout; the worker was terminated and replaced.
  Carries `taskModule` and `timeoutMs`.
- `WorkerQueueFullError` — the pool's pending queue is at its bound. Carries `taskModule` and
  `limit`.

### Notes

- **Runtime support.** Threads come from `IRuntimeServices.workers`, implemented on Node
  (`node:worker_threads`), Deno, and Bun (web `Worker`). On **Cloudflare Workers** there are no
  threads: the plugin still registers, but `run()` rejects with `WorkerPoolUnavailableError` and the
  health indicator reports `available: false`. One codebase deploys everywhere.
- **Error vs crash.** A thrown handler is a healthy worker reporting failure (`WorkerTaskError`, the
  worker is retained). A worker-level crash drops the worker and re-dispatches its queued work to
  survivors. A timeout terminates and replaces the worker (in-flight JS cannot be cancelled).
- **Structured clone only.** `input`/`output` must be structured-clonable — no functions or class
  instances. A clone failure surfaces as a rejected `run()`.
- **Node `.ts` task modules** need an app-level loader/build, exactly as the frontend build is the
  app's responsibility (AI_GUIDELINES §12.2); the plugin consumes the module specifier as given.
- Health indicator `worker-pool` reports `{ available, pools }`.

---

## SecretsPlugin()

Provides secret management: registers an `ISecretManager` under `CAPABILITIES.SECRETS`, backed by a
pluggable provider with a monotonic-clock read-through cache. The default provider is `'env'`
(zero-dependency, every runtime). No cloud SDK is a hard dependency — each cloud provider accepts an
injected client facade or lazily imports its SDK (AI_GUIDELINES §12.2). Secret values are never
logged.

### Registration

```typescript
import { SecretsPlugin } from '@hono-enterprise/secrets-plugin';

// Environment variables (default provider)
app.register(SecretsPlugin());

// HashiCorp Vault (KV v2, over fetch — zero dependency)
app.register(SecretsPlugin({
  provider: 'vault',
  options: { address: 'https://vault.example.com', token: vaultToken, mount: 'secret' },
}));

// AWS Secrets Manager (KMS-backed)
app.register(SecretsPlugin({ provider: 'aws-kms', options: { region: 'us-east-1' } }));
```

> `provider: 'aws-kms'` retrieves named secrets from AWS Secrets Manager, which encrypts values with
> AWS KMS. KMS alone cannot store/retrieve named secrets by path, so `get`/`rotate` go through
> Secrets Manager.

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ISecretManager } from '@hono-enterprise/common';

const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
const dbPassword = await secrets.get('database/password'); // env: DATABASE_PASSWORD
const exists = await secrets.has('database/password');
await secrets.rotate('database/password', newPassword); // throws for the env provider
```

### Options

| Option                                               | Provider                | Description                                                    |
| ---------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `provider`                                           | —                       | `'env'` (default), `'aws-kms'`, `'gcp'`, `'azure'`, `'vault'`. |
| `options.cacheTtl`                                   | all                     | Read-cache TTL in seconds; `0` disables. Default `300`.        |
| `options.prefix`                                     | `env`                   | Prefix prepended to the derived env key.                       |
| `options.region` / `accessKeyId` / `secretAccessKey` | `aws-kms`               | AWS client config (ignored when `client` injected).            |
| `options.projectId`                                  | `gcp`                   | GCP project id for resource paths.                             |
| `options.vaultUrl`                                   | `azure`                 | Key Vault URL.                                                 |
| `options.address` / `token` / `mount`                | `vault`                 | Vault server address, token, KV mount (default `secret`).      |
| `options.client`                                     | `aws-kms`/`gcp`/`azure` | Injected structural client facade (bypasses lazy import).      |
| `options.http`                                       | `vault`                 | Injected `fetch`-shaped function (defaults to global `fetch`). |

### Exports

- `SecretsPlugin(options?)` — plugin factory.
- `SecretsService` — the `ISecretManager` implementation (provider + read cache).
- `EnvProvider`, `AwsKmsProvider`, `GcpSecretManagerProvider`, `AzureKeyVaultProvider`,
  `HashiCorpVaultProvider` — provider classes.
- `SecretsServiceOptions`, `SecretsPluginOptions`, `SecretsProviderType`, `SecretsProviderOptions`,
  `AwsKmsProviderOptions`, `GcpSecretManagerProviderOptions`, `AzureKeyVaultProviderOptions`,
  `HashiCorpVaultProviderOptions` — option types.
- `IAwsSecretsClient`, `IGcpSecretsClient`, `IAzureSecretsClient`, `IVaultHttp` — structural
  injection types.
- `ISecretManager` — re-exported from `@hono-enterprise/common` (`get` / `has` / `rotate`).

### Notes

- `EnvProvider` is read-only: `rotate()` and provider `set` throw, since environment variables
  cannot be mutated at runtime. It reads env through `IRuntimeServices.env`, resolving Workers/Deno
  bindings.
- Secret names use provider-specific path syntax; `EnvProvider` maps a name to an env key by
  uppercasing and replacing `/`, `-`, `.` with `_` (e.g. `database/password` → `DATABASE_PASSWORD`).

---

## AuditPlugin()

Provides an immutable audit trail: registers an `IAuditLogger` under `CAPABILITIES.AUDIT`, backed by
a pluggable storage backend. `log()` stamps each entry with an internally assigned `id`
(`runtime.uuid()`) and wall-clock `timestamp` (`runtime.now()`), deep-freezes the record
(immutability), then appends it to storage. The default backend is `'memory'` (zero-dependency, runs
on every runtime including Cloudflare Workers) — **non-durable**, so production should select
`'log'`, `'database'`, or `'file'`. No database driver is a hard dependency: the `'database'`
backend takes an injected client facade (`IAuditDbClient`), never the `database` capability token.

### Registration

```typescript
import { AuditPlugin } from '@hono-enterprise/audit-plugin';

// In-memory (default — non-durable)
app.register(AuditPlugin());

// Route records through the resolved logger
app.register(AuditPlugin({ storage: 'log', options: { level: 'info' } }));

// Persist to a database via an injected client (inject-only)
app.register(
  AuditPlugin({ storage: 'database', options: { client: myDbClient, table: 'audit_logs' } }),
);

// Append JSONL to a file (Node/Deno/Bun only — requires runtime.fs)
app.register(AuditPlugin({ storage: 'file', options: { path: './audit.log' } }));
```

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IAuditLogger } from '@hono-enterprise/common';

const audit = ctx.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
await audit.log({
  action: 'user.delete',
  resource: 'user',
  resourceId: '123',
  userId: ctx.request.user?.id,
  result: 'success',
  before: { active: true },
  after: { active: false },
});
```

`IAuditLogger` is write-only (like `ILogger`); `AuditEntry` is the write shape and carries no
`id`/`timestamp`. Stored records add both internally and are immutable once written. Retrieval is
not part of the public capability this milestone.

### Options

| Option           | Backend    | Description                                                                                    |
| ---------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `storage`        | —          | `'memory'` (default), `'log'`, `'database'`, `'file'`. Unknown values throw at registration.   |
| `options.level`  | `log`      | Logger method to emit at: `'info'` (default), `'warn'`, or `'error'`.                          |
| `options.logger` | `log`      | Injected `ILogger` overriding `ctx.logger` (throws at registration when neither is present).   |
| `options.client` | `database` | Injected `IAuditDbClient`; required for `'database'` (throws when absent).                     |
| `options.table`  | `database` | Table name for `insert`/`select`; default `'audit_logs'`.                                      |
| `options.path`   | `file`     | JSONL file path; default `'./audit.log'` (throws at registration when `runtime.fs` is absent). |

### Exports

- `AuditPlugin(options?)` — plugin factory.
- `AuditService` — the `IAuditLogger` implementation (stamps `id`/`timestamp`, deep-freezes,
  delegates to storage).
- `MemoryAuditStorage`, `LogAuditStorage`, `DatabaseAuditStorage`, `FileAuditStorage` — storage
  backend classes (exported for direct construction/injection).
- `AuditPluginOptions`, `AuditStorageType`, `AuditStorageOptions` — option types.
- `IAuditDbClient` — structural database client facade for the `'database'` backend
  (`insert(table, row)` / `select(table, criteria?)`).
- `IAuditLogger`, `AuditEntry` — re-exported from `@hono-enterprise/common`.

### Notes

- The `'memory'` backend is **non-durable** (in-process array, lost on restart). It is the
  zero-dependency default so audit works on every runtime out of the box; select a durable backend
  for production.
- The `'log'` backend's `query()` returns `[]` — the log sink is the durable trail; read audit
  records through the logging backend, not this object.
- The `'file'` backend uses read-modify-write over `runtime.fs` (the committed `IFileSystem` has no
  native append) and serializes concurrent appends; on shutdown the plugin's `onClose` drains any
  in-flight write. The target file's parent directory is created recursively on first write, so a
  `path` in a not-yet-existing directory does not fail with `ENOENT`.
- The `'database'` backend delegates equality filtering (`action`/`resource`/`result`/`userId`/
  `resourceId`) to the injected client's `select` WHERE; time-range (`from`/`to`), ordering, and
  `limit` are applied in-process.

---

## CQRS

Provides command/query separation with buses.

### Registration

```typescript
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
import type { CqrsRequest, IPipelineBehavior } from '@hono-enterprise/common';

// Example behavior implementations
const loggingBehavior: IPipelineBehavior = {
  handle: async (request: CqrsRequest, next: () => Promise<unknown>) => {
    console.log(`Executing ${request.type}`);
    const result = await next();
    console.log(`Completed ${request.type}`);
    return result;
  },
};

const timingBehavior: IPipelineBehavior = {
  handle: async (request: CqrsRequest, next: () => Promise<unknown>) => {
    const start = Date.now();
    const result = await next();
    console.log(`${request.type} took ${Date.now() - start}ms`);
    return result;
  },
};

app.register(CqrsPlugin({
  behaviors: [loggingBehavior, timingBehavior],
}));
```

### Defining Commands and Queries

```typescript
import type { CqrsCommand, CqrsQuery } from '@hono-enterprise/cqrs-plugin';

// A request is routed by its string `type`; `data` carries the payload.
// Both a class instance (below) and a plain `{ type, data }` object satisfy the contract.
class CreateUserCommand implements CqrsCommand<{ name: string; email: string }> {
  readonly type = 'CreateUserCommand';
  constructor(public readonly data: { name: string; email: string }) {}
}

class GetUserQuery implements CqrsQuery<{ id: string }> {
  readonly type = 'GetUserQuery';
  constructor(public readonly data: { id: string }) {}
}
```

### Implementing Handlers

```typescript
import type { ICommandHandler, IQueryHandler } from '@hono-enterprise/cqrs-plugin';

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
  const userId = await commandBus.execute<string>(new CreateUserCommand(ctx.request.body));
  return ctx.response.status(201).json({ id: userId });
});

app.router.get('/users/:id', async (ctx) => {
  const queryBus = ctx.services.get<IQueryBus>('query-bus');
  const user = await queryBus.execute<User>(new GetUserQuery({ id: ctx.params.id }));
  return ctx.response.json(user);
});
```

---

## Messaging

Provides message broker abstraction for cross-service integration events.

### Registration

````typescript
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';

// In-memory broker (for development/testing)
app.register(MessagingPlugin({
  broker: 'memory',
}));

// Redis Streams broker
app.register(MessagingPlugin({
  broker: 'redis-streams',
  url: config.get('REDIS_URL'),
  defaultQueue: 'myapp-events',
}));

### Plugin Options

```typescript
interface MessagingPluginOptions {
  /** Broker type. @defaultValue 'memory' */
  broker?: 'memory' | 'redis-streams' | 'rabbitmq' | 'nats' | 'kafka';
  /** Instance name for multi-instance support (registers under messaging.<name>). */
  name?: string;
  /** Serializer for message payloads. @defaultValue new JsonSerializer() */
  serializer?: ISerializer;
  /** Connection URL (redis-streams / rabbitmq / nats). */
  url?: string;
  /** Injected client — bypasses the lazy npm import. Type depends on broker. */
  client?: IRedisStreamsClient | IAmqpConnection | INatsConnection | IKafkaFactory;
  /** Default consumer group / queue name. @defaultValue 'messaging-consumers' */
  defaultQueue?: string;
  /** Redis Streams poll interval in ms. @defaultValue 100 */
  pollIntervalMs?: number;
  /** Redis Streams XREADGROUP block timeout in ms. @defaultValue 100 */
  blockSizeMs?: number;
  /** RabbitMQ exchange name. @defaultValue 'messaging' */
  exchangeName?: string;
  /** NATS JetStream stream name. @defaultValue 'MESSAGING' */
  streamName?: string;
  /** Kafka bootstrap brokers. @defaultValue ['localhost:9092'] */
  brokers?: readonly string[];
  /** Kafka client ID. @defaultValue 'messaging-client' */
  clientId?: string;
  /** Kafka request-reply topic; must already exist. @defaultValue 'messaging.replies' */
  replyTopic?: string;
}
````

### Publishing Messages

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';

app.router.post('/orders', async (ctx) => {
  const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const order = await createOrder(ctx.request.body);

  await broker.publish('order.created', {
    orderId: order.id,
    total: order.total,
    customerId: order.customerId,
  });

  return ctx.response.status(201).json(order);
});
```

### Subscribing to Messages

```typescript
app.register({
  name: 'order-processor',
  version: '1.0.0',
  dependencies: [CAPABILITIES.MESSAGING],
  register(ctx) {
    const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    broker.subscribe('order.created', async (message, metadata) => {
      console.log('Processing order', message.orderId);
      await processOrder(message);
    }, {
      queue: 'order-processor',
    });
  },
});
```

### Request-Reply (RPC)

Beyond fire-and-forget `publish`/`subscribe`, the broker supports **brokered request-reply**: a
caller sends a request and awaits a single correlated reply. A responder registered with `respond`
returns the reply value; correlation, the reply channel, and timeout are handled internally.

```typescript
// Responder side — its resolved value is returned to the caller.
const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
await broker.respond<{ userId: string }, { name: string }>('user.lookup', async (req) => {
  const user = await users.findById(req.userId);
  return { name: user.name };
});

// Caller side — resolves with the responder's reply.
const reply = await broker.request<{ userId: string }, { name: string }>(
  'user.lookup',
  { userId: '42' },
  { timeoutMs: 3000 }, // defaults to 5000 when omitted
);
```

Signatures (on `IMessageBroker`, from `@hono-enterprise/common`):

```typescript
interface RequestOptions {
  /** Reply wait budget in ms. @defaultValue 5000 */
  readonly timeoutMs?: number;
}

type RequestHandler<TReq = unknown, TRes = unknown> = (
  message: TReq,
  metadata: MessageMetadata,
) => TRes | Promise<TRes>;

request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes>;
respond<TReq, TRes>(
  topic: string,
  handler: RequestHandler<TReq, TRes>,
  options?: SubscribeOptions,
): Promise<ISubscription>;
```

Pass `options.queue` to `respond` to load-balance requests across competing responders.

`request` rejects with one of three exported error classes (import from
`@hono-enterprise/messaging-plugin` for `instanceof` handling):

| Error                        | Thrown when                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `RequestTimeoutError`        | No reply arrived within `timeoutMs`.                                             |
| `RemoteHandlerError`         | The responder threw; `.remoteMessage` carries the remote message.                |
| `MessagingNotSupportedError` | **Deprecated — no broker throws this.** Retained for `instanceof` compatibility. |

> **Broker support.** Request-reply is available on **all five** brokers — in-memory, Redis Streams,
> RabbitMQ, NATS, and Kafka.
>
> **Kafka has one operational prerequisite.** Replies travel on a shared reply topic (`replyTopic`,
> default `'messaging.replies'`) which **must already exist** — the broker creates no topics, so
> either pre-create it or enable `auto.create.topics.enable`. Each broker instance reads that topic
> under its own consumer group, so every instance receives every reply and discards those it did not
> originate; give a high-traffic service its own `replyTopic` to bound that fan-out.

> **RPC and pub/sub are separate channels.** `request`/`respond` travel on a channel derived from
> the topic, not on the topic itself. A plain `subscribe('orders', …)` therefore never observes an
> RPC request, and a plain `publish('orders', …)` is never consumed by a responder on `'orders'`.
> The two can share a topic name safely.

### Multiple Broker Instances

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';

app.register(MessagingPlugin({
  broker: 'redis-streams',
  name: 'events',
  url: config.get('EVENTS_REDIS_URL'),
  defaultQueue: 'events',
}));

app.register(MessagingPlugin({
  broker: 'redis-streams',
  name: 'audit',
  url: config.get('AUDIT_REDIS_URL'),
  defaultQueue: 'audit',
}));

// Access by namespaced token
const eventsBroker = ctx.services.get<IMessageBroker>('messaging.events');
const auditBroker = ctx.services.get<IMessageBroker>('messaging.audit');
```

### Events Messaging Bridge

The `EventsMessagingBridge` forwards domain events from `EventsPlugin` to a messaging broker:

```typescript
import { EventsMessagingBridge } from '@hono-enterprise/messaging-plugin';

app.register(EventsMessagingBridge({
  eventTypes: ['user.created', 'user.updated'],
  token: CAPABILITIES.MESSAGING,
  topicMapping: (eventType) => eventType.toLowerCase(),
  errorHandler: (error, eventType) => {
    console.error(`Failed to forward ${eventType}:`, error);
  },
}));
```

### Exports

```typescript
// Plugin factories
export { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
export { EventsMessagingBridge } from '@hono-enterprise/messaging-plugin';

// Broker implementations
export { InMemoryBroker } from '@hono-enterprise/messaging-plugin';
export { RedisStreamsBroker } from '@hono-enterprise/messaging-plugin';
export { RabbitMqBroker } from '@hono-enterprise/messaging-plugin';
export { NatsBroker } from '@hono-enterprise/messaging-plugin';
export { KafkaBroker } from '@hono-enterprise/messaging-plugin';

// Serializer
export { JsonSerializer } from '@hono-enterprise/messaging-plugin';
export type { ISerializer } from '@hono-enterprise/messaging-plugin';

// Option types
export type {
  EventsMessagingBridgeOptions,
  KafkaOptions,
  MessagingBrokerType,
  MessagingPluginOptions,
  NatsOptions,
  RabbitMqOptions,
  RedisStreamsOptions,
} from '@hono-enterprise/messaging-plugin';

// Re-exported types from @hono-enterprise/common
export type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from '@hono-enterprise/messaging-plugin';
```

> **Kafka Commit Model:** Kafka uses the producer/consumer commit model — handler success
> auto-commits; a thrown handler prevents commit.

---

## Queue

Provides background job queue with Memory and Redis adapters.

### Exports

- **`QueuePlugin`** — Plugin factory for registering the queue service
- **`QueueAdapterType`** — `'memory' | 'redis' | 'rabbitmq'`
- **`QueuePluginOptions`** — Plugin configuration options (includes `client`, `url`, `prefix?`)
- **`MemoryQueue`** — In-memory queue adapter for development/testing
- **`RedisQueue`** — Redis-backed queue adapter for production
- **`RedisQueueOptions`** — Redis adapter configuration
- **`RabbitMqQueue`** — RabbitMQ queue adapter via amqplib (polling via basicGet, TTL+DLX for
  delays)
- **`RabbitMqQueueOptions`** — RabbitMQ adapter configuration (includes `url`, `client`, `prefix?`)
- **`IQueue`** — Queue service interface (re-exported from `@hono-enterprise/common`)
- **`IJob<T>`** — Job interface (re-exported)
- **`JobProcessor<T>`** — Job processor type (re-exported)
- **`AddJobOptions`** — Options for `queue.add()` (re-exported)
- **`ProcessOptions`** — Options for `queue.process()` (re-exported)
- **`RecurringOptions`** — Options for `queue.addRecurring()` (re-exported)
- **`QueueLogger`** — Minimal `error`/`warn` logger surface the service reports background failures
  through (structurally compatible with `ILogger`)

### Registration

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

// Memory adapter (development/testing)
app.register(QueuePlugin({
  adapter: 'memory',
  pollIntervalMs: 1000,
  defaultMaxAttempts: 3,
}));

// Redis adapter (production)
app.register(QueuePlugin({
  adapter: 'redis',
  url: config.get('REDIS_URL'),
  pollIntervalMs: 1000,
  defaultMaxAttempts: 3,
}));

// Named instance for multi-queue support
app.register(QueuePlugin({
  adapter: 'memory',
  name: 'background',
  pollIntervalMs: 2000,
}));

// RabbitMQ adapter (production, requires amqplib)
app.register(QueuePlugin({
  adapter: 'rabbitmq',
  url: config.get('RABBITMQ_URL'),
  prefix: 'myapp.queue',
  pollIntervalMs: 1000,
  defaultMaxAttempts: 3,
}));
```

### Adding Jobs

```typescript
import type { AddJobOptions, IQueue } from '@hono-enterprise/queue-plugin';

app.router.post('/users', async (ctx) => {
  const queue = ctx.services.get<IQueue>('queue');
  const user = await createUser(ctx.request.body);

  // Add a background job
  await queue.add('send-welcome-email', {
    userId: user.id,
    email: user.email,
  });

  // Add a delayed job (delayMs in milliseconds)
  await queue.add('send-reminder', {
    userId: user.id,
  }, { delayMs: 86400000 }); // 24 hours

  // Add with custom max attempts
  const options: AddJobOptions = { maxAttempts: 5 };
  await queue.add('process-payment', paymentData, options);

  return ctx.response.status(201).json(user);
});
```

### Processing Jobs

```typescript
import type { IJob, IQueue } from '@hono-enterprise/queue-plugin';

app.register({
  name: 'job-processors',
  version: '1.0.0',
  dependencies: ['queue', 'mail'],
  register(ctx) {
    const queue = ctx.services.get<IQueue>('queue');

    queue.process('send-welcome-email', async (job: IJob<{ userId: string; email: string }>) => {
      await sendEmail({
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
import type { IQueue, RecurringOptions } from '@hono-enterprise/queue-plugin';

const queue = ctx.services.get<IQueue>('queue');

// Every hour using cron expression
const hourlyOptions: RecurringOptions = { cron: '0 * * * *' };
await queue.addRecurring('cleanup-old-sessions', {}, hourlyOptions);

// Every day at 9 AM
await queue.addRecurring('daily-report', { type: 'summary' }, { cron: '0 9 * * *' });
```

### Failure Reporting

The worker loop, the recurring-schedule loop, and the job runner all report failures through the
`logger` capability when one is registered — a failing job logs at `error` with the job id, name,
attempt count and the retry delay (or the dead-letter decision), and an adapter outage logs the poll
failure. Nothing is required: with no `LoggerPlugin` registered the queue keeps running and reports
nowhere, and a throwing logger can never take the worker loop down.

### Dead-Lettered Jobs

A job that fails on its final attempt is dead-lettered and never delivered again. `MemoryQueue`
exposes its dead set for assertions in tests; the Redis transport keeps its dead set in Redis, and
the RabbitMQ transport keeps its dead set in a per-name dead queue (`he.queue.<name>.dead`).

```typescript
import { MemoryQueue } from '@hono-enterprise/queue-plugin';

const adapter = new MemoryQueue();
// ... jobs fail through all their attempts ...

// getDeadLetters<T>(name: string): readonly StoredJob<T>[]
const dead = adapter.getDeadLetters('send-email');
console.log(dead.length, dead[0]?.attempts); // 1 3
```

### Type Reference

```typescript
// AddJobOptions
interface AddJobOptions {
  readonly delayMs?: number; // Delay before job becomes available (ms)
  readonly maxAttempts?: number; // Maximum retry attempts (default: 3)
}

// ProcessOptions
interface ProcessOptions {
  readonly concurrency?: number; // Jobs processed concurrently (default: 1)
}

// RecurringOptions
interface RecurringOptions {
  readonly cron: string; // Cron expression (e.g., '0 * * * *')
}

// IJob<T>
interface IJob<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly attempts: number;
}

// IQueue interface
interface IQueue {
  add<T>(name: string, data: T, options?: AddJobOptions): Promise<string>;
  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void;
  addRecurring<T>(name: string, data: T, options: RecurringOptions): Promise<void>;
}
```

---

## Scheduler

Provides cron jobs, fixed-interval recurring jobs, and one-shot delayed jobs, with retry and
distributed locking.

Registers `IScheduler` under `CAPABILITIES.SCHEDULER` (`'scheduler'`).

Execution is in-process and time-driven — jobs are **not** durably persisted, so a restart drops the
schedule until the registering plugin re-creates it. For durable background work, use
[Queue](#queue) instead.

### Exports

- **`SchedulerPlugin`** — Plugin factory for registering the scheduler service
- **`SchedulerPluginOptions`** — Plugin configuration options (`timezone?`, `distributedLock?`)
- **`DistributedLockOptions`** — Lock configuration (`enabled?`, `storage?`, `url?`, `client?`,
  `lock?`, `ttlMs?`)
- **`IDistributedLock`** — Lock seam (`acquire`/`release`) for a custom lock implementation
- **`IRedisLockClient`** — Structural ioredis shape accepted by `distributedLock.client`
- **`IScheduler`** — Scheduler service interface (re-exported from `@hono-enterprise/common`)
- **`ScheduledJob<T>`** — Job instance handed to the handler (re-exported)
- **`SchedulerJobHandler<T>`** — Handler callback type (re-exported)
- **`ScheduleOptions<T>`** — Options for `cron()`/`every()`/`delay()` (re-exported)
- **`RetryOptions`** — Retry configuration (re-exported)
- **`SchedulerBackoff`** — `'fixed' | 'exponential'` (re-exported)

### Registration

```typescript
import { SchedulerPlugin } from '@hono-enterprise/scheduler-plugin';

// Process-local locking (default)
app.register(SchedulerPlugin());

// Distributed locking via Redis, for multi-instance deployments
app.register(SchedulerPlugin({
  timezone: 'UTC',
  distributedLock: {
    enabled: true,
    storage: 'redis',
    url: config.get('REDIS_URL'),
    ttlMs: 30000,
  },
}));
```

`timezone` defaults to `'UTC'`, and `'UTC'` is the only supported value — any other value **throws**
from the factory. Cron expressions are always evaluated in UTC.

When `distributedLock` is absent or `enabled: false`, a process-local memory lock is used. With
`enabled: true` and `storage: 'redis'`, an ioredis client is lazily imported (`npm:ioredis@5.x`)
unless you inject one via `client`, or supply your own `IDistributedLock` via `lock` (which takes
priority over `storage`). `ttlMs` defaults to `30000` and must exceed the job's worst-case runtime —
if the lock expires mid-run, another instance may start the same job.

### Scheduling Jobs

```typescript
import type { IScheduler } from '@hono-enterprise/common';

app.register({
  name: 'scheduled-jobs',
  version: '1.0.0',
  dependencies: ['scheduler'],
  async register(ctx) {
    const scheduler = ctx.services.get<IScheduler>('scheduler');

    // Cron expression (5-field, UTC)
    await scheduler.cron('cleanup-temp-files', '0 2 * * *', async () => {
      await cleanupTempFiles();
    });

    // Every 5 minutes
    await scheduler.every('health-check', 300000, async () => {
      await runHealthCheck();
    });

    // One-time delayed job — auto-removed once it fires
    await scheduler.delay('send-followup', 86400000, async (job) => {
      await sendFollowupEmail(job.data.userId);
    }, { data: { userId: '123' } });

    // With retry
    await scheduler.cron('sync-external-api', '*/30 * * * *', async () => {
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

Every scheduling call is async and **throws** if `name` is already scheduled. Job names are unique
per scheduler instance.

Cron expressions use the standard 5 fields (`minute hour day-of-month month day-of-week`) and
support `*`, lists (`1,15`), ranges (`1-5`), and steps (`*/30`, `1-59/2`). An invalid field or
expression throws.

### Retry Behavior

Without `retry`, a handler that throws runs once and the failure is logged. With `retry`, the job is
re-attempted up to `limit` **total** attempts (`limit: 3` means at most 3 runs, not 3 retries after
the first). `delay` is the base delay in milliseconds before the first retry; `backoff: 'fixed'`
reuses it unchanged, while `backoff: 'exponential'` doubles it per attempt. `job.attempts` is
1-based and increments on each attempt. A job that exhausts its retries is logged and does not crash
the scheduler; recurring jobs still fire on their next scheduled tick.

### Managing Jobs

```typescript
const scheduler = ctx.services.get<IScheduler>('scheduler');

// Pause (idempotent — pausing a paused job is a no-op)
await scheduler.pause('cleanup-temp-files');

// Resume (idempotent — resuming a running job is a no-op)
await scheduler.resume('cleanup-temp-files');

// Remove
await scheduler.remove('cleanup-temp-files');

// Next run time, as epoch milliseconds
const nextRun = await scheduler.getNextRun('cleanup-temp-files');
```

All four **throw** if no job with that name exists — including after a `delay` job has fired and
auto-removed itself. `getNextRun` additionally throws if the job is currently paused.

`resume` re-arms from the current time rather than resuming the original countdown: cron jobs
compute the next fire from now, `every` jobs restart the interval from now, and `delay` jobs re-arm
the **full** original `delayMs` from now.

### IScheduler Interface

```typescript
interface IScheduler {
  cron<T>(
    name: string,
    expression: string,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;
  every<T>(
    name: string,
    intervalMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;
  delay<T>(
    name: string,
    delayMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void>;
  pause(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  getNextRun(name: string): Promise<number>;
}

interface ScheduledJob<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly attempts: number;
}
```

The plugin registers a `'scheduler'` health indicator and an `onClose` hook that clears all armed
timers and disconnects the Redis lock on shutdown.

---

## Resilience

Composes four pure, in-process resilience patterns — circuit breaker, retry with backoff, timeout,
and bulkhead — around an arbitrary `() => Promise<T>`. Zero external dependencies.

Registers `IResilienceService` under `CAPABILITIES.RESILIENCE` (`'resilience'`).

The service is stateless at the plugin level: it holds no timers, connections, or global state, so
it registers **no health indicator and no `onClose` hook**. `wrap` builds the pattern chain once and
returns a hardened callable; the circuit-breaker and bulkhead state persist across every invocation
of that callable and are garbage-collected with it. Resilience protects an arbitrary async function
— it is not HTTP middleware and does not itself retry HTTP requests, talk to Redis, or persist
breaker state across instances.

### Exports

- **`ResiliencePlugin`** — Plugin factory registering the resilience service
- **`ResiliencePluginOptions`** — Plugin configuration: `defaultCircuitBreaker?`, `defaultRetry?`,
  `defaultBulkhead?`, each consumed when a `wrap` sets the matching field to `true`
- **`TimeoutError`** — Thrown when a call exceeds its per-attempt timeout deadline
- **`BulkheadFullError`** — Thrown when a bulkhead sheds a call (concurrency saturated, queue full)
- **`CircuitOpenError`** — Thrown when an open circuit breaker fails fast without invoking the call
- **`IResilienceService`** — Resilience service interface (re-exported from
  `@hono-enterprise/common`)
- **`WrapOptions`** — Pattern-selection options for `wrap` (re-exported)
- **`CircuitBreakerPolicy`** — `threshold`, `timeout` (rolling failure window ms), `resetTimeout`
  (re-exported)
- **`RetryPolicy`** — `limit`, `delay`, `backoff` (re-exported)
- **`BulkheadPolicy`** — `maxConcurrent`, `maxQueue?` (re-exported)
- **`BackoffStrategy`** — `'fixed' | 'exponential'` (re-exported)

### Registration

```typescript
import { ResiliencePlugin } from '@hono-enterprise/resilience-plugin';

app.register(ResiliencePlugin({
  defaultCircuitBreaker: { threshold: 5, timeout: 10_000, resetTimeout: 30_000 },
  defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
  defaultBulkhead: { maxConcurrent: 10, maxQueue: 20 },
}));
```

### Programmatic API

```typescript
import type { IResilienceService } from '@hono-enterprise/common';
import { CircuitOpenError, TimeoutError } from '@hono-enterprise/resilience-plugin';

const resilience = ctx.services.get<IResilienceService>('resilience');

// `true` uses the plugin default; a policy object overrides per-wrap.
const guarded = resilience.wrap(() => externalApi.fetchRates(), {
  bulkhead: true,
  circuitBreaker: true,
  retry: { limit: 3, delay: 100, backoff: 'exponential' },
  timeout: 2000,
});

try {
  const rates = await guarded();
} catch (error) {
  if (error instanceof CircuitOpenError) { /* fail-fast: dependency is down */ }
  if (error instanceof TimeoutError) { /* attempt exceeded the 2000ms deadline */ }
}
```

The `wrap` signature and its options:

```typescript
type ResilientCall<T> = (signal: AbortSignal) => Promise<T>;
type HardenedCall<T> = (signal?: AbortSignal) => Promise<T>;

interface IResilienceService {
  wrap<T>(fn: ResilientCall<T>, options?: WrapOptions): HardenedCall<T>;
}

interface WrapOptions {
  readonly circuitBreaker?: boolean | CircuitBreakerPolicy;
  readonly retry?: boolean | RetryPolicy;
  readonly timeout?: number;
  readonly bulkhead?: boolean | BulkheadPolicy;
}
```

When multiple patterns are enabled they compose in one fixed order, outermost to innermost:
**bulkhead → circuit breaker → retry → timeout → fn**. A queue-full bulkhead never touches the
breaker, retry, or `fn`; an open breaker fails fast before any retry attempt; each retry attempt
gets its own timeout. A field set to `true` with no matching `default*` policy configured throws at
`wrap` time.

### Cancellation

Each attempt is handed an `AbortSignal`. On a `timeout` deadline that signal is aborted with the
**same `TimeoutError` instance** the returned promise rejects with, so a timeout has one error
identity whether observed through `catch` or through `signal.reason`:

```typescript
const guarded = resilience.wrap((signal) => fetch(url, { signal }), { timeout: 2000 });
await guarded(); // rejects with TimeoutError, and the fetch is aborted
```

The returned callable also accepts a caller-owned signal. An outer abort propagates into the
protected call, stops the retry loop between attempts, and rejects a call still queued behind the
bulkhead:

```typescript
const controller = new AbortController();
const pending = guarded(controller.signal);
controller.abort(); // pending rejects with the caller's reason
```

Cancellation is **cooperative**: a call that ignores the signal still runs to completion, and only
the caller's `await` rejects. Passing a zero-argument `() => Promise<T>` remains valid — it simply
cannot be cancelled.

Breaker/bulkhead state is per-process and per-`wrap`; there is no shared state across instances.

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
import {
  createUploadMiddleware,
  getUploadedFile,
  StoragePlugin,
} from '@hono-enterprise/storage-plugin';
import type { IStorage } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

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

### Upload middleware

The upload surface is a **free exported middleware factory** (`createUploadMiddleware`), NOT a
method on `IStorage`. Parsed files are exposed through the committed per-request `ctx.state` bag
plus a typed `getUploadedFile()` helper.

```typescript
const uploadMw = createUploadMiddleware({
  fieldname: 'file',
  maxSize: 10 * 1024 * 1024,         // 10 MB default
  allowedMimeTypes?: ['image/jpeg', 'image/png'],  // optional
  maxFiles?: 5,                      // optional
});

app.post('/upload', {
  middleware: [uploadMw],
  handler: async (ctx) => {
    const file = getUploadedFile(ctx, 'file');
    if (!file) return ctx.json({ error: 'No file' }, 400);

    const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
    // `file.name` is the form field name; `file.filename` is the client's original file name.
    const key = `uploads/${Date.now()}-${file.filename}`;
    await storage.put(key, file.data);

    const url = await storage.getSignedUrl(key, { expiresIn: 3600 });
    return ctx.json({ url, key });
  },
});
```

### Usage — buffered download

```typescript
app.get('/files/:key', async (ctx) => {
  const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
  const file = await storage.get(ctx.req.param('key'));
  return ctx.header('content-type', 'application/octet-stream').send(file);
});
```

### Usage — streaming download (`getStream?`)

```typescript
app.get('/files/stream/:key', async (ctx) => {
  const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
  const stream = await storage.getStream!(ctx.req.param('key'));
  return ctx.header('content-type', 'application/octet-stream').stream(stream);
});
```

### Providers

The plugin ships five named providers plus a first-class B2 preset that reuses S3 under the hood.

| Provider               | Type       | Key options                                                         | Auth / SDK                                   | Notes                                                                          |
| ---------------------- | ---------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `MemoryProvider`       | `'memory'` | _(none)_                                                            | N/A (zero-dep)                               | Default. In-process map. Every runtime incl. Cloudflare.                       |
| `LocalStorageProvider` | `'local'`  | `rootDir?: string`                                                  | N/A (`runtime.fs` seam)                      | Node/Deno/Bun only. Throws on connect when `fs` absent.                        |
| `S3Provider`           | `'s3'`     | `bucket`, `region`, `accessKeyId`, `secretAccessKey`, `endpoint?`   | Lazy `npm:@aws-sdk/client-s3@^3` + presigner | R2 and MinIO via `endpoint`. Real presigned GET URLs.                          |
| `GcsProvider`          | `'gcs'`    | `bucket`, `projectId?`                                              | Lazy `npm:@google-cloud/storage@^7`          | Real signed URLs via `file.getSignedUrl`.                                      |
| `AzureBlobProvider`    | `'azure'`  | `containerName`, `connectionString?`, `accountName?`, `accountKey?` | Lazy `npm:@azure/storage-blob@^12`           | SAS requires `accountKey`. No `@azure/identity` needed.                        |
| B2 preset              | `'b2'`     | `bucket`, `region`, `accessKeyId`, `secretAccessKey`                | Same as S3 (reuses `S3Provider`)             | Endpoint defaults to `https://s3.<region>.backblazeb2.com`. No separate class. |

All cloud providers support an injectable `client` option (`IAwsS3Client` / `IGcsClient` /
`IAzureBlobClient`) that bypasses the lazy import for testing.

### IStorage methods

| Method                                                                   | Description                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put(path: string, data: Uint8Array): Promise<void>`                     | Stores an object.                                                                                                                                                                                |
| `get(path: string): Promise<Uint8Array>`                                 | Retrieves an object. **Throws** if absent.                                                                                                                                                       |
| `delete(path: string): Promise<boolean>`                                 | Deletes an object. Returns `true` if present.                                                                                                                                                    |
| `exists(path: string): Promise<boolean>`                                 | Checks existence.                                                                                                                                                                                |
| `getSignedUrl(path: string, options: SignedUrlOptions): Promise<string>` | Creates a time-limited URL. Per-provider semantics: Memory → synthetic `memory://…?expires=…`; LocalStorage → throws; S3 → presigned GET; GCS → signed URL; Azure → SAS (requires `accountKey`). |
| `getStream?(path: string): Promise<ReadableStream<Uint8Array>>`          | **Optional.** Streams an object for zero-copy downloads. Native on S3/GCS/Azure; Memory/Local fall back to wrapping `get(path)` in a one-chunk stream. Absent objects throw.                     |

### Per-provider `getSignedUrl` behavior

| Provider               | Behavior                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryProvider`       | Returns deterministic synthetic URL `memory://<encoded-key>?expires=<epoch-seconds>`. Test/process affordance only — never grants real access. |
| `LocalStorageProvider` | **Throws** `Error('LocalStorageProvider does not support signed URLs; use the s3, gcs, or azure provider')`.                                   |
| `S3Provider`           | Real presigned GET URL via `getSignedUrl(GetObjectCommand, { expiresIn })`.                                                                    |
| `GcsProvider`          | Real signed URL via `file.getSignedUrl([{ action: 'read', expires }])`.                                                                        |
| `AzureBlobProvider`    | Real SAS URL via `generateBlobSASQueryParameters`. Requires `accountKey`; throws if only managed-identity / account-name-only config.          |

---

## MailPlugin()

Provides email sending: registers an `IMailer` under `CAPABILITIES.MAIL`, backed by a pluggable
provider. The default provider is `'log'` (zero-dependency, every runtime — records/logs each
message instead of sending it). No mail SDK is a hard dependency — the SMTP and SES providers accept
an injected client facade or lazily import their package (AI_GUIDELINES §12.2), and SendGrid sends
over web-standard `fetch`. A zero-dependency template engine renders named `{{ variable }}` bodies
for `sendTemplate`.

### Registration

```typescript
import { MailPlugin } from '@hono-enterprise/mail-plugin';

// Log provider (default) — records mail instead of sending; for tests/local dev
app.register(MailPlugin({ defaults: { from: 'noreply@myapp.com' } }));

// SMTP via nodemailer (Node/Deno/Bun only — not Cloudflare Workers)
app.register(MailPlugin({
  provider: 'smtp',
  options: {
    host: config.get('SMTP_HOST'),
    port: 587,
    auth: { user: config.get('SMTP_USER'), pass: config.get('SMTP_PASS') },
  },
  defaults: { from: 'noreply@myapp.com' },
  templates: { welcome: { html: '<h1>Hi {{ name }}</h1>', text: 'Hi {{ name }}' } },
}));

// SendGrid v3 HTTP API (zero dependency, Workers-portable)
app.register(MailPlugin({
  provider: 'sendgrid',
  options: { apiKey: config.get('SENDGRID_API_KEY') },
  defaults: { from: 'noreply@myapp.com' },
}));
```

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IMailer } from '@hono-enterprise/common';

app.router.post('/users', async (ctx) => {
  const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
  const user = await createUser(ctx.request.body);

  await mailer.send({
    to: user.email,
    subject: 'Welcome to MyApp',
    html: '<h1>Welcome!</h1><p>Thank you for joining.</p>',
    text: 'Welcome! Thank you for joining.',
  });

  // Using templates — `subject` is required on the envelope (the committed
  // IMailer.sendTemplate signature keeps it); the template supplies html/text.
  await mailer.sendTemplate('welcome', {
    to: user.email,
    subject: 'Welcome to MyApp',
  }, {
    name: user.name,
  });

  return ctx.response.status(201).json(user);
});
```

### Options

| Option                                               | Provider   | Description                                                      |
| ---------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| `provider`                                           | —          | `'log'` (default), `'smtp'`, `'ses'`, `'sendgrid'`.              |
| `defaults.from`                                      | all        | Sender applied when a message omits `from`; else `send` throws.  |
| `templates`                                          | all        | Named `{ html?, text? }` body templates for `sendTemplate`.      |
| `options.host` / `port` / `secure` / `auth`          | `smtp`     | nodemailer transport config (ignored when `transport` injected). |
| `options.transport`                                  | `smtp`     | Injected `ISmtpTransport` facade (bypasses the lazy import).     |
| `options.region` / `accessKeyId` / `secretAccessKey` | `ses`      | AWS client config (ignored when `client` injected).              |
| `options.client`                                     | `ses`      | Injected `ISesClient` facade (bypasses the lazy SDK import).     |
| `options.apiKey` / `endpoint`                        | `sendgrid` | SendGrid API key (Bearer) and endpoint (default v3 send URL).    |
| `options.http`                                       | `sendgrid` | Injected `fetch`-shaped function (defaults to global `fetch`).   |
| `options.sink`                                       | `log`      | Called with each sent `OutgoingMail` — a read-back seam.         |

### Exports

- `MailPlugin(options?)` — plugin factory. `createProvider(type, options, ctx)` — provider builder.
- `MailService` — the `IMailer` implementation (default-`from` resolution + template dispatch).
- `TemplateEngine`, `escapeHtml` — the `{{ variable }}` renderer and its HTML escaper.
- `LogProvider`, `SmtpProvider`, `SesProvider`, `SendGridProvider` — provider classes.
- `adaptNodemailerModule` / `loadNodemailerModule` / `toNodemailerMessage` /
  `validateSmtpTransport`, `adaptSesModule` / `loadSesModule` / `toSesInput` / `validateSesClient`,
  `toSendGridBody` — provider adapter/mapper/validator helpers.
- `MailServiceOptions`, `MailPluginOptions`, `MailProviderType`, `MailProviderOptions`,
  `MailTemplate`, `OutgoingMail`, `RenderedTemplate`, `LogProviderOptions`, `SmtpProviderOptions`,
  `NodemailerModule`, `SesProviderOptions`, `SesSdkModule`, `SendGridProviderOptions` — types.
- `ISmtpTransport`, `ISesClient`, `IMailHttp` — structural injection types.
- `IMailer`, `MailMessage` — re-exported from `@hono-enterprise/common`.

### Notes

- `sendTemplate`'s envelope is `Omit<MailMessage, 'html' | 'text'>` — `subject` stays REQUIRED; the
  template provides the `html`/`text` bodies only, never the subject.
- In an HTML template, interpolated `data` values are HTML-escaped (`& < > " '`); text templates
  substitute raw. A placeholder whose key is absent from `data`, or an unknown template name,
  throws.
- `LogProvider` never sends real email — it records each message (`.messages`), forwards to `sink`,
  and logs via `ctx.logger`. `SmtpProvider` needs raw sockets, so it is Node/Deno/Bun only;
  `SendGridProvider` is the Cloudflare Workers-portable path.

---

## Notifications

Provides multi-channel notifications.

### Registration

```typescript
import { NotificationPlugin } from '@hono-enterprise/notification-plugin';

app.register(NotificationPlugin({
  channels: {
    // Email delegates to the `IMailer` from MailPlugin (M29) — no options here.
    email: { provider: 'mail' },
    sms: {
      provider: 'twilio',
      options: {
        accountSid: config.get('TWILIO_SID'),
        authToken: config.get('TWILIO_TOKEN'),
        from: config.get('TWILIO_FROM'), // required — the sender number
      },
    },
    push: {
      provider: 'fcm',
      options: {
        projectId: config.get('FCM_PROJECT_ID'),
        clientEmail: config.get('FCM_CLIENT_EMAIL'),
        privateKey: config.get('FCM_PRIVATE_KEY'), // PEM PKCS#8, from the service-account JSON
      },
    },
    slack: { provider: 'slack', options: { webhookUrl: config.get('SLACK_WEBHOOK') } },
  },
}));
```

`ChannelConfig` is discriminated on `provider`, so each entry's `options` are checked against that
provider's option type: omitting `from` above is a compile error, not a startup throw.

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

  // Slack-only
  await notifier.send({
    channels: ['slack'],
    to: { channel: '#orders' },
    body: `New order: ${order.id}`,
  });

  return ctx.response.status(201).json(order);
});
```

### Options

| Option                                      | Provider                 | Description                                                                                                         |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `channels`                                  | —                        | Required map of dispatch name → `ChannelConfig`. Keys are the names a caller passes in `send({ channels: [...] })`. |
| `channels.*.provider`                       | —                        | `'mail' \| 'twilio' \| 'fcm' \| 'slack'` — selects the channel class and transport.                                 |
| `options.accountSid` / `authToken` / `from` | `twilio`                 | Twilio credentials and sender number; all three required (construction throws).                                     |
| `options.projectId`                         | `fcm`                    | Firebase project id, addressed by the v1 `messages:send` URL; required (construction throws).                       |
| `options.clientEmail` / `privateKey`        | `fcm`                    | Service-account email and PEM PKCS#8 key that sign the OAuth2 assertion; required unless `tokenSource` is supplied. |
| `options.tokenSource`                       | `fcm`                    | Overrides token acquisition (e.g. a GCP metadata server); when set the credential fields above are unused.          |
| `options.webhookUrl`                        | `slack`                  | Slack incoming-webhook URL; required (construction throws).                                                         |
| `options.http`                              | `twilio`, `fcm`, `slack` | Injected `INotificationHttp` (defaults to `createDefaultNotificationHttp()`, i.e. global `fetch`).                  |

The `mail` arm takes no `options`: email transport is configured on MailPlugin (M29) and resolved
through `CAPABILITIES.MAIL`.

### Exports

- `NotificationPlugin(options)` — plugin factory. `createChannel(name, config, ctx?)` — channel
  builder. `createProvider(config, ctx?)` — transport builder, overloaded so each `ChannelConfig`
  arm returns its own transport port (`mail` → `IMailer`, `twilio` → `SmsTransport`, `fcm` →
  `PushTransport`, `slack` → `SlackTransport`).
- `NotificationService` — the `INotifier` implementation (parallel fan-out + `AggregateError`).
- `EmailChannel`, `SmsChannel`, `PushChannel`, `SlackChannel` — channel classes (address extraction
  and payload shaping).
- `TwilioProvider`, `FcmProvider`, `SlackProvider` — zero-dependency HTTP transports.
- `createDefaultNotificationHttp(fetchImpl?)` — the `fetch`-backed default `INotificationHttp`.
- `NotificationPluginOptions`, `ChannelsMap`, `ChannelConfig`, `MailChannelConfig`,
  `TwilioChannelConfig`, `FcmChannelConfig`, `SlackChannelConfig`, `ProviderType`,
  `NotificationTransport`, `TwilioProviderOptions`, `FcmProviderOptions`, `SlackProviderOptions` —
  configuration types.
- `INotificationHttp`, `NotificationHttpResponse`, `SmsTransport`, `SmsMessage`, `PushTransport`,
  `PushMessage`, `SlackTransport`, `SlackMessage` — injection/transport types.
- `INotifier`, `NotificationMessage` — re-exported from `@hono-enterprise/common`.

### Notes

- `INotifier` has exactly one method, `send`. There is no `sendEmail` / `sendSms` / `sendSlack` —
  single-channel dispatch is `send({ channels: ['sms'], … })`.
- Channels dispatch in parallel via `Promise.allSettled`: one failing channel never aborts the
  others. When any fail, `send` throws an `AggregateError` (message
  `'One or more notification channels failed'`) whose `errors` are always `Error` instances, one per
  failed channel, including unknown channel names. An empty `channels` array resolves without
  dispatching.
- Each channel reads its own address key out of `to` and throws when it is absent: `to.email`
  (email), `to.phone` (sms), `to.token` (push). Slack's `to.channel` is optional — omitted, the
  webhook's default channel applies. `subject` becomes the mail subject (defaulting to
  `'(no subject)'`) and the push notification title; SMS and Slack ignore it. Built-in channels do
  not read `metadata` — it is there for custom `NotificationChannel` implementations.
- Configuring an `email` channel without a registered `mail` capability throws during `register`, so
  the misconfiguration surfaces at startup rather than at first send.
- All three HTTP providers are zero-dependency (web-standard `fetch`) and Workers-portable; the
  email channel inherits M29's provider constraints (`SmtpProvider` needs raw sockets).
  `FcmProvider` targets **FCM HTTP v1** (`POST /v1/projects/{projectId}/messages:send`),
  authenticating with an OAuth2 bearer token minted from a service account: it signs an RS256 JWT
  assertion with `runtime.subtle` and caches the resulting token until shortly before it expires, so
  a send costs one request in the steady state. A `push` channel using the default signer therefore
  requires `CAPABILITIES.RUNTIME` and throws during `register` without it; supplying `tokenSource`
  removes that requirement.
- A `notification` health indicator reports `'up'` with the configured channel names. There is no
  `onClose`: the providers hold no socket, timer, or connection.

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

// Middleware (free-function guard — IFeatureFlags has no middleware method)
import { createFlagGuard } from '@hono-enterprise/feature-flags-plugin';

app.router.get('/beta', {
  middleware: [createFlagGuard('beta-features', { fallback: '/not-found' })],
  handler: async (ctx) => {/* ... */},
});
```

### Options

| Option                       | Provider(s)            | Required                | Description                                                                         |
| ---------------------------- | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `provider`                   | all                    | yes                     | Discriminant: `'config'`, `'memory'`, `'database'`, `'launchdarkly'`, or `'custom'` |
| `options.flags`              | `'config'`, `'memory'` | config: yes, memory: no | Static `Readonly<Record<string, FlagDefinition>>`                                   |
| `options.store`              | `'database'`           | yes                     | Injected `IFlagStore` providing `{ loadFlags(): Promise<...> }`                     |
| `options.refreshIntervalMs`  | `'database'`           | no                      | Poll cadence; defaults to `30000`                                                   |
| `options.sdkKey`             | `'launchdarkly'`       | unless `client`         | LaunchDarkly SDK key; a missing key with no `client` throws at `register()`         |
| `options.client`             | `'launchdarkly'`       | no                      | Prebuilt `ILaunchDarklyClient`; suppresses the lazy `npm:` import                   |
| `options.module`             | `'launchdarkly'`       | no                      | SDK module to adapt instead of importing — the test seam                            |
| `options.fallbackValue`      | `'launchdarkly'`       | no                      | Value the sync path returns on a cold context; defaults to `false`                  |
| `options.initTimeoutSeconds` | `'launchdarkly'`       | no                      | Initial-connection budget; defaults to `5`. A timeout degrades, never throws        |
| `options.ldOptions`          | `'launchdarkly'`       | no                      | Forwarded verbatim as the SDK `init()` second argument                              |
| `options.instance`           | `'custom'`             | yes                     | Pre-built `FlagProvider` instance                                                   |

### Exports

| Symbol                         | Kind             | Description                                                                   |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| `FeatureFlagsPlugin`           | function         | Plugin factory — registers `IFeatureFlags` under `CAPABILITIES.FEATURE_FLAGS` |
| `FeatureFlagService`           | class            | Service implementing `IFeatureFlags`                                          |
| `createProvider`               | function         | Provider factory dispatching on the `provider` discriminant                   |
| `ConfigProvider`               | class            | Immutable config-backed provider                                              |
| `MemoryProvider`               | class            | Mutable in-process provider with `setFlag`/`removeFlag`/`replaceFlags`        |
| `DatabaseProvider`             | class            | Polled database-backed provider                                               |
| `LaunchDarklyProvider`         | class            | LaunchDarkly-backed provider bridging its async SDK to the sync contract      |
| `toLaunchDarklyContext`        | function         | Maps a `FlagContext` to the SDK's single-kind `user` context                  |
| `adaptLaunchDarklyModule`      | function         | Narrows an SDK module to `ILaunchDarklyModule`                                |
| `loadLaunchDarklyModule`       | function         | Real lazy `import('npm:@launchdarkly/node-server-sdk@^9')`                    |
| `LaunchDarklyModuleError`      | class            | Thrown when the SDK cannot be loaded or does not expose `init()`              |
| `ILaunchDarklyClient`          | interface        | Injection facade for the SDK client                                           |
| `ILaunchDarklyModule`          | interface        | Injection facade for the SDK module                                           |
| `ILaunchDarklyFlagsState`      | interface        | The snapshot facade — its `getFlagValue` is the synchronous read              |
| `LaunchDarklyContext`          | interface        | The SDK evaluation context this provider builds                               |
| `createFlagGuard`              | function         | Free-function route guard — short-circuits to redirect/404 when flag is off   |
| `FlagProvider`                 | interface        | Port implemented by all providers, and by the `'custom'` arm's instance       |
| `FlagProviderStatus`           | interface        | Health status shape (`{ healthy, detail? }`)                                  |
| `FlagProviderType`             | type             | `'config' \| 'memory' \| 'database' \| 'launchdarkly' \| 'custom'`            |
| `FlagDefinition`               | interface        | `{ enabled, percentage?, users? }`                                            |
| `IFlagStore`                   | interface        | Structural facade for `DatabaseProvider`                                      |
| `FeatureFlagsPluginOptions`    | type             | Discriminated union of the four provider option shapes                        |
| `ConfigProviderOptions`        | interface        | The `'config'` arm — requires `options.flags`                                 |
| `MemoryProviderOptions`        | interface        | The `'memory'` arm — `options.flags` optional                                 |
| `DatabaseProviderOptions`      | interface        | The `'database'` arm — requires `options.store`                               |
| `LaunchDarklyProviderOptions`  | interface        | The `'launchdarkly'` arm                                                      |
| `LaunchDarklyProviderConfig`   | interface        | That arm's configuration shape                                                |
| `CustomProviderOptions`        | interface        | The `'custom'` arm — requires `options.instance`                              |
| `FlagGuardOptions`             | interface        | `createFlagGuard` options (`fallback`, `statusCode`, `context`)               |
| `IFeatureFlags`, `FlagContext` | type (re-export) | From `@hono-enterprise/common`                                                |

### Notes

- `IFeatureFlags.isEnabled` is **synchronous**; providers refresh their state out of band.
- The allowlist (`users`) **overrides** `enabled: false` — `{ enabled: false, users: ['user1'] }`
  evaluates to `true` for `userId: 'user1'`.
- Percentage rollout uses deterministic FNV-1a 32-bit bucketing over `` `${flag}:${userId}` ``.
- `FlagContext.attributes` is accepted but not consumed by the built-in evaluators; the `'custom'`
  arm is its extension point.
- `IFeatureFlags.isEnabledAsync` is **optional** and additive. Providers with a purely local
  snapshot (config, memory, database) have nothing to await, so `FeatureFlagService` resolves the
  synchronous evaluation for them. Both entry points funnel through one provider, so a configured
  option governs them identically.
- **LaunchDarkly.** Every evaluation method on the Node server SDK is asynchronous, so it cannot
  directly satisfy the synchronous `isEnabled`. `LaunchDarklyProvider` bridges it using the one
  synchronous read the SDK does offer, `LDFlagsState.getFlagValue`: it fetches a per-context
  snapshot asynchronously and reads it synchronously thereafter. **On a cold context** — the first
  evaluation for a given `userId` — `isEnabled` returns the configured `fallbackValue` and schedules
  a background refill, so every later read for that user is real LaunchDarkly state. `start()`
  prewarms the anonymous context and an SDK `update` event drops the cache. Use `isEnabledAsync`
  wherever a wrong answer on a cold context would matter; it awaits `boolVariation` and carries no
  such caveat. The provider is Node/Deno/Bun only (the SDK uses `node:events` and Node HTTP), and
  the SDK is never a hard dependency.

---

## Multi-Tenancy Plugin

Provides multi-tenancy support: tenant resolution, tenant context, tenant-scoped repositories,
cache-key isolation, and pluggable database-isolation strategies.

### Registration

```typescript
import { MultiTenancyPlugin } from '@hono-enterprise/multi-tenancy-plugin';

app.register(MultiTenancyPlugin({
  resolver: 'header',
  header: { name: 'x-tenant-id' },
  database: 'column-per-tenant',
  cache: { prefix: true },
}));
```

### Usage

```typescript
app.router.get('/users', async (ctx) => {
  const tenancy = ctx.services.get<IMultiTenancyService>('multi-tenancy');
  const tenant = ctx.request.tenant;

  // Tenant-aware repository — reads ctx.request.tenant set by middleware
  const userRepo = tenancy.getRepository<User>(ctx, 'User');
  const users = await userRepo.findAll(); // Scoped to current tenant

  // Cache-key prefixing
  const prefixed = tenancy.prefixCacheKey(tenant!.id, 'users:list'); // 'acme:users:list'

  return ctx.response.json(users);
});
```

**Note:** `getRepository` requires `ctx` because the framework has no ambient request context (no
`AsyncLocalStorage`). The middleware resolves the tenant first; `getRepository` reads it from
`ctx.request.tenant`. Calling `getRepository` before the middleware runs throws
`TenantNotResolvedError`.

### Options

| Option                  | Type                                                                                              | Required | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `resolver`              | `'subdomain' \| 'header' \| 'path' \| 'jwt' \| ITenantResolver \| ITenantResolver[]`              | yes      | Discriminant for tenant resolution method, or a custom resolver / array of resolvers |
| `subdomain.baseDomain?` | `string`                                                                                          | no       | Stripped from host to isolate tenant label; absent → first host label is tenant id   |
| `header.name?`          | `string`                                                                                          | no       | Header to read; default `'x-tenant-id'`                                              |
| `path.segment?`         | `number`                                                                                          | no       | Path segment index to read; default `0`                                              |
| `jwt.claim?`            | `string`                                                                                          | no       | JWT claim to read; default `'tenant_id'`                                             |
| `jwt.headerName?`       | `string`                                                                                          | no       | Authorization header name; default `'authorization'`                                 |
| `jwt.decode?`           | `(token: string) => Record<string, unknown> \| null`                                              | no       | Custom decoder; falls back to `IJwtService.decode` from `CAPABILITIES.JWT` if absent |
| `database`              | `'column-per-tenant' \| 'schema-per-tenant' \| 'database-per-tenant' \| ITenantIsolationStrategy` | no       | Isolation strategy; default `'column-per-tenant'`                                    |
| `dataStore?`            | `ITenantDataStore`                                                                                | no       | Injected CRUD backend; default `MemoryTenantDataStore`                               |
| `cache.prefix?`         | `boolean`                                                                                         | no       | When `true`, stamps resolved prefix into `ctx.state` via `getTenantCachePrefix()`    |
| `cache.separator?`      | `string`                                                                                          | no       | Default `':'` — used by `prefixCacheKey` and the `ctx.state` stamp                   |
| `required?`             | `boolean`                                                                                         | no       | When `true`, short-circuits unresolved requests at 400 without calling `next()`      |
| `rejectionStatus?`      | `number`                                                                                          | no       | Status code for required-tenant short-circuit; default `400`                         |
| `middlewarePriority?`   | `number`                                                                                          | no       | Priority for auto-added middleware; default `40`                                     |

### Exports

| Symbol                                                                                                             | Kind        | Description                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------ |
| `MultiTenancyPlugin`                                                                                               | function    | Plugin factory — registers `IMultiTenancyService` under `CAPABILITIES.MULTI_TENANCY`       |
| `tenantMiddleware`                                                                                                 | function    | Middleware factory — resolve tenant, set `ctx.request.tenant`, short-circuit when required |
| `getTenantCachePrefix`                                                                                             | function    | Accessor reading the tenant cache prefix from `ctx.state`                                  |
| `TENANT_CACHE_PREFIX_STATE_KEY`                                                                                    | const       | Module-level key constant (`'multi-tenancy-plugin:cache-prefix'`)                          |
| `SubdomainResolver`                                                                                                | class       | Resolves tenant from URL host subdomain                                                    |
| `HeaderResolver`                                                                                                   | class       | Resolves tenant from configurable HTTP header                                              |
| `PathResolver`                                                                                                     | class       | Resolves tenant from configurable path segment index                                       |
| `JwtResolver`                                                                                                      | class       | Resolves tenant from JWT claim (uses unverified decode)                                    |
| `ColumnPerTenant`                                                                                                  | class       | Column-per-tenant isolation strategy (default)                                             |
| `SchemaPerTenant`                                                                                                  | class       | Schema-per-tenant isolation strategy                                                       |
| `DatabasePerTenant`                                                                                                | class       | Database-per-tenant isolation strategy                                                     |
| `MemoryTenantDataStore`                                                                                            | class       | Zero-dependency in-process default store with cross-tenant isolation                       |
| `TenantNotResolvedError`                                                                                           | class       | Thrown by `getRepository` when tenant has not been resolved                                |
| `MultiTenancyPluginOptions`                                                                                        | interface   | The argument type of `MultiTenancyPlugin(...)`                                             |
| `ResolverConfig`                                                                                                   | type        | The `resolver` option's type — discriminant string, custom resolver, or chain              |
| `DatabaseStrategyKind`                                                                                             | type        | The `database` option's discriminant strings                                               |
| `SubdomainResolverOptions`, `HeaderResolverOptions`, `PathResolverOptions`, `JwtResolverOptions`                   | interfaces  | Per-resolver option shapes, also the resolver constructors' argument types                 |
| `TenantCacheOptions`                                                                                               | interface   | The `cache` option shape (`prefix`, `separator`)                                           |
| `MemoryTenantDataStoreOptions`                                                                                     | interface   | `MemoryTenantDataStore` constructor options (`generateId`)                                 |
| `ITenantDataStore`                                                                                                 | interface   | Internal port for tenant-scoped CRUD (app injection seam)                                  |
| `ITenantIsolationStrategy`                                                                                         | type        | Discriminated union with `'column' \| 'schema' \| 'database'` arms; narrow on `kind`       |
| Re-exported from common: `IMultiTenancyService`, `ITenantRepository`, `ITenant`, `ITenantResolver`, `CAPABILITIES` | types/const | Convenience re-exports — canonical definitions stay in `@hono-enterprise/common`           |

### Notes

- **No npm dependencies.** All resolvers parse strings; strategies are pure derivation; memory store
  is in-process maps; cache prefixing is concatenation.
- **`JwtResolver` uses unverified decode.** Tenant identity comes from an unsigned token claim. This
  is acceptable only alongside auth middleware which separately verifies the token.
- **`PathResolver` reads path segments by index, not router `:param` values.** The resolver receives
  `IRequest` (not `IRequestContext`), so it cannot access `ctx.params`.
- **`SubdomainResolver`'s `baseDomain` constrains resolution, it does not merely strip.** With
  `baseDomain: 'example.com'`, only a strict subdomain resolves (`acme.example.com` → `acme`,
  left-most label for deeper hosts, port ignored). The apex (`example.com`), an unrelated host
  (`evil.com`), and a bare suffix match (`notexample.com`) all resolve to no tenant. Without
  `baseDomain`, the first label of any multi-label host is the tenant and a single-label host
  (`localhost`) resolves to none.
- **`MemoryTenantDataStore` hands out detached snapshots.** Every entity returned by
  `create`/`findAll`/`find`/`findById`/`update` is a shallow copy, so mutating a returned object
  never rewrites the stored record. Read paths (`findAll`/`find`/`findById`/`delete`/a missing
  `update`) allocate no partition, so requests carrying unknown tenant ids cannot grow the store.
- **Strategy-derived partitioning.** The strategy passed to `register()` is handed to the data store
  via `useIsolation()`. `MemoryTenantDataStore` derives its partition scope from it
  (column-stamping, schema/database scoping). A store that never receives `useIsolation` partitions
  by raw tenant id.
- **Auto-added at priority 40.** Runs after observability (metrics 20 / telemetry 30), before auth
  (300). Exported for manual re-ordering.

## Health

Provides health check endpoints with pluggable indicators.

### Service Interface

Resolve the service via `ctx.services.get<IHealthService>('health')`. The service provides:

```typescript
interface IHealthService {
  registerIndicator(name: string, indicator: HealthIndicatorFn): void;
  check(): Promise<HealthReport>;
  checkLive(): Promise<HealthReport>;
  checkReady(): Promise<HealthReport>;
}

interface HealthReport {
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly checks: Readonly<
    Record<string, Readonly<HealthCheckResult & { readonly latencyMs?: number }>>
  >;
}

interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly data?: Readonly<Record<string, unknown>>;
}

type HealthStatus = 'up' | 'down' | 'degraded';
```

### Registration

```typescript
import { createHttpIndicator, HealthPlugin } from '@hono-enterprise/health-plugin';

app.register(HealthPlugin({
  endpoints: {
    health: '/health',
    live: '/live',
    ready: '/ready',
  },
  indicators: [
    createHttpIndicator('external-api', {
      url: 'https://api.example.com/health',
      timeoutMs: 3000,
    }),
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

### Endpoints

| Endpoint  | Method | Description                            | Status Codes                          |
| --------- | ------ | -------------------------------------- | ------------------------------------- |
| `/health` | GET    | Overall health (all indicators)        | 200 (up/degraded), 503 (down)         |
| `/live`   | GET    | Liveness (self indicator only)         | 200 (always, unless self is down)     |
| `/ready`  | GET    | Readiness (all contributed indicators) | 200 (all up), 503 (any down/degraded) |

### Response

```json
GET /health
{
  "status": "up",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "self": { "status": "up", "latencyMs": 1, "data": { "platform": "node", "version": "18.0.0", "hostname": "my-host" } },
    "database": { "status": "up", "latencyMs": 5 },
    "cache": { "status": "up", "latencyMs": 2 },
    "external-api": { "status": "down", "latencyMs": 3000, "data": { "error": "timeout" } }
  }
}
```

**Status aggregation rules:**

- `/live`: Always 200 as long as the process responds (self indicator always returns 'up')
- `/ready`: 200 when all contributed indicators are 'up', 503 when any is 'degraded' or 'down'
- `/health`: 200 when no participating indicator is 'down' (degraded stays 200), 503 when any is
  'down'

---

## Metrics

Provides Prometheus metrics.

### Service Interface

Resolve the service via `ctx.services.get<IMetricsService>('metrics')`. Each factory method is
**get-or-create**: the first call for a name constructs and registers the instrument; later calls
return the same handle. Record methods are **value-first** (`inc(value?, labels?)`,
`set(value, labels?)`, `observe(value, labels?)`), matching the committed `IMetric.observe`.

```typescript
interface MetricOptions {
  readonly help?: string; // defaults to the metric name
  readonly labels?: readonly string[];
  readonly buckets?: readonly number[]; // histogram; falls back to defaultBuckets
  readonly quantiles?: readonly number[]; // summary; falls back to defaultQuantiles
  readonly maxSamples?: number; // summary sliding-window size (default 512)
}

interface IMetricsService {
  counter(name: string, options?: MetricOptions): ICounter;
  gauge(name: string, options?: MetricOptions): IGauge;
  histogram(name: string, options?: MetricOptions): IHistogram;
  summary(name: string, options?: MetricOptions): ISummary;
  get(name: string): IMetric | undefined;
}

interface ICounter extends IMetric {
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
}
interface IGauge extends IMetric {
  set(value: number, labels?: Readonly<Record<string, string>>): void;
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
  dec(value?: number, labels?: Readonly<Record<string, string>>): void;
}
interface IHistogram extends IMetric {
  observe(value: number, labels?: Readonly<Record<string, string>>): void;
  readonly buckets: readonly number[];
}
interface ISummary extends IMetric {
  observe(value: number, labels?: Readonly<Record<string, string>>): void;
  readonly quantiles: readonly number[];
}
```

The declarative `MetricConfig` (`type` and `help` required) remains the shape for
`ctx.metrics.register(name, config)` and the plugin's `customMetrics` option. The `GET /metrics`
scrape endpoint responds with `Content-Type: text/plain; version=0.0.4; charset=utf-8`.

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
  histogram.observe((Date.now() - start) / 1000, { query_type: 'full-text' });

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

Provides OpenTelemetry distributed tracing. The `TelemetryPlugin` registers an `ITelemetryService`
under `CAPABILITIES.TELEMETRY` (`'telemetry'`), exposing manual span creation via `withSpan` plus a
request-span middleware at priority 30 (inside metrics at 20, outside auth at 300) that wraps every
inbound HTTP request in a server span with W3C `traceparent`/`tracestate` propagation.

The OpenTelemetry SDK is a **heavy optional dependency**: the plugin lazy-loads
`@opentelemetry/sdk-trace-base` and an exporter via dynamic `npm:` imports, failing with a clear
error when the package is absent. A `NoopTelemetryService` is the default when no exporter is
configured, so the plugin always registers a usable service with zero npm deps in that mode.

An injectable `tracerProviderFactory` option lets tests (and consumers with a pre-built provider)
bypass the lazy import entirely.

### Options

| Option                  | Type                                      | Required        | Description                                        |
| ----------------------- | ----------------------------------------- | --------------- | -------------------------------------------------- |
| `serviceName`           | `string`                                  | Yes (real mode) | Service name reported to the exporter              |
| `serviceVersion`        | `string`                                  | No              | Service version (default: `'1.0.0'`)               |
| `exporter`              | `'otlp' \| 'console'`                     | No              | Exporter kind; absent = noop mode                  |
| `endpoint`              | `string`                                  | Yes (otlp)      | OTLP HTTP endpoint URL                             |
| `headers`               | `Record<string, string>`                  | No              | Optional OTLP HTTP headers                         |
| `sampling`              | `{ type: 'traceidratio'; ratio: number }` | No              | Sampling config (default ratio: 1.0)               |
| `tracerProviderFactory` | `() => Promise<TracerHost>`               | No              | Injectable factory to bypass lazy import           |
| `middleware`            | `boolean`                                 | No              | Register request-span middleware (default: `true`) |
| `spanProcessor`         | `'simple' \| 'batch'`                     | No              | Span processor (`'simple'` by default)             |
| `instrumentations`      | `InstrumentationsConfig`                  | No              | Auto-instrumentation config (runtime-gated no-op)  |

### Auto-instrumentation

Milestone 24b adds the `instrumentations` option — a per-kind map of `true | InstrumentationConfig`
keys: `http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`. Each key enables one auto-instrumentation.
On non-Node runtimes (Deno, Bun, Cloudflare Workers) all instrumentations degrade to a **documented
no-op** — they never throw. When `tracerProviderFactory` returns a host with a truthy
`otelProvider`, the registry calls `setTracerProvider` + `enable()` on each loaded instrumentation
instance; when `otelProvider` is absent, the registry returns a no-op handle immediately.

Each instrumentation uses the **inject-or-lazy seam**: when `InstrumentationConfig.instrumentation`
is set, the instance is used directly (inject path); otherwise the registry lazy-loads the OTel
package via `npm:` dynamic import (lazy path). Any loader failure is caught and recorded as a
failure outcome — the plugin **never throws** from instrumentation setup.

### Span Processor

The `spanProcessor` option selects between `'simple'` (default) and `'batch'` span processing. Both
are exported from the pinned `@opentelemetry/sdk-trace-base@^2.9.0`.

### Registration

```typescript
import { TelemetryPlugin } from '@hono-enterprise/telemetry-plugin';

// Noop mode (zero dependencies)
app.register(TelemetryPlugin({ serviceName: 'my-service' }));

// Real mode with console exporter
app.register(TelemetryPlugin({
  serviceName: 'my-service',
  serviceVersion: '1.0.0',
  exporter: 'console',
}));

// Real mode with OTLP exporter
app.register(TelemetryPlugin({
  serviceName: 'my-service',
  exporter: 'otlp',
  endpoint: config.get('OTLP_ENDPOINT'),
  sampling: { type: 'traceidratio', ratio: 0.1 },
}));
```

### Manual Spans

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ITelemetryService } from '@hono-enterprise/common';

app.router.post('/orders', async (ctx) => {
  const telemetry = ctx.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);

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

### Request-Span Middleware

The plugin registers `telemetryMiddleware` at priority 30 by default. It:

1. Extracts `traceparent`/`tracestate` from `ctx.request.headers` (W3C Trace Context)
2. Starts a server span named `<METHOD> <path>`
3. Stores the span on `ctx.state` under `TELEMETRY_SPAN_KEY` (`'__he_telemetry_span'`)
4. Sets HTTP attributes (`http.method`, `http.route`, `http.status_code`)
5. Injects `traceparent` into the response headers

Downstream handlers can read the active span via:

```typescript
import { TELEMETRY_SPAN_KEY } from '@hono-enterprise/telemetry-plugin';
import type { ISpan } from '@hono-enterprise/common';

const activeSpan = ctx.state.get(TELEMETRY_SPAN_KEY) as ISpan | undefined;
```

### Contract Types

The telemetry contract is framework-owned and exported from `@hono-enterprise/common` (zero
dependencies — importable without the OTel SDK installed). The telemetry-plugin translates these to
OTel types at its implementation seam.

| Export                     | Kind            | Shape / description                                                                                                                                                                                                                                                             |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITelemetryService`        | interface       | `withSpan<T>(name: string, fn: (span: ISpan) => Promise<T>, options?: SpanOptions): Promise<T>` — the only manual span-creation API; ends the span exactly once, even if `fn` throws. Resolved under `CAPABILITIES.TELEMETRY`.                                                  |
| `ISpan`                    | interface       | `setAttribute(key, value): this`, `setAttributes(attrs): this`, `setStatus(status): void`, `recordException(error): void`, `end(): void`, `spanContext(): SpanContext`.                                                                                                         |
| `SpanContext`              | interface       | `{ readonly traceId: string; readonly spanId: string; readonly traceFlags: string }` — all lowercase hex (32/16/2 chars). Returned by `ISpan.spanContext()`.                                                                                                                    |
| `SpanStatus`               | union           | `'ok' \| 'error' \| 'unset'` — argument to `ISpan.setStatus`.                                                                                                                                                                                                                   |
| `SpanKind`                 | union           | `'internal' \| 'server' \| 'client' \| 'producer' \| 'consumer'` — `SpanOptions.kind` (default `'internal'`).                                                                                                                                                                   |
| `SpanAttributeValue`       | union           | `string \| number \| boolean \| ReadonlyArray<string \| number \| boolean>`.                                                                                                                                                                                                    |
| `SpanOptions`              | interface       | `{ readonly kind?: SpanKind; readonly attributes?: Readonly<Record<string, SpanAttributeValue>>; readonly parentContext?: TelemetryContext }` — 3rd arg to `withSpan`. Pass `parentContext` to parent a span explicitly (there is no implicit parent linking — see note below). |
| `TelemetryContext`         | interface       | Opaque parent-context handle carrying the extracted W3C fields (`_opaque`, optional `traceId`/`spanId`/`traceFlags`/`tracestate`). Consumers must not inspect it beyond passing it back via `SpanOptions.parentContext`.                                                        |
| `TELEMETRY_CONTEXT_OPAQUE` | `unique symbol` | Brand for `TelemetryContext._opaque` (`Symbol.for('he.telemetry.context')`); prevents structural mixups.                                                                                                                                                                        |

> **No implicit parent/child linking.** The framework registers no OTel `ContextManager` (the only
> runtime-agnostic option depends on `node:async_hooks`), so a `withSpan` nested inside another does
> not auto-parent. To create a child span, pass `parentContext` (or the extracted context) on
> `SpanOptions`. The request-span middleware always passes the incoming `traceparent` as the parent
> explicitly, so cross-process propagation (incoming header → server span) works out of the box.

---

## OpenAPI

Provides automatic OpenAPI documentation.

### Registration

```typescript
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';

app.register(OpenApiPlugin({
  // OpenAPI spec metadata
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
  // Endpoint configuration
  endpoint: '/docs', // Path for Swagger UI HTML (default: '/docs')
  specEndpoint: '/openapi.json', // Path for OpenAPI JSON spec (default: '/openapi.json')
  swagger: true, // Whether to serve Swagger UI (default: true)
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
  },
  handler: async (ctx) => {/* ... */},
});
```

### Notes

- Every `RouteSchema` position the generator reads becomes part of the operation: `body` becomes the
  `application/json` request body, `response` becomes the responses map, `tags`/`summary` become the
  operation metadata, and `params`, `query`, and `headers` become `parameters` with `in: 'path'`,
  `in: 'query'`, and `in: 'header'` respectively. Path parameters are always `required: true` (they
  come from the path template); query and header parameters take their `required` flag from the
  schema. Header parameters are emitted verbatim — per OpenAPI 3.1, tooling ignores definitions
  named `Accept`, `Content-Type`, and `Authorization`, so the generator does not filter them out.

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

`@hono-enterprise/cli` ships the `honoe` executable: project scaffolding and plugin-aware code
generation. Install it with an explicit binary name, because Deno's default inference would name it
after the package (`cli`):

```bash
deno install -g -A -n honoe jsr:@hono-enterprise/cli@^0.1.0-alpha.3/main
```

### Commands

```bash
# Scaffold a project (creates ./my-app)
honoe new my-app
honoe new my-app --runtime node                 # deno | node | bun | cloudflare-workers
honoe new my-app --template rest                # rest | microservice | nest | full-stack
honoe new my-app --template microservice --runtime bun

# Commands this application's plugins provide
honoe commands
honoe db:migrate up 3                           # runs a plugin-registered command

# Generate code
honoe generate plugin my-plugin
honoe generate controller user-profile
honoe generate service user-profile
honoe generate route users
honoe generate middleware rate-limit
honoe generate guard admin-only                 # requires @hono-enterprise/auth-plugin
honoe generate health-indicator external-api    # requires @hono-enterprise/health-plugin
honoe generate metric orders-placed             # requires @hono-enterprise/metrics-plugin
honoe generate command-handler create-user      # requires @hono-enterprise/cqrs-plugin
honoe generate query-handler get-user           # requires @hono-enterprise/cqrs-plugin
honoe generate event-handler user-created       # requires @hono-enterprise/events-plugin
honoe generate job send-welcome-email
honoe generate migration add-users-table        # requires @hono-enterprise/database-plugin

# Custom schematics, loaded from .hono-enterprise/schematics/<schematic>.ts
honoe generate custom my-schematic order-item

# Aliases
honoe n my-app
honoe g service user-profile

# Print the plan, write nothing
honoe g controller user-profile --dry-run
```

Any casing of the name produces identical output: `honoe g controller user-profile` and
`honoe g controller UserProfile` emit the same file.

### Options

| Option                                          | Commands          | Behavior                                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runtime deno\|node\|bun\|cloudflare-workers` | `new`, `generate` | On `new`, selects the entry shape and manifest. On `generate`, passed to the schematic as `SchematicOptions.runtime` (read by custom schematics). Defaults to `deno`; an unknown value is a usage error (`2`) on both. |
| `--dir <path>`                                  | `new`, `generate` | Operate on this directory instead of the working directory. A relative path is resolved against the working directory.                                                                                                 |
| `--dry-run`                                     | `new`, `generate` | Prints `would create <path>` per file and performs zero writes and zero directory creations.                                                                                                                           |
| `--help`, `-h`                                  | both              | Prints usage and exits `0`. `honoe generate --help` lists only the schematics available here.                                                                                                                          |
| `--version`, `-v`                               | —                 | Prints the version read from the package's own `deno.json` and exits `0`.                                                                                                                                              |

### Exit codes

| Code | Meaning                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success (including `--help` and `--version`).                                                                                                                                                       |
| `1`  | Runtime error: a gated schematic's plugin is absent, a target file exists, a write failed, the application failed to load or start, a command handler threw, or a command name is registered twice. |
| `2`  | Usage error: unknown command or schematic, missing argument, unknown `--runtime`, or a name that cannot form an identifier (empty after normalization, or digit-leading).                           |

### Plugin gating

`honoe generate` reads the target project's `deno.json` `imports` (falling back to `package.json`
`dependencies` + `devDependencies`) to learn which `@hono-enterprise` packages are installed. It
never imports or boots the project. A schematic whose backing plugin is absent is refused with exit
code `1`, naming the package to install, and `honoe generate --help` marks it unavailable.

### Overwrite protection

A generate that would overwrite ANY existing file writes NOTHING at all — every planned path is
checked before the first write, so a multi-file schematic can never leave a half-written tree.

### Project templates

`honoe new` always emits a `honoe.config.ts` exporting `createApp()` — one place the project's
plugin list lives. `main.ts` imports it to start the server, and `honoe` imports it to discover
plugin commands, so the two can never disagree. The factory deliberately does NOT start the
application.

```typescript
// honoe.config.ts (--template rest)
import { createApplication } from '@hono-enterprise/kernel';
import type { IApplication } from '@hono-enterprise/common';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ConfigPlugin } from '@hono-enterprise/config-plugin';
// … logging, validation, security, health, metrics, OpenAPI, decorators
import { errorHandler } from '@hono-enterprise/exceptions';

export function createApp(): IApplication {
  const app = createApplication({ plugins: [RuntimePlugin(), ConfigPlugin()] });
  app.middleware.add(errorHandler());
  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));
  return app;
}
```

| Template       | Plugin set                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only.                                                                                      |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenApi, Decorator + `errorHandler()`. |
| `microservice` | `rest` plus Messaging, Queue, Resilience, Telemetry.                                                       |
| `nest`         | `rest` plus `DiPlugin`, an `@Injectable` service, and a `@Controller` using parameter-level `@Inject`.     |
| `full-stack`   | A React Router 8 SSR app: the full plugin set via `createFullStackAppFromConfig`, plus an `app/` skeleton. |

Three of the four templates emit **inline wiring**, not imports of the `@hono-enterprise/*-starter`
packages, so a scaffolded project owns an explicit, editable plugin list. `full-stack` is the
exception, with cause: its composition is twenty-two plugins, and a generated file a human is meant
to open and edit should not begin with twenty-two imports they did not choose. A general `--starter`
flag for the other three is still deferred (see "Not in this release").

### `--template full-stack`

```typescript
// honoe.config.ts (--template full-stack)
import { createFullStackAppFromConfig } from '@hono-enterprise/full-stack-starter';
import type { IApplication } from '@hono-enterprise/common';
import { getCsrfToken, getSession } from '@hono-enterprise/session-plugin';
import { csrfContext, sessionContext } from './app/lib/context-keys.ts';

export async function createApp(): Promise<IApplication> {
  return await createFullStackAppFromConfig((config) => ({
    reactRouter: {
      serverBuildPath: './build/server/index.js',
      assetsDir: './build/client/assets',
      populateLoadContext: (ctx, context) => {
        context.set(sessionContext, getSession(ctx));
        context.set(csrfContext, getCsrfToken(ctx));
      },
    },
    session: { secret: config.getOrThrow<string>('SESSION_SECRET'), csrf: {} },
  }));
}
```

The emitted `app/` tree is the deliverable: `routes → features → services → models`, `flatRoutes`
`_app`/`_auth` layout groups each wrapped in their own layout, the `~/*` alias, the `.server.ts`
convention, and one worked feature. What it deliberately does **not** contain is a
`lib/session.server.ts`, `lib/csrf.server.ts`, `lib/sse.server.ts`, `lib/kv.server.ts` or
`lib/service-logger.server.ts` — those are the session, SSE, secrets and logger capabilities,
reached through the registry the SSR plugin attaches to every request.

Session reaches loaders through a key the **application** declares, never a plugin-to-plugin import:
`getSession` takes an `IRequestContext`, which a loader never sees, while `populateLoadContext`
receives exactly that. `RouterContextKey` is exported from the SSR plugin so app code can declare
keys without importing `react-router` on the server.

Notes:

- **The generated factory is `async`.** `honoe` awaits it during command discovery, and `main.ts`
  awaits it too, so nothing else changes.
- **No hello-world route.** An exact `/` handler would take precedence over the SSR catch-all and
  shadow the application's own index route.
- **Every runtime target is supported.** Cloudflare Workers omits `assetsDir`: with no filesystem
  the asset handler would answer 404 for every asset, and omitting the option registers no asset
  route at all, leaving them to the platform's static-asset binding.
- **The frontend build runs on npm even when the server runs on Deno** — the one documented
  exception to the Deno-only toolchain. Deno and Workers targets get a standalone `package.json` for
  Vite and React Router; Node and Bun targets get those dev dependencies merged into the
  `package.json` they already have. The Deno `start` task additionally carries `--allow-read`, which
  the SSR plugin needs to import its own server build and read client assets.
- **React Router is pinned to v8**, matching the `npm:react-router@8` the SSR plugin imports.

The `nest` template additionally emits `src/greeting-service.ts` and `src/greeting-controller.ts`,
and its `honoe.config.ts` imports both to pass them to `DecoratorPlugin({ controllers, services })`.
It refuses no runtime target. `--template microservice --runtime
cloudflare-workers` is refused
(`2`): the messaging and queue plugins need raw sockets, which Workers does not provide.

### Plugin-contributed commands

A plugin publishes commands with `ctx.cli.register(name, handler)`; the CLI discovers them by
loading `honoe.config.ts` and starting the application with **no port**, so registration happens
without binding a socket. The application is always stopped afterwards, including when a handler
throws.

```bash
honoe commands          # list what this application's plugins provide
honoe db:migrate up 3   # positionals after the name reach the handler
```

Handlers receive positionals only. `honoe` consumes its own flags, so pass a plugin command's flags
after `--`:

```bash
honoe db:migrate -- --verbose --dry
```

Built-in verbs (`new`, `n`, `generate`, `g`, `commands`, `help`) are matched **first** and always
win, so a plugin cannot shadow them — and those paths never import your project. Only an unmatched
first positional triggers a boot.

Two plugins registering the same command name is an error (`1`) that runs neither: which
registration wins would otherwise depend on plugin load order.

### Generated plugin example

```bash
honoe g plugin my-plugin
```

Generates `src/plugins/my-plugin.ts`:

```typescript
import { createCapabilityToken } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

/** Capability token this plugin provides. */
export const MY_PLUGIN = createCapabilityToken('my-plugin');

/** The service registered under {@linkcode MY_PLUGIN}. */
export interface IMyPluginService {
  /** Replace with the capability this plugin publishes. */
  describe(): string;
}

/**
 * Registers the my-plugin capability.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function MyPluginPlugin(): IPlugin {
  return {
    name: 'my-plugin',
    version: '0.1.0',
    provides: [MY_PLUGIN],
    register(ctx: IPluginContext): void {
      const service: IMyPluginService = {
        describe: () => 'my-plugin',
      };
      ctx.services.register(MY_PLUGIN, service);
    },
  };
}
```

### Custom schematics

`honoe generate custom <schematic> <name>` resolves `.hono-enterprise/schematics/<schematic>.ts` and
loads it with a real dynamic `import()`. The module must export a `schematic` function (or a default
export that is a function):

```typescript
// .hono-enterprise/schematics/readme.ts
import type { DerivedNames, GeneratedFile, SchematicOptions } from '@hono-enterprise/cli';

export function schematic(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  return [{ path: `docs/${names.kebab}.md`, contents: `# ${names.pascal}\n` }];
}
```

`DerivedNames` carries `raw`, `kebab`, `camel`, `pascal`, and `screaming`. `SchematicOptions`
carries the target `runtime`, the detected `plugins` set, and `now()` — an injected clock, so
timestamped output stays deterministic. Schematics perform no I/O; the command layer writes what
they return, which is what makes `--dry-run` exact.

### Programmatic API

| Export             | Kind     | Purpose                                                                      |
| ------------------ | -------- | ---------------------------------------------------------------------------- |
| `runCli`           | function | Runs the CLI and RETURNS an exit code; never calls `Deno.exit`.              |
| `CliDependencies`  | type     | The `fs` / `cwd` / `now` / `log` / `error` bundle `runCli` requires.         |
| `deriveNames`      | function | Produces the five naming forms every schematic uses.                         |
| `DerivedNames`     | type     | The result of `deriveNames`.                                                 |
| `GeneratedFile`    | type     | `{ path, contents }` — one file a schematic asks to create.                  |
| `Schematic`        | type     | `(names, options) => readonly GeneratedFile[]`.                              |
| `SchematicOptions` | type     | The second parameter of every schematic.                                     |
| `PROGRAM_NAME`     | const    | `'honoe'` — interpolated into every usage string.                            |
| `TemplateName`     | type     | The `--template` value union, for callers building argv programmatically.    |
| `ModuleLoader`     | type     | The seam a custom schematic module is loaded through.                        |
| `AppLoader`        | type     | The seam `honoe.config.ts` is loaded through (`CliDependencies.loadApp`).    |
| `detectPlugins`    | function | Reads a project manifest and returns the installed `@hono-enterprise` names. |

`CliDependencies` has no default: `src/main.ts` owns the process boundary (`Deno.args`,
`Deno.cwd()`, `console`, the real filesystem, and the single `Deno.exit`), so every other path is
testable without terminating the runner.

### Not in this release

- **Starter-backed scaffolding.** `--template` emits inline wiring. A `honoe new --starter` path
  that scaffolds a project importing `createRestApp` and friends is deferred — the starters
  themselves shipped in Milestone 36 and can be depended on directly.
- **Flags for plugin commands.** `CliCommandHandler` receives positionals only; giving handlers a
  parsed flag record would widen a committed `common` contract. Forward flags with `--` instead.
- **Plugin installation.** `honoe` generates and dispatches; it does not edit your manifest.

---

## REST API Application

### Starter exports and option arms

The three starters share one option chain:
`FullStackStarterOptions extends
MicroserviceStarterOptions extends RestStarterOptions`, so an arm
added to the REST tier is available on all three.

| Export                         | Kind     | Package                                            |
| ------------------------------ | -------- | -------------------------------------------------- |
| `createRestApp`                | function | `rest-starter`                                     |
| `buildRestPlugins`             | function | `rest-starter`                                     |
| `RestStarterOptions`           | type     | `rest-starter`                                     |
| `RealtimeArm`                  | type     | all three (re-exported along the tier's pin chain) |
| `createMicroserviceApp`        | function | `microservice-starter`                             |
| `buildMicroservicePlugins`     | function | `microservice-starter`                             |
| `MicroserviceStarterOptions`   | type     | `microservice-starter`                             |
| `createFullStackApp`           | function | `full-stack-starter`                               |
| `buildFullStackPlugins`        | function | `full-stack-starter`                               |
| `createFullStackAppFromConfig` | function | `full-stack-starter`                               |
| `FullStackStarterOptions`      | type     | `full-stack-starter`                               |

Each arm is one plugin's option object, threaded through unchanged. **Gated arms are absent unless
supplied**, so a starter called with no options registers exactly its always-on set:

| Arm                  | Gating | Effect                                                                                        |
| -------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `database`, `auth`   | gated  | Adds `DatabasePlugin` / `AuthPlugin`.                                                         |
| `session`            | gated  | Adds `SessionPlugin`; with `csrf`, its form-CSRF middleware at priority 275.                  |
| `di`                 | gated  | Adds `DiPlugin`. **Changes how every decorated service is constructed** — see the note below. |
| `realtime.websocket` | gated  | Adds `WebSocketPlugin`.                                                                       |
| `realtime.sse`       | gated  | Adds `SsePlugin`.                                                                             |
| `realtime.backplane` | gated  | Adds `RealtimeBackplanePlugin` at `PLUGIN_PRIORITY.HIGH`, so it precedes both consumers.      |
| everything else      | on     | Registered with defaults when the arm is omitted.                                             |

Notes:

- **`realtime: {}` adds nothing and is not an error.** `backplane: {}` selects the in-process
  `'memory'` transport, whose discriminant is optional.
- **`backplane: { transport: 'messaging' }` needs a broker.** The microservice and full-stack tiers
  always register `MessagingPlugin`; the REST tier does not, so on that tier the backplane's own
  `register()` throws naming `MessagingPlugin`. The starter adds no second check of its own.
- **`di` is opt-in because it is not additive.** `DecoratorPlugin` branches on the presence of a
  container, so with this arm each `@Injectable` becomes a container provider honoring its `scope`;
  without it those classes are constructed directly and registered in the `ServiceRegistry`.
- **Workers portability varies by arm.** `di`, `realtime.websocket`, `realtime.sse`, and a
  `'memory'` backplane are Workers-portable. A `'redis'` backplane is not (raw socket); a
  `'messaging'` backplane is portable only if its broker is.
- **`session` is gated because it cannot be defaulted.** `SessionPlugin` throws during `register()`
  without an adequate secret, so an always-on arm would stop every starter application from booting
  until one was supplied. It is also genuinely optional: a token-authenticated API has no cookie.
- **No arm sets a plugin's `name`.** Each registers on the bare capability token; register a second
  instance yourself on the returned app.

### Composing from configuration

```typescript
import { createFullStackAppFromConfig } from '@hono-enterprise/full-stack-starter';

const app = await createFullStackAppFromConfig((config) => ({
  database: { type: 'prisma', url: config.getOrThrow<string>('DATABASE_URL') },
  session: { secret: config.getOrThrow<string>('SESSION_SECRET'), csrf: {} },
}), { config: { envFilePath: ['.env.local', '.env'] } });

await app.start({ port: 3000 });
```

Plugin options must be decided **before** the plugins are constructed, which is before
`ConfigPlugin` has registered anything. This factory closes that ordering gap for every option at
once: it builds runtime services, loads configuration, calls the resolver, and passes the SAME
snapshot into the application under `config.instance` — so `app.services.get(CAPABILITIES.CONFIG)`
returns the exact object the resolver saw, rather than a second one read a moment later.

Signature:
`(build: (config: IConfig) => FullStackStarterOptions, options?: FromConfigOptions) =>
Promise<IKernelApplication>`,
where
`FromConfigOptions = { config?: ConfigPluginOptions; env?: Readonly<Record<string, unknown>> }`. The
resolver is called exactly once; if it throws, or configuration fails to load, the returned promise
rejects and no partially-composed application exists.

**`env` is required on Cloudflare Workers.** Bindings arrive as the `env` argument of the `fetch`
handler, never process-wide, so runtime services built before a request report an EMPTY environment
there — the composition would see no configuration at all, and a resolver calling `getOrThrow` would
fail on the first request and every request after it, because the boot promise is memoised. Pass the
handler's `env` straight through; non-string values (KV, D1, R2 bindings) are ignored. Omit it on
Node, Deno, and Bun, where the detected runtime reads the environment itself.
`honoe new --template full-stack` wires this for you on all four targets.

This is why **no plugin option carries a config-key shorthand** (`urlFromConfig`,
`endpointFromConfig`): such a field would need its value at the same impossible moment.
`secretFromConfig` is further out of reach — secrets are served by `secrets-plugin` under
`CAPABILITIES.SECRETS`, which exists only after registration, so a plugin needing one resolves it
lazily at use time.

A complete REST API using the REST starter:

```typescript
import { createRestApp } from '@hono-enterprise/rest-starter';
import { z } from 'zod';

const app = createRestApp({
  config: {
    validationSchema: z.object({
      PORT: z.coerce.number().default(3000),
      DATABASE_URL: z.string().url(),
      JWT_SECRET: z.string().min(32),
    }),
  },
  database: {
    type: 'prisma',
    // Illustrative: in production, resolve via IConfig or similar
    options: { url: process.env.DATABASE_URL },
  },
  auth: {
    jwt: {
      // Illustrative: in production, resolve via IConfig or similar
      secret: process.env.JWT_SECRET,
      expiresIn: '1h',
    },
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

await app.start({ port: 3000 });
console.log('API running at http://localhost:3000');
console.log('Docs at http://localhost:3000/docs');
```

## Microservice Application

A microservice with messaging, queue, and telemetry:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';

const app = createMicroserviceApp({
  database: {
    type: 'prisma',
    // Illustrative: in production, resolve via IConfig or similar
    options: { url: process.env.DATABASE_URL },
  },
  messaging: {
    broker: 'rabbitmq',
    options: {
      // Illustrative: in production, resolve via IConfig or similar
      url: process.env.RABBITMQ_URL,
    },
    exchange: 'orders',
  },
  queue: {
    adapter: 'redis',
    options: {
      // Illustrative: in production, resolve via IConfig or similar
      url: process.env.REDIS_URL,
    },
  },
  telemetry: {
    serviceName: 'order-service',
    exporter: 'otlp',
    endpoint:
      // Illustrative: in production, resolve via IConfig or similar
      process.env.OTLP_ENDPOINT,
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

await app.start({ port: 3001 });
```

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
    CqrsPlugin(), // add cross-cutting behaviors via `behaviors: [myBehavior]` (typed IPipelineBehavior[])
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

## Service Discovery

Turns a logical service name into a reachable address, balances across the instances behind it, and
takes them out of rotation when callers report failures. Registers an `IServiceDiscovery` under
`CAPABILITIES.SERVICE_DISCOVERY` (`'service-discovery'`). Zero npm dependencies — the HTTP providers
run on web-standard `fetch` and the DNS provider on the optional `IRuntimeServices.dns`.

### Registration

```typescript
import { ServiceDiscoveryPlugin } from '@hono-enterprise/service-discovery-plugin';

app.register(ServiceDiscoveryPlugin({
  provider: 'consul',
  address: 'http://127.0.0.1:8500',
  strategy: 'round-robin',
}));
```

### Usage

```typescript
import { CAPABILITIES, type IServiceDiscovery } from '@hono-enterprise/common';

const discovery = ctx.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

const instances = await discovery.resolve('billing');
const instance = await discovery.pick('billing', { strategy: 'weighted-random' });
const url = await discovery.resolveUrl('billing', '/invoices');

discovery.report(instance!, 'failure');

const unsubscribe = await discovery.watch('billing', (list) => {
  console.log(`billing now has ${list.length} instances`);
});
```

### Contract

```typescript
interface IServiceDiscovery {
  resolve(serviceName: string): Promise<readonly ServiceInstance[]>;
  pick(serviceName: string, options?: PickOptions): Promise<ServiceInstance | null>;
  resolveUrl(
    serviceName: string,
    path?: string,
    options?: PickOptions,
  ): Promise<string | null>;
  report(instance: ServiceInstance, outcome: ServiceOutcome): void;
  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe>;
}

interface ServiceInstance {
  readonly id: string;
  readonly serviceName: string;
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly weight?: number;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

interface PickOptions {
  readonly strategy?: LoadBalanceStrategy;
}

type LoadBalanceStrategy = 'round-robin' | 'random' | 'weighted-random';
type ServiceOutcome = 'success' | 'failure';
```

Registration and deregistration of _this_ instance are deliberately **not** on the contract — the
plugin drives its own lifecycle hooks, so a `registerSelf()`/`deregisterSelf()` pair here would be
surface no application code path reads.

### Providers

`ServiceDiscoveryPluginOptions` is a **union discriminated on `provider`**, so a missing per-arm
credential is a compile error rather than a startup throw.

| Arm            | Reads                              | `watch()`                   | Runtimes            |
| -------------- | ---------------------------------- | --------------------------- | ------------------- |
| `'static'`     | A literal list in the options      | Fires once, then never      | All, incl. Workers  |
| `'consul'`     | `GET /v1/health/service/:service`  | Blocking queries (push)     | All, incl. Workers  |
| `'kubernetes'` | EndpointSlices from the API server | Watch stream (push)         | All, incl. Workers¹ |
| `'dns'`        | `SRV` or `A`/`AAAA` records        | Polled at `watchIntervalMs` | Deno, Node, Bun     |
| `'custom'`     | The application's own provider     | Whatever it implements      | Any                 |

¹ Workers needs an explicit `token`: it has no file system to read the projected service-account
token from.

### Options

| Option             | Arms               | Default                      | Behavior                                                             |
| ------------------ | ------------------ | ---------------------------- | -------------------------------------------------------------------- |
| `provider`         | all                | —                            | Discriminant; always explicit                                        |
| `cacheTtlMs`       | all                | `30_000`                     | `0` disables caching so every `resolve` hits the backend             |
| `strategy`         | all                | `'round-robin'`              | Overridable per `pick()` call via `PickOptions.strategy`             |
| `ejection`         | all                | see below                    | `false` disables outlier ejection entirely                           |
| `selfRegistration` | consul, custom     | —                            | Throws `SelfRegistrationNotSupportedError` on the other arms         |
| `watchIntervalMs`  | static, dns        | `30_000`                     | Absent from the push-based arms rather than silently unread          |
| `services`         | static             | —                            | Unknown name resolves to `[]`, never a throw                         |
| `address`          | consul             | —                            | Agent base URL                                                       |
| `token`            | consul             | —                            | Sent as `X-Consul-Token`; the header is omitted entirely when unset  |
| `datacenter`       | consul             | —                            | Sent as `?dc=`                                                       |
| `waitSeconds`      | consul             | `30`                         | Blocking-query `wait`, clamped to Consul's documented maximum of 600 |
| `namespace`        | kubernetes         | —                            | Required                                                             |
| `apiServer`        | kubernetes         | in-cluster env               | Absent both, `register()` throws                                     |
| `token`            | kubernetes         | projected token file         | Used verbatim; otherwise the file is re-read behind a 60 s memo      |
| `portName`         | kubernetes         | —                            | Unset with one port uses it; unset with several throws               |
| `mode`             | dns                | —                            | `'srv'` honours RFC 2782 priority tiers; `'a'` reads address records |
| `domainTemplate`   | dns                | `'{service}.service.consul'` | `{service}` is substituted with the requested name                   |
| `port`             | dns (`'a'` only)   | —                            | Mandatory on that arm: DNS address records carry no port             |
| `secure`           | consul, k8s, dns   | `false`                      | Sets `ServiceInstance.secure`, which decides the `https` scheme      |
| `http`             | consul, kubernetes | `fetch`                      | Overrides `createDefaultDiscoveryHttp()`                             |
| `discovery`        | custom             | —                            | The application's own `DiscoveryProvider`, used as supplied          |

### Outlier ejection

`report(instance, outcome)` feeds a per-process ejection tracker. Defaults:
`{ failureThreshold: 5, windowMs: 30_000, durationMs: 30_000, maxEjectionPercent: 50 }`. A
`'success'` clears that instance's window and un-ejects it immediately.

`pick()` filters ejected instances; `resolve()` does **not** — it reports what discovery knows,
while `pick()` reports what is usable. `maxEjectionPercent` caps the share of a service ejected at
once, and when every instance is ejected anyway `pick()` falls back to the unfiltered list rather
than returning `null`: a correlated failure ejects the whole pool at once, and serving nothing turns
a partial outage into a total one.

This is a different mechanism from `IResilienceService.wrap`'s circuit breaker, not a duplicate of
it. `wrap` breaks a **call site**; ejection removes a **pool member** while the call site stays
open. They compose by re-`pick()`ing inside the wrapped call.

### Self-registration

Only the Consul arm (and a custom provider implementing `registerSelf`) can advertise this instance.
Registration runs at `onBootstrap`; deregistration runs at **`onStopping`**, the lifecycle hook that
fires before the application starts refusing requests, so the change propagates while traffic is
still being served. `selfRegistration.drainDelayMs` (default `0`) then holds that window open.

`selfRegistration.check` is **not optional** and cannot be disabled — it defaults to
`{ httpPath: '/health', intervalSeconds: 10, deregisterAfterSeconds: 60 }`. `onBootstrap` runs
before the socket binds, so the instance is advertised a moment before it can serve; that window is
harmless only because Consul marks a newly registered service critical until its first check passes
and every read here sends `passing=true`.

### Exports

| Export                              | Kind      | Purpose                                                            |
| ----------------------------------- | --------- | ------------------------------------------------------------------ |
| `ServiceDiscoveryPlugin`            | function  | The plugin factory                                                 |
| `ServiceDiscoveryPluginOptions`     | type      | The discriminated option union                                     |
| `StaticDiscoveryOptions`            | interface | The `'static'` arm                                                 |
| `ConsulDiscoveryOptions`            | interface | The `'consul'` arm                                                 |
| `KubernetesDiscoveryOptions`        | interface | The `'kubernetes'` arm                                             |
| `DnsDiscoveryOptions`               | type      | The `'dns'` arm (`SrvDnsDiscoveryOptions \| ADnsDiscoveryOptions`) |
| `CustomDiscoveryOptions`            | interface | The `'custom'` arm                                                 |
| `StaticServiceDefinition`           | interface | One entry of a static service list                                 |
| `EjectionOptions`                   | interface | Ejection tuning                                                    |
| `SelfRegistration`                  | interface | What this instance advertises                                      |
| `SelfRegistrationCheck`             | interface | The mandatory health check                                         |
| `DiscoveryProvider`                 | interface | The provider port, for the `'custom'` arm                          |
| `StaticProvider`                    | class     | The `'static'` provider                                            |
| `ConsulProvider`                    | class     | The `'consul'` provider                                            |
| `KubernetesProvider`                | class     | The `'kubernetes'` provider                                        |
| `DnsProvider`                       | class     | The `'dns'` provider                                               |
| `IDiscoveryHttp`                    | interface | The injectable HTTP seam (buffered + streaming)                    |
| `DiscoveryHttpResponse`             | interface | Buffered response shape                                            |
| `DiscoveryHttpStream`               | interface | Streaming response shape                                           |
| `createDefaultDiscoveryHttp`        | function  | The default seam over `fetch`                                      |
| `DiscoveryUnavailableError`         | class     | Cold backend failure, missing DNS resolver, k8s multi-port         |
| `SelfRegistrationNotSupportedError` | class     | `selfRegistration` on an arm that cannot register                  |

### Notes

- Registers a `service-discovery` health indicator reporting `provider`, `cachedServices`,
  `watchedServices`, `ejectedInstances`, and `degraded`. It reads the cache's own observed state and
  never issues a backend call, so a health scrape does not become load against Consul. `'degraded'`
  means a refresh failed and a stale snapshot is being served; `'down'` is unreachable by
  construction, because with nothing cached the caller already received a
  `DiscoveryUnavailableError`.
- `onClose` unsubscribes every active watch and clears ejection state.
- The cache is read-through on the **monotonic** clock, with per-service in-flight coalescing (a
  burst of concurrent `pick()`s for one cold service issues one backend read) and stale-on-failure.
  A watch event invalidates that name's entry immediately.
- `pick` and `resolveUrl` funnel through one implementation, so both honour the same configured
  strategy and the same ejection filter.
- Ejection state is **per-process**. A cluster-wide view is a distributed-consensus problem and is
  not attempted.
- In-cluster Kubernetes needs `DENO_CERT` / `NODE_EXTRA_CA_CERTS` pointed at
  `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`; no code change fixes the cluster CA from
  inside the process. The `http` option is the escape hatch for a caller-supplied TLS-configured
  client.

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
app.register(AuthPlugin({ jwt: { secret: config.get('JWT_SECRET') } }));

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

| Export                        | Kind     | Purpose                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                | const    | Standard capability tokens — the single source of truth. Includes `SSE: 'sse'` (SSE hub), `SSR: 'ssr'` (SSR framework), `WORKER_POOL: 'worker-pool'` (worker thread pool), `REALTIME_BACKPLANE: 'realtime-backplane'` (cross-replica fan-out), `SESSION: 'session'` (cookie sessions) |
| `createCapabilityToken(name)` | function | Validates and creates a custom (optionally dot-namespaced) token; throws `TypeError` on invalid names                                                                                                                                                                                 |
| `encodeFrameData(data)`       | function | Encodes a WebSocket payload for a realtime backplane; binary becomes base64                                                                                                                                                                                                           |
| `decodeFrameData(payload)`    | function | Decodes a backplane payload back to `string` or `Uint8Array`                                                                                                                                                                                                                          |
| `parseCookie(header)`         | function | Parses a `Cookie` header into a name→value record; percent-decodes, strips RFC 6265 quoting, first occurrence wins. Here because the session plugin and the decorator plugin's `@Cookie` both need it and no plugin may import another                                                |
| `serializeCookie(n, v, a?)`   | function | Serializes a `Set-Cookie` value; percent-encodes so a payload cannot inject attributes, and forces `Secure` alongside `SameSite=None`. Throws `TypeError` on an invalid name or a non-integer `maxAge`                                                                                |
| `isWorkerReadySignal(m)`      | function | Guard: narrows a worker message to a `WorkerReadySignal`                                                                                                                                                                                                                              |
| `isWorkerTaskRequest(m)`      | function | Guard: narrows a worker message to a `WorkerTaskRequest`                                                                                                                                                                                                                              |
| `isWorkerTaskReply(m)`        | function | Guard: narrows a worker message to a `WorkerTaskReply`                                                                                                                                                                                                                                |
| `PLUGIN_PRIORITY`             | const    | Well-known plugin priority bands (`HIGHEST`…`LOWEST`)                                                                                                                                                                                                                                 |
| `ok(value)` / `err(error)`    | function | `Result` constructors                                                                                                                                                                                                                                                                 |
| `isOk(r)` / `isErr(r)`        | function | `Result` type guards                                                                                                                                                                                                                                                                  |
| `unwrap(r)`                   | function | Returns the `Ok` value or throws the `Err` error                                                                                                                                                                                                                                      |
| `some(value)` / `none()`      | function | `Option` constructors (`none()` returns a frozen singleton)                                                                                                                                                                                                                           |
| `isSome(o)` / `isNone(o)`     | function | `Option` type guards                                                                                                                                                                                                                                                                  |
| `fromNullable(v)`             | function | Converts `T \| null \| undefined` to `Option<T>`                                                                                                                                                                                                                                      |

### Types

| Group               | Exports                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens              | `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                                                                                           |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PluginPriority`                                                                                                                                                                                                     |
| Utilities           | `Result<T, E>`, `Ok<T>`, `Err<E>`, `Option<T>`, `Some<T>`, `None`                                                                                                                                                                                                                                                 |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, `StartOptions`                                                                                                                                                                                                                                                       |
| Plugin context APIs | `IMiddlewareApi`, `MiddlewareOptions`, `IRouterApi`, `IEnvironmentApi`, `EnvVarSpec`, `IHealthApi`, `IMetricsApi`, `IOpenApiApi`, `IDecoratorApi`, `DecoratorHandler`, `ICliApi`, `CliCommandHandler`, `ILifecycleApi`, `IMetadataStore`                                                                          |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory<T>`                                                                                                                                                                                                                                                        |
| HTTP                | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `NextFunction`, `RouteHandler`, `RouteDefinition`, `RouteSchema`, `HandlerResult`, `ResponseSnapshot`                                                                                                                            |
| Runtime             | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`, `IWorkerHost`, `IWorkerHandle`, `TimerHandle`, `ServerHandle`, `StatResult`                                                                                                                                                                                    |
| DI (optional)       | `IContainer`, `Constructor<T>`, `ServiceScope`, `Provider<T>`, `ClassProvider<T>`, `FactoryProvider<T>`, `ValueProvider<T>`, `ProviderOptions`                                                                                                                                                                    |
| Logging             | `ILogger`, `LogMetadata`                                                                                                                                                                                                                                                                                          |
| Config              | `IConfig`                                                                                                                                                                                                                                                                                                         |
| Validation          | `IValidationService`, `ValidationTarget`, `ValidationIssue`                                                                                                                                                                                                                                                       |
| Health              | `IHealthIndicator`, `HealthIndicatorFn`, `HealthCheckResult`, `IHealthService`, `HealthReport`, `HealthStatus`                                                                                                                                                                                                    |
| Metrics             | `IMetric`, `MetricConfig`, `IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, `MetricOptions`                                                                                                                                                                                                     |
| Auth                | `IPrincipal`, `IJwtService`, `JwtSignOptions`                                                                                                                                                                                                                                                                     |
| Database            | `IOrmAdapter`, `ITransaction`                                                                                                                                                                                                                                                                                     |
| Cache               | `ICacheStore`                                                                                                                                                                                                                                                                                                     |
| Events              | `IEventBus`, `IDomainEvent<T>`, `EventHandler<T>`, `Unsubscribe`                                                                                                                                                                                                                                                  |
| Messaging           | `IMessageBroker`, `ISubscription`, `MessageHandler<T>`, `MessageMetadata`, `SubscribeOptions`, `RequestOptions`, `RequestHandler<TReq, TRes>`                                                                                                                                                                     |
| Queue               | `IQueue`, `IJob<T>`, `JobProcessor<T>`, `AddJobOptions`, `ProcessOptions`, `RecurringOptions`                                                                                                                                                                                                                     |
| Scheduler           | `IScheduler`, `ScheduledJob<T>`, `SchedulerJobHandler<T>`, `ScheduleOptions<T>`, `RetryOptions`, `SchedulerBackoff`                                                                                                                                                                                               |
| Secrets             | `ISecretManager`                                                                                                                                                                                                                                                                                                  |
| Audit               | `IAuditLogger`, `AuditEntry`                                                                                                                                                                                                                                                                                      |
| Resilience          | `ICircuitBreaker`, `CircuitState`, `IResilienceService`, `WrapOptions`, `CircuitBreakerPolicy`, `RetryPolicy`, `BulkheadPolicy`, `BackoffStrategy`, `ResilientCall`, `HardenedCall`                                                                                                                               |
| Storage             | `IStorage`, `SignedUrlOptions`                                                                                                                                                                                                                                                                                    |
| Mail                | `IMailer`, `MailMessage`                                                                                                                                                                                                                                                                                          |
| Notifications       | `INotifier`, `NotificationMessage`                                                                                                                                                                                                                                                                                |
| Feature flags       | `IFeatureFlags`, `FlagContext`                                                                                                                                                                                                                                                                                    |
| Multi-tenancy       | `IMultiTenancyService`, `ITenantRepository`, `ITenantResolver`, `ITenant`                                                                                                                                                                                                                                         |
| SSR                 | `ISsrService`                                                                                                                                                                                                                                                                                                     |
| SSE                 | `ISseService`, `ISseConnection`, `SseChannel`, `SseMessage`                                                                                                                                                                                                                                                       |
| Realtime backplane  | `IRealtimeBackplane`, `RealtimeFrame`, `RealtimeFrameHandler`, `RealtimeFrameKind`, `EncodedPayload`                                                                                                                                                                                                              |
| WebSocket           | `IWebSocketService`, `IWebSocketConnection`, `IWebSocketTransport`, `WebSocketRoom`, `RoomBroadcastOptions`, `WebSocketHandlers`, `WebSocketRouteOptions`, `WebSocketConnectionContext`, `WebSocketCloseEvent`, `WebSocketReadyState`, `WebSocketEventSink`, `WebSocketUpgradeDecision`, `WebSocketUpgradeRouter` |
| Worker pool         | `IWorkerPool`, `WorkerRunOptions`, `TaskPoolStats`, `WorkerReadySignal`, `WorkerTaskRequest`, `WorkerTaskReply`, `WorkerErrorShape`                                                                                                                                                                               |
| Session             | `ISessionService`, `ISession`, `ISessionStore`, `SessionData`, `CookieAttributes`                                                                                                                                                                                                                                 |
| Service discovery   | `IServiceDiscovery`, `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`                                                                                                                                                                                                                    |
| DNS                 | `IDnsResolver`, `SrvRecord`                                                                                                                                                                                                                                                                                       |
| gRPC                | `IGrpcService`, `GrpcServiceDefinition`, `ServiceImpl`, `GrpcServingStatus`, `RpcFetchHandler`                                                                                                                                                                                                                    |

Contract notes:

- `IPluginContext.runtime` is **non-optional**: a runtime provider is mandatory and registers first,
  so every plugin may rely on it (ARCHITECTURE.md §7).
- `ILifecycleApi.onStopping(fn)` runs at the very start of `stop()`, **before** the application
  begins refusing new requests with a 503 and before the socket closes — the only hook that fires
  while the application is still serving normally. It exists for "tell the outside world to stop
  routing here" work, most obviously deregistering from service discovery; doing that in
  `onShutdown` leaves callers routed at a closed port for up to one health-check interval. Hooks run
  LIFO and are awaited, so a slow hook delays shutdown. A rejecting hook surfaces from `stop()`, but
  only after the drain, the socket close, and the `onShutdown`/`onClose` phases have run: a failing
  hook must not be able to prevent the application from stopping. With no hook registered the phase
  is skipped and `stop()` behaves exactly as before.
- Schema positions (`RouteSchema`, `IValidationService`, `IOpenApiApi`) are typed `unknown` so
  `common` carries no validator dependency; the validation plugin narrows them (Zod by default).
- `HandlerResult` is an opaque brand only the kernel constructs; handlers obtain it from `IResponse`
  terminal methods (`json`, `text`, `send`, `redirect`, `stream`).
- `IResponse` has two header setters with distinct semantics: `header(name, value)` **replaces** any
  existing value for `name` (`Headers.set`), while `appendHeader(name, value)` **adds** a value
  without removing existing ones (`Headers.append`). `appendHeader` is the correct way to emit
  multiple headers of the same name — most notably several `Set-Cookie` headers (e.g. access +
  refresh cookies). Both chain (`return this`).
- `IResponse.stream(body: ReadableStream<Uint8Array>): HandlerResult` — sends a streaming response
  body. The runtime maps this to `new Response(streamBody, { status, headers })`; streaming is free
  on every platform (Node via Hono, Deno, Bun, Cloudflare Workers) with no buffer-then-send. Added
  in Milestone 42.
- `IResponse.snapshot()` returns a **discriminated union** keyed on `streaming`: when `false`,
  `body` is `Uint8Array | string | null` (buffered); when `true`, `body` is
  `ReadableStream<Uint8Array>` (live stream). This allows middleware to safely inspect the response
  without draining a live stream — middleware that reads the body must check `streaming` first.
  Widened from the flat shape added in Milestone 11 to a discriminated union in Milestone 42.
- `IRequest.signal?: AbortSignal` — an abort signal that fires when the underlying HTTP connection
  is severed (client disconnect, timeout). Populated by the HTTP adapter from the native
  `Request.signal`; optional because injected / test requests may not carry one. Added in
  Milestone 42.
- `IRequestContext.signal: AbortSignal` — required abort signal (always present). Populated by
  `createRequestContext` from the native `Request.signal`; falls back to a non-aborting sentinel for
  injected/test contexts so handlers always have a live signal to listen on. Added in Milestone 42.
- `CAPABILITIES.SSE` (`'sse'`) — the capability token under which the SsePlugin registers the
  `ISseService`. The service provides real-time, one-way server-to-client messaging over an SSE
  stream built on `IResponse.stream()`. Added in Milestone 43.
- `CAPABILITIES.SSR` (`'ssr'`) — the capability token under which the React Router plugin registers
  the `ISsrService`. The service provides server-side rendering by delegating to React Router's
  request handler and writing back the result via `IResponse`. Added in Milestone 44.
- `CAPABILITIES.REALTIME_BACKPLANE` (`'realtime-backplane'`) — the capability token under which
  `RealtimeBackplanePlugin` registers an `IRealtimeBackplane`. Consumed **optionally** by the
  WebSocket and SSE plugins: present, their rooms and channels fan out across replicas; absent, they
  broadcast in-process exactly as before. Added in Milestone 47.
- `CAPABILITIES.WEBSOCKET` (`'websocket'`) — the capability token under which the WebSocket plugin
  registers the `IWebSocketService`. The service provides full-duplex, bidirectional real-time
  messaging: exact-path routes with lifecycle handlers, named broadcast rooms, and an
  application-level heartbeat. Distinct from `SSE`, which is one-way. Added in Milestone 46.
- `CAPABILITIES.SESSION` (`'session'`) — the capability token under which `SessionPlugin` registers
  the `ISessionService`. Provides cookie-backed sessions for server-rendered applications: an
  encrypted self-contained cookie by default, or an opaque id over an `ISessionStore`. Distinct from
  `AUTHENTICATION`, which establishes _who_ a caller is — a session carries per-visitor state and
  exists for anonymous visitors too. Added in Milestone 48.
- `CAPABILITIES.GRPC` (`'grpc'`) — the capability token under which `GrpcPlugin` registers the
  `IGrpcService`. The service provides gRPC/Connect co-serving on the same port as ordinary Hono
  routes, using the optional `IHttpAdapter.setRpcHandler?` seam. Added in Milestone 49.
- `CAPABILITIES.GRAPHQL` (`'graphql'`) — the capability token under which `GraphqlPlugin` registers
  the `IGraphqlService`. The service provides schema-first and code-first GraphQL execution over
  ordinary kernel routes with media-type negotiation. Added in Milestone 51.
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
validates environment variables, and dispatches requests. Implemented in **Milestone 2**; route
matching was delegated to Hono in **Milestone 22** (behind the unchanged `IRouterApi` contract).
This section is the authoritative export list (AI_GUIDELINES §10.5). All exports carry full JSDoc.

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
- The kernel emits only **bare status JSON** (`{ error: 'Bad Request' }` for a malformed request URL
  or malformed percent-escape in the path → `400`; `{ error: 'Not Found' }` → `404`;
  `{ error: 'Internal Server Error' }` → `500`; `{ error: 'Service Unavailable' }` for a request
  arriving while `stop()` is draining → `503`). Error formatting belongs to the exceptions package,
  not the kernel.
- **`inject()` body semantics.** `InjectResponse.body` is text: a byte body written with
  `response.send(bytes)` is UTF-8 decoded rather than reported as `null`, and `json()` parses it. A
  **streaming** response cannot be presented as text without draining the live stream, so `inject()`
  throws and points at `app.fetch()` with a web `Request` instead.
- **`app.fetch()` rejects rather than throwing synchronously** when no `http-adapter` capability is
  registered, so the Workers `export default { fetch: app.fetch }` entry point sees a failed promise
  instead of an unhandled exception.
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

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, Bun, and
Cloudflare Workers.

> **M23 replaced the old HTTP server adapters with the new `IHttpAdapter` contract
> (`setHandler`/`fetch`/`listen`/`close`)** and added the Cloudflare Workers adapter.

### Values (runtime exports)

| Export                            | Kind     | Purpose                                                                                    |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `RuntimePlugin`                   | function | Creates the runtime plugin (registers `CAPABILITIES.RUNTIME`)                              |
| `detectRuntime`                   | function | Detects the current runtime platform (`'node' \| 'deno' \| 'bun' \| 'cloudflare-workers'`) |
| `createRuntimeServices`           | function | Creates `IRuntimeServices` for the detected platform, without an application               |
| `buildNodeHost`                   | function | Builds a `NodeHost` from injected `NodeModules` (defaults to real `node:` built-ins)       |
| `buildBunHost`                    | function | Builds a `BunHost` from injected `BunModules` (defaults to `node:` built-ins)              |
| `createDenoRuntimeServices`       | function | Creates `IRuntimeServices` backed by Deno APIs                                             |
| `createNodeRuntimeServices`       | function | Creates `IRuntimeServices` backed by Node.js APIs                                          |
| `createBunRuntimeServices`        | function | Creates `IRuntimeServices` backed by Bun APIs                                              |
| `createCloudflareRuntimeServices` | function | Creates `IRuntimeServices` backed by Cloudflare Workers APIs (edge-compatible)             |
| `DenoHttpAdapter`                 | class    | Deno HTTP server adapter implementing `IHttpAdapter`                                       |
| `NodeHttpAdapter`                 | class    | Node.js HTTP server adapter implementing `IHttpAdapter`                                    |
| `BunHttpAdapter`                  | class    | Bun HTTP server adapter implementing `IHttpAdapter`                                        |
| `CloudflareWorkersHttpAdapter`    | class    | Cloudflare Workers HTTP adapter implementing `IHttpAdapter` (fetch-only, no listen)        |
| `createWebWorkerHost`             | function | Creates an `IWorkerHost` over the web `Worker` API (Deno/Bun); throws if `Worker` absent   |
| `createNodeWorkerHost`            | function | Creates an `IWorkerHost` over `node:worker_threads`                                        |
| `defineWorkerTask`                | function | **`@hono-enterprise/runtime/worker` subpath.** Registers a worker module's task handler    |
| `isDenoHttpServerHandle`          | function | Type guard for `DenoHttpServerHandle`                                                      |
| `isNodeHttpServerHandle`          | function | Type guard for `NodeHttpServerHandle`                                                      |
| `isBunHttpServerHandle`           | function | Type guard for `BunHttpServerHandle`                                                       |

WebSocket upgrade support (Milestone 46) — shared primitives:

| Export                      | Kind     | Purpose                                                                         |
| --------------------------- | -------- | ------------------------------------------------------------------------------- |
| `isWebSocketUpgradeRequest` | function | Whether request headers describe an RFC 6455 upgrade (`Upgrade` + `Connection`) |
| `createWebSocketTransport`  | function | Wraps a web-API socket as an `IWebSocketTransport`                              |
| `normalizeFrame`            | function | Normalizes an inbound frame payload to `string \| Uint8Array`                   |
| `toReadyState`              | function | Maps the web WebSocket numeric `readyState` to `WebSocketReadyState`            |
| `toTransportError`          | function | Coerces an error-event payload into a real `Error`                              |

Per-runtime upgrade seams:

| Export                                 | Kind     | Purpose                                                                           |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `bindDenoSocketToSink`                 | function | Binds a `Deno.upgradeWebSocket` socket's `on*` handlers to a `WebSocketEventSink` |
| `createBunWebSocketHandlers`           | function | Builds the serve-time handler object for `Bun.serve`'s `websocket` option         |
| `bindCloudflareSocketToSink`           | function | Accepts a Workers `WebSocketPair` server half and binds it to a sink              |
| `createDefaultCloudflareWebSocketHost` | function | Builds the Workers host from the real `WebSocketPair` global                      |
| `buildUpgradeResponseInit`             | function | Builds the Workers 101 `ResponseInit` carrying the client socket                  |
| `NodeUpgradeCoordinator`               | class    | Owns the `ws` server for one Node adapter and performs the raw handshake          |
| `adaptWsModule`                        | function | Narrows an imported `ws` module to `WsModuleLike`                                 |
| `loadWsModule`                         | function | Lazily imports `npm:ws@^8.18.0`; throws with the install command if absent        |
| `bindWsSocketToSink`                   | function | Binds a `ws` socket's events to a `WebSocketEventSink`                            |
| `createWsTransport`                    | function | Wraps a `ws` socket as an `IWebSocketTransport`                                   |
| `toWsReadyState`                       | function | Maps a `ws` numeric ready state to `WebSocketReadyState`                          |
| `createUpgradeRequest`                 | function | Rebuilds a web `Request` from Node's `upgrade` event arguments                    |
| `asUpgradeEmitter`                     | function | Probes a Node server handle for the raw `upgrade` event                           |
| `rejectRawUpgrade`                     | function | Writes an HTTP status line to a raw socket and destroys it                        |

### Types

| Export                              | Kind | Purpose                                                                        |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `RuntimeOptions`                    | type | Options for `RuntimePlugin` (`{ platform?: RuntimePlatform }`)                 |
| `CreateRuntimeServicesOptions`      | type | Options for `createRuntimeServices` (`platform`, `adapters`)                   |
| `RuntimeAdapterFactories`           | type | Platform → runtime adapter factory map                                         |
| `GlobalScope`                       | type | Injectable global scope shape for `detectRuntime`                              |
| `DenoHost`                          | type | Host interface for the Deno adapter (extension point)                          |
| `DenoFileInfo`                      | type | File info returned by `DenoHost.stat()`                                        |
| `DenoDirEntry`                      | type | Directory entry yielded by `DenoHost.readDir()` (an `AsyncIterable`)           |
| `NodeHost`                          | type | Host interface for the Node adapter (extension point)                          |
| `NodeFsInfo`                        | type | File info returned by `NodeHost.stat()`                                        |
| `NodeModules`                       | type | Injectable Node built-ins for `buildNodeHost` (testing seam)                   |
| `BunHost`                           | type | Host interface for the Bun adapter (extension point)                           |
| `BunFileInfo`                       | type | File info returned by `BunHost.stat()`                                         |
| `BunModules`                        | type | Injectable built-ins for `buildBunHost` (testing seam)                         |
| `DenoHttpServerHandle`              | type | Internal server handle for DenoHttpAdapter                                     |
| `NodeHttpServerHandle`              | type | Internal server handle for NodeHttpAdapter                                     |
| `BunHttpServerHandle`               | type | Internal server handle for BunHttpAdapter                                      |
| `CloudflareWorkersHttpServerHandle` | type | Internal server handle for CloudflareWorkersHttpAdapter                        |
| `DenoServeHost`                     | type | Injectable host interface for DenoHttpAdapter (extension point)                |
| `NodeServeHost`                     | type | Injectable host interface for NodeHttpAdapter (extension point)                |
| `BunServeHost`                      | type | Injectable host interface for BunHttpAdapter (extension point)                 |
| `BunServer`                         | type | Bun server handle returned by `Bun.serve`                                      |
| `HttpAdapterFactories`              | type | Platform→adapter factory map for RuntimePlugin                                 |
| `WebWorkerGlobals`                  | type | Injectable seam for `createWebWorkerHost` (`Worker` + concurrency)             |
| `WebWorkerLike`                     | type | Minimal web `Worker` shape the host consumes                                   |
| `NodeWorkerModules`                 | type | Injectable seam for `createNodeWorkerHost` (`Worker` + `availableParallelism`) |
| `NodeWorkerLike`                    | type | Minimal `worker_threads.Worker` shape the host consumes                        |
| `WebSocketLike`                     | type | Minimal web `WebSocket` shape the adapters drive                               |
| `DenoWebSocketLike`                 | type | A web socket exposing the `on*` handler properties (Deno)                      |
| `DenoWebSocketUpgrade`              | type | Result shape of `Deno.upgradeWebSocket` (`{ socket, response }`)               |
| `BunServerWebSocket`                | type | Minimal Bun `ServerWebSocket` shape, carrying `data`                           |
| `BunSocketData`                     | type | Per-socket data Bun carries from `upgrade()` to its handlers (`{ sink }`)      |
| `BunWebSocketHandlers`              | type | The serve-time handler object for `Bun.serve`'s `websocket` option             |
| `CloudflareServerSocket`            | type | Workers server-half socket (`accept()` + `addEventListener`)                   |
| `CloudflareWebSocketPair`           | type | A created Workers pair (`{ client, server }`)                                  |
| `CloudflareWebSocketHost`           | type | Injectable seam for the Workers upgrader (extension point)                     |
| `CloudflareUpgradeResponseInit`     | type | The Workers 101 response init, including the `webSocket` member                |
| `WsModuleLike`                      | type | Structural facade over the `ws` module (`{ WebSocketServer }`)                 |
| `WsServerLike`                      | type | Structural facade over a `noServer` `ws` `WebSocketServer`                     |
| `WsSocketLike`                      | type | Structural facade over a `ws` socket                                           |
| `NodeIncomingMessage`               | type | Minimal `node:http.IncomingMessage` shape for building an upgrade `Request`    |
| `RawUpgradeSocket`                  | type | Minimal raw duplex socket shape a refusal writes to                            |
| `UpgradeEmitter`                    | type | A server handle that emits the raw `upgrade` event                             |

Contract notes:

- **The Bun and Deno host defaults are backed by real APIs (retro review, Part 2).**
  `buildBunHost()` builds the default `BunHost` from `node:fs` (sync), `node:os`, and `node:process`
  — which Bun implements — NOT from members of the `Bun` global: Bun's file API is `Bun.file()` /
  `Bun.write()`, and it has no
  `readFile`/`stat`/`readdir`/`mkdir`/`rm`/`realPath`/`hostname`/`exit`. Only `Bun.version` is read
  from the global. On the Deno side, `DenoHost.readDir()` is named and shaped after the real
  `Deno.readDir` — an **`AsyncIterable`**, consumed with `for await`. Both defaults are exercised
  against their real APIs by the test suite, not only through injected fakes.
- **`IRuntimeServices.env` is a snapshot on Deno and Workers**, taken when the services were created
  (`Deno.env.toObject()`, the per-invocation Workers bindings object), and a live pass-through of
  `process.env` on Node and Bun. Nothing in the framework mutates the environment at runtime.
- **M23 replaced M39's HTTP server adapters.** The `IHttpAdapter` contract now exposes the
  web-standard `fetch` entry: `setHandler` installs the framework handler, `fetch` is the universal
  entry point callable without `listen` (Cloudflare Workers), `listen` binds a real TCP socket, and
  `close` tears it down. Adapters (`NodeHttpAdapter`, `DenoHttpAdapter`, `BunHttpAdapter`,
  `CloudflareWorkersHttpAdapter`) are registered under `CAPABILITIES.HTTP_ADAPTER` via
  `RuntimePlugin`.
- **M46 added a fifth, OPTIONAL member: `setUpgradeRouter?(router)`.** It installs a
  `WebSocketUpgradeRouter` consulted for every inbound WebSocket upgrade **before** the request is
  mapped to an `IRequest` and enters the middleware pipeline. That ordering is a correctness
  requirement, not an optimization: the shared mapping pre-reads the body via `arrayBuffer()`, and
  `Deno.upgradeWebSocket` fails once the request body has been disturbed. The router answers accept
  (with the `WebSocketEventSink` the adapter binds its native socket into), reject (with a status),
  or `null` to fall through — so installing a router never changes the behavior of non-WebSocket
  traffic. Because the member is optional, adapters written before this seam remain valid
  implementations; consumers must degrade gracefully when it is absent (see `WebSocketPlugin`, which
  reports `available: false` and fails `route()` with a typed error). All four first-party adapters
  implement it.
- **M49 added a sixth, OPTIONAL member: `setRpcHandler?(handler)`.** It installs an
  `RpcFetchHandler` consulted for every inbound request **after** the WebSocket upgrade
  short-circuit (where one exists) and **before** the request is mapped to an `IRequest`. The
  ordering is again a correctness requirement: a gRPC exchange needs the raw streaming body and
  emits trailers, neither of which `IRequest`/`IResponse` can express, and the shared mapping
  pre-reads the body. The handler answers a `Response` (handled as RPC) or `null` to fall through,
  so installing one never changes the behavior of non-RPC traffic. **The handler is consulted
  exactly once per request, and one returning `null` MUST leave the body unread** — the adapter maps
  that same `Request` afterwards, so a consumed body makes the fall-through fail with "Body already
  consumed". Decide from method, URL and headers (the gRPC plugin matches on a path prefix alone); a
  handler that must inspect the body has to read `request.clone()`. Because the member is optional,
  adapters written before this seam remain valid implementations; consumers must degrade gracefully
  when it is absent (see `GrpcPlugin`, which reports `available: false` and throws
  `GrpcUnavailableError` from `handleRequest`). All four first-party adapters implement it.
- **Migration note — `IRequest.ip` is no longer populated (M23).** The web-standard `fetch` mapping
  does not set `IRequest.ip`; a web `Request` carries no client address. The old M39 Node adapter
  populated `ip` from the native `socket.remoteAddress`, so Node consumers that read
  `ctx.request.ip` will now see `undefined`. Read the client IP from a proxy header
  (`X-Forwarded-For` / `X-Real-IP`) in your own middleware instead — `ip` remains optional on
  `IRequest`.
- The `RuntimePlugin` is **mandatory** in every application. It registers at
  `PLUGIN_PRIORITY.HIGHEST` so its services are available to all other plugins during registration.
- Each adapter factory accepts an injectable `*Host` interface (the documented extension point for
  custom runtimes). The default host binds to the real runtime global via a single sanctioned `as`
  cast; no other casts are used.
- `detectRuntime()` accepts an injectable `globals` parameter (default `globalThis`) so all
  detection branches are testable without real runtimes.
- **`createRuntimeServices(options?)` builds services without an application.** Use it when the
  runtime is needed before any plugin exists — reading the environment to decide which plugins to
  register, which is what `createFullStackAppFromConfig` does. `RuntimePlugin.register` calls this
  same function, so detection, the platform → adapter lookup, and the
  `No runtime adapter factory for platform: <p>` error exist once rather than twice.

  ```typescript
  import { createRuntimeServices } from '@hono-enterprise/runtime';
  import { loadConfig } from '@hono-enterprise/config-plugin';

  const config = await loadConfig(createRuntimeServices());
  ```

  Building a second instance alongside the application's own is safe: the adapters are stateless
  facades over platform globals, holding no connection, cache, or handle registry, and nothing
  compares them by identity. One caveat — `env` is a **snapshot taken at construction**, not a live
  view, so a variable set between two constructions is visible only to the later instance.

---

## API Reference: @hono-enterprise/exceptions

Exception factory functions, `HttpError`, error formatters, and the global error handler middleware.
This is a **plain package** (not a plugin) — it depends on `@hono-enterprise/common` only. Register
the middleware via the application's pipeline.

### Values (exceptions exports)

| Export                | Kind     | Purpose                                                                    |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `HttpError`           | class    | The single HTTP error type (`extends Error`, carries `statusCode`)         |
| `badRequest`          | function | Factory → `400` `HttpError`                                                |
| `unauthorized`        | function | Factory → `401` `HttpError`                                                |
| `forbidden`           | function | Factory → `403` `HttpError`                                                |
| `notFound`            | function | Factory → `404` `HttpError`                                                |
| `conflict`            | function | Factory → `409` `HttpError`                                                |
| `validationError`     | function | Factory → `422` `HttpError` wrapping `ValidationError[]`                   |
| `tooManyRequests`     | function | Factory → `429` `HttpError`                                                |
| `internalServerError` | function | Factory → `500` `HttpError` (accepts `cause` for error chaining)           |
| `notImplemented`      | function | Factory → `501` `HttpError`                                                |
| `serviceUnavailable`  | function | Factory → `503` `HttpError`                                                |
| `statusTitle`         | function | Resolves a status code to a human-readable title                           |
| `STATUS_TITLES`       | const    | Readonly record of well-known status-code → title mappings                 |
| `errorHandler`        | function | Creates the global error-handler `MiddlewareFunction`                      |
| `defaultFormatter`    | const    | Framework-standard error body formatter (`{ statusCode, message }`)        |
| `rfc7807Formatter`    | const    | RFC 7807 Problem Details formatter                                         |
| `selectFormatter`     | function | Resolves `'default' \| 'rfc7807' \| custom` to a formatter function        |
| `ERROR_TYPE_BASE`     | const    | Base URI for RFC 7807 `type` fields (`https://hono-enterprise.dev/errors`) |

### Types

| Export                  | Kind | Purpose                                                                      |
| ----------------------- | ---- | ---------------------------------------------------------------------------- |
| `ValidationError`       | type | A single validation failure (`{ field, message, code? }`)                    |
| `HttpErrorInit`         | type | Options object for `HttpError.from()`                                        |
| `ErrorHandlerOptions`   | type | Options for `errorHandler()` (`{ format?, includeStackTrace?, logErrors? }`) |
| `ErrorHandlerFormatter` | type | `(error: Error, ctx?) => Record<string, unknown>`                            |
| `ErrorFormat`           | type | `'default' \| 'rfc7807'`                                                     |
| `DefaultErrorBody`      | type | Framework-standard error body shape                                          |
| `ProblemDetails`        | type | RFC 7807 Problem Details body shape                                          |

Contract notes:

- **Composition over inheritance**: there is exactly one `HttpError` class. Every factory function
  returns an `HttpError` with a pre-set `statusCode` — no `BadRequestError extends HttpError`
  hierarchy.
- **`cause` chaining**: `internalServerError(message, cause)` forwards `cause` to the ES2022 `Error`
  cause chain. The error handler logs it when a logger is registered.
- **RFC 7807 compliance**: when `format: 'rfc7807'`, the response body carries `type`, `title`,
  `status`, `detail` (and `instance` from the request path) with
  `Content-Type: application/problem+json`. The `message` field is **absent** in this mode (RFC 7807
  uses `detail`). The media type follows the RESOLVED formatter, so passing the exported
  `rfc7807Formatter` function as `format` produces the same body **and** the same content type as
  the `'rfc7807'` alias.
- **Logger is optional**: `errorHandler` logs via `ILogger` resolved from
  `ctx.services.get(CAPABILITIES.LOGGER)` only when a logger is registered; otherwise logging is
  silently skipped.
- **`includeStackTrace` is config-supplied**: pass `config.get('NODE_ENV') ===
  'development'` —
  never read `process.env` directly.
- **Short-circuit**: when `next()` throws, `errorHandler` produces a response (`HandlerResult`)
  without re-invoking `next()`.

---

## API Reference: @hono-enterprise/di-plugin

Optional dependency injection container plugin. Registers an `IContainer` under
`CAPABILITIES.DI_CONTAINER`. The service registry remains the primary resolution mechanism; this
container is a convenience layer for constructor injection and lifecycle management. No other plugin
depends on it. Implemented in **Milestone 8**; this section is the authoritative export list
(AI_GUIDELINES §10.5). All exports carry full JSDoc.

### Values (di-plugin exports)

| Export             | Kind     | Purpose                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `DiPlugin`         | function | Plugin factory — registers `IContainer` under `CAPABILITIES.DI_CONTAINER` |
| `ContainerBuilder` | class    | Fluent builder for configuring and creating a `DiContainer`               |
| `createContainer`  | function | Convenience factory for a standalone `IContainer`                         |
| `DiContainer`      | class    | The `IContainer` implementation (for direct construction or testing)      |
| `CircularDetector` | class    | Circular dependency detector (exported for testing and advanced use)      |
| `ProviderRegistry` | class    | Token-keyed provider store with hierarchical lookups                      |
| `ScopeManager`     | class    | Singleton/scoped/transient instance cache manager                         |

### Types

| Export             | Kind | Purpose                                                             |
| ------------------ | ---- | ------------------------------------------------------------------- |
| `DiPluginOptions`  | type | Options for `DiPlugin()` (`{ defaultScope?, autoRegister? }`)       |
| `ContainerConfig`  | type | Configuration for `DiContainer` constructor                         |
| `ExternalResolver` | type | Subset of `IServiceRegistry` for auto-registration fallback         |
| `ProviderEntry`    | type | A provider paired with its resolved scope (internal building block) |

Contract notes:

- **Optional**: no plugin depends on the DI container. When `DiPlugin` is not registered,
  `ctx.container` is `undefined` and services resolve directly from the `ServiceRegistry`.
- **Three provider forms**: `ClassProvider` (constructor injection via `inject` tokens),
  `FactoryProvider` (factory function), `ValueProvider` (pre-built value) — all defined in
  `@hono-enterprise/common`.
- **Three lifecycle scopes**: `singleton` (one instance, shared across child scopes), `scoped` (one
  instance per scope), `transient` (new instance every resolve). Default is `singleton`.
- **Circular dependency detection**: an instance-level resolution stack catches cycles that cross
  public `resolve()` boundaries (including factory providers calling back into the container).
  Throws `Error` with a readable `A → B → A` chain.
- **Hierarchical containers**: `createScope()` returns a child container that shares singletons with
  the parent but has its own scoped-instance cache.
- **Auto-registration** (`autoRegister: true`): resolving a token not in the container falls back to
  the kernel's `ServiceRegistry`. The first successful fallback is cached as a singleton; explicit
  DI registrations always take precedence. `ClassProvider.inject` dependencies also use this
  two-tier resolution, so framework capability tokens (`CAPABILITIES.LOGGER`, etc.) work as
  constructor dependencies without pre-registration.
- **No runtime-specific APIs**: the container uses no `Date.now()`, `crypto.*`, or `process.*` — it
  is pure TypeScript and runtime-independent.

---

## API Reference: @hono-enterprise/decorator-plugin

Optional decorator and metadata system plugin. Provides NestJS-style decorators as syntactic sugar
over the kernel's programmatic API. Decorators capture metadata in a plain `MetadataStore` (no
`reflect-metadata`); the `DecoratorPlugin` reads that store at registration and registers routes,
services, and middleware with the kernel. The store is published under `CAPABILITIES.METADATA_STORE`
so `ctx.metadata` resolves to it. Decorators are inert unless the `DecoratorPlugin` is registered —
they write to the shared singleton regardless, but only the plugin reads it. Implemented in
**Milestone 9**; this section is the authoritative export list (AI_GUIDELINES §10.5). All exports
carry full JSDoc.

> Requires `experimentalDecorators` compiler support (enabled in the package `deno.json`). Legacy
> TypeScript decorator semantics are used; no reflection metadata (`emitDecoratorMetadata`) is
> required.

### Values (decorator-plugin exports)

| Export                                               | Kind     | Purpose                                                                                                             |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPlugin`                                    | function | Plugin factory — registers `MetadataStore` and routes/services                                                      |
| `MetadataStore`                                      | class    | `IMetadataStore` implementation (the concrete store)                                                                |
| `metadataStore`                                      | value    | The process-wide singleton decorators write to and the plugin reads                                                 |
| `Controller`                                         | function | Class decorator — base path prefix                                                                                  |
| `Version`                                            | function | Class decorator — API version prefix                                                                                |
| `Get`/`Post`/`Put`/`Patch`/`Delete`/`Head`/`Options` | function | HTTP method decorators                                                                                              |
| `Body`/`Query`/`Param`/`Header`/`Cookie`             | function | Request parameter decorators                                                                                        |
| `Injectable`                                         | function | Class decorator — marks a class for DI registration                                                                 |
| `Inject`                                             | function | Constructor-parameter decorator (preferred) OR class decorator (deprecated) — declares constructor injection tokens |
| `Roles`/`Permissions`                                | function | Class/method decorator — authorization requirements                                                                 |
| `CurrentUser`                                        | function | Parameter decorator — injects `ctx.request.user`                                                                    |
| `Public`                                             | function | Method decorator — bypasses auth                                                                                    |
| `UseGuards`/`UseInterceptors`/`UseFilters`           | function | Class/method pipeline decorators                                                                                    |
| `ValidateBody`/`ValidateQuery`/`ValidateParams`      | function | Method decorators — attach validation schemas                                                                       |
| `ApiTags`                                            | function | Class decorator — OpenAPI tags                                                                                      |
| `ApiOperation`/`ApiResponse`                         | function | Method decorators — OpenAPI operation metadata                                                                      |
| `createDecorator`                                    | function | Custom class/method decorator factory                                                                               |
| `createParameterDecorator`                           | function | Custom parameter decorator factory                                                                                  |
| `resolveParameters`                                  | function | Resolves an ordered argument array from parameter metadata                                                          |
| `resolveParameter`                                   | function | Resolves a single parameter value                                                                                   |
| `registerParameterResolver`                          | function | Registers a resolver for a custom parameter type                                                                    |
| `getParameterResolver`                               | function | Looks up a custom parameter resolver                                                                                |
| `clearParameterResolvers`                            | function | Clears the custom resolver registry (tests)                                                                         |
| `parseCookies`                                       | function | Parses a `Cookie` header into a name→value record                                                                   |
| `discoverControllers`                                | function | Auto-discovers decorated classes from a directory                                                                   |

### Types

| Export                    | Kind | Purpose                                                                                            |
| ------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `DecoratorPluginOptions`  | type | Options for `DecoratorPlugin()` (`autoDiscover?`, `controllersPath?`, `controllers?`, `services?`) |
| `InjectableOptions`       | type | Options for `@Injectable()` (`scope?`, `token?`)                                                   |
| `ApiOperationConfig`      | type | Config for `@ApiOperation()` (`operationId?`, `summary?`, `description?`)                          |
| `ApiResponseConfig`       | type | Config for `@ApiResponse()` (`status`, `description?`, `schema?`)                                  |
| `HttpMethodDecorator`     | type | `(path?: string) => MethodDecorator`                                                               |
| `MiddlewareLike`          | type | `MiddlewareFunction \| (new () => IMiddleware)` — accepted by pipeline decorators                  |
| `CustomParameterResolver` | type | `(ctx, metadata?) => unknown \| Promise<unknown>`                                                  |
| `ParameterMetadata`       | type | Parameter metadata captured by parameter decorators                                                |
| `ParameterType`           | type | `'body' \| 'query' \| 'param' \| 'header' \| 'cookie' \| 'custom'`                                 |
| `DiscoveryOptions`        | type | Config for `discoverControllers()` (`path`, `extensions?`, `exclude?`)                             |
| `DiscoveryResult`         | type | Result of discovery (`controllers`, `services`, `errors`)                                          |
| `ModuleImporter`          | type | `(specifier: string) => Promise<unknown>` — injectable module loader                               |

Contract notes:

- **Inert without the plugin**: decorators write to the `metadataStore` singleton at
  class-definition time regardless of whether the plugin is registered. Only
  `DecoratorPlugin.register()` reads the store and calls the kernel APIs; without it, no
  routes/services/middleware are registered.
- **No reflection**: metadata is stored in plain `Map`s keyed by class reference, not via
  `Reflect.getMetadata()`. No `reflect-metadata` dependency.
- **Decorator composition**: parameter and cross-cutting decorators (`@Body`, `@ValidateBody`,
  `@Roles`, …) run before the HTTP-verb decorator; the store accumulates per-method and derives one
  `RouteMetadata` per (method, HTTP verb) at read time, so metadata is correct regardless of
  application order. Class-level guards/interceptors/middleware run before method-level;
  method-level `@Roles`/`@Permissions` override class-level; `@Public` sets a bypass flag.
- **Handler return values**: a controller method either returns a value (serialized as JSON by the
  plugin's handler wrapper) or returns a `HandlerResult` from `ctx.response.*`.
- **Discovery**: `discoverControllers` walks via `IRuntimeServices.fs` (absent on edge platforms →
  empty result with a warning) and loads modules with `await import()` (no `require`/`eval`).
  Snapshot-diff against the store attributes newly-decorated classes to each file. Discovery
  failures never crash the application.
- **Custom decorators**: `createDecorator` records class/method metadata replayed against
  `DecoratorHandler`s registered via `ctx.decorators.register()` (collected under
  `CAPABILITIES.DECORATOR_HANDLER`). `createParameterDecorator` records parameter metadata resolved
  by `resolveParameters` via `registerParameterResolver`; the `current-user` built-in resolves
  `ctx.request.user`.
- **`@Inject` has two positions, and a token is always required.** The preferred form is on each
  constructor parameter, binding one token to that argument by position:

  ```typescript
  @Injectable({ token: 'user-repository' })
  class UserRepository {
    constructor(
      @Inject(CAPABILITIES.DATABASE) private db: IDatabase,
      @Inject(CAPABILITIES.LOGGER) private logger: ILogger,
    ) {}
  }
  ```

  The class-level positional list is **deprecated** but keeps working for the whole `0.x` line
  (AI_GUIDELINES §9.2):

  ```typescript
  @Injectable({ token: 'user-repository' })
  @Inject('database', 'logger') // deprecated — reordering the constructor misinjects silently
  class UserRepository {
    constructor(db: IDatabase, logger: ILogger) {}
  }
  ```

  A token cannot be inferred from the parameter's type: that needs `emitDecoratorMetadata`, which
  Deno does not support, and no source in this repo reads `design:paramtypes`. Three rules follow,
  each a throw rather than a silent misinjection:
  - Mixing the two forms on one class throws at `register()`, naming the class. `mergeService`
    replaces `inject` wholesale, so any precedence rule would be invisible at the call site.
  - Leaving a constructor parameter undecorated below the last injected one throws, naming the class
    and the index — a hole would shift every later argument.
  - `@Inject` on a **method** parameter throws; method parameters bind with
    `@Body`/`@Query`/`@Param`/`@Header`/`@Cookie`.

  Constructor parameter decorators evaluate in reverse argument order, so tokens are stored keyed by
  index and assembled ascending; declaration order is what reaches the constructor.
- **The container is preferred whenever the class is registered in it**, with or without
  `@Injectable`. A `@Controller` carries no `@Injectable`, so a constructor-injected controller in a
  `DiPlugin` application resolves through the container — where its dependencies live.
- **No runtime-specific APIs**: the package uses no `Date.now()`, `Deno`, `process`, or `fs` — all
  file/time operations go through `IRuntimeServices`.

---

## Testing Package (`@hono-enterprise/testing`)

First-party testing utilities for the Hono Enterprise framework: a test application factory, mock
plugin builder, request injector, mock request context, service registry double, fixture manager,
and streaming-response reader.

### Exports

| Export                | File                                       | Description                        |
| --------------------- | ------------------------------------------ | ---------------------------------- |
| `createTestApp`       | `src/test-app.ts`                          | Test application factory           |
| `TestAppOptions`      | `src/test-app.ts`                          | Factory options                    |
| `createMockPlugin`    | `src/mock-plugin.ts`                       | Mock plugin builder                |
| `MockPluginOptions`   | `src/mock-plugin.ts`                       | Builder options                    |
| `collectStream`       | `src/inject.ts`                            | Collect streaming response body    |
| `inject`              | `src/inject.ts`                            | Inject HTTP requests into test app |
| `StreamingBody`       | `src/inject.ts`                            | Stream collector result shape      |
| `createTestContext`   | `src/mock-context.ts`                      | Create a mock `IRequestContext`    |
| `TestContextOptions`  | `src/mock-context.ts`                      | Context builder options            |
| `MockResponse`        | `src/mock-context.ts`                      | Fake `IResponse` double            |
| `MockServiceRegistry` | `src/mock-registry.ts`                     | Fake `IServiceRegistry` double     |
| `FixtureManager`      | `src/fixtures/fixture-manager.ts`          | Assemble mock plugins per-test     |
| `IKernelApplication`  | (re-export from `@hono-enterprise/kernel`) | Kernel application interface       |
| `InjectRequest`       | (re-export from `@hono-enterprise/kernel`) | Shape for `inject()` request       |
| `InjectResponse`      | (re-export from `@hono-enterprise/kernel`) | Shape for `inject()` response      |

### Registration

```typescript
import { createTestApp } from '@hono-enterprise/testing';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { DatabasePlugin } from '@hono-enterprise/database-plugin';

const app = await createTestApp({
  plugins: [
    RuntimePlugin(),
    DatabasePlugin({ type: 'memory' }),
  ],
});
```

### Options

`TestAppOptions` — `createTestApp(options?)`:

| Option      | Type        | Default | Behavior                                                                                                                                                                                                                              |
| ----------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins`   | `IPlugin[]` | `[]`    | Pre-registered before `start()`. **Must include a `runtime` capability provider** (`RuntimePlugin()`, or a mock providing `CAPABILITIES.RUNTIME`) whenever `autoStart` is left `true` — the kernel requires one and throws otherwise. |
| `autoStart` | `boolean`   | `true`  | `true` calls `await app.start()` (no port, so no socket) before returning. `false` returns the un-started app — required to register further plugins or to add global middleware.                                                     |

`MockPluginOptions` — `createMockPlugin(options)`:

| Option     | Type                                             | Default  | Behavior                                                                            |
| ---------- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `name`     | `string`                                         | required | Plugin name, and the capability token when `provides` is omitted.                   |
| `service`  | `object`                                         | required | The mock service registered under the token.                                        |
| `provides` | `string`                                         | `name`   | Overrides the token when the plugin name and capability token differ.               |
| `priority` | `number`                                         | omitted  | Registration priority passed to the kernel resolver.                                |
| `register` | `(ctx: IPluginContext) => void \| Promise<void>` | omitted  | Extra registration (middleware, routes, hooks) run after the service is registered. |

`TestContextOptions` — `createTestContext(options?)`:

| Option      | Type                     | Default                     | Behavior                                                                                                        |
| ----------- | ------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `request`   | `Partial<IRequest>`      | `GET http://localhost/`     | Overrides on the mock request (`method`, `url`, `path`, `headers`, `ip`, `user`, `tenant`, `signal`).           |
| `body`      | `unknown`                | none                        | Backs `json()`, `text()` and `bytes()`. A non-string body is JSON-stringified once, so all three readers agree. |
| `runtime`   | `IRuntimeServices`       | internal monotonic fake     | Supplies `ctx.id` (`uuid()`) and `ctx.startTime` (`hrtime()`).                                                  |
| `startTime` | `number`                 | `runtime.hrtime()` (`0`)    | Highest-precedence monotonic origin — **never** pass `Date.now()`.                                              |
| `services`  | `IServiceRegistry`       | `new MockServiceRegistry()` | Any implementation, including a real kernel registry from a started app.                                        |
| `response`  | `IResponse`              | `new MockResponse()`        | The response builder on `ctx.response`.                                                                         |
| `params`    | `Record<string, string>` | `{}`                        | Path parameters.                                                                                                |
| `query`     | `Record<string, string>` | parsed from the request URL | Query parameters.                                                                                               |
| `state`     | `Map<string, unknown>`   | `new Map()`                 | Request-scoped state.                                                                                           |
| `signal`    | `AbortSignal`            | live, never-aborting        | `ctx.signal`. Precedence: `request.signal` > `signal` > default, matching the kernel.                           |

### Programmatic Testing

```typescript
import {
  collectStream,
  createMockPlugin,
  createTestContext,
  inject,
} from '@hono-enterprise/testing';
import { FixtureManager, MockServiceRegistry } from '@hono-enterprise/testing';

// Mock a plugin service
const mockDb = createMockPlugin({
  name: 'database',
  service: { find: async () => [] },
});

// Use FixtureManager to assemble mocks
const fixtures = new FixtureManager();
fixtures.mock('cache', { get: async () => null, set: async () => {} });

// Inject a request directly
const response = await inject(app, {
  method: 'GET',
  url: '/users',
});

// Create a fake context for handler-level tests
const ctx = createTestContext();
const mockRegistry = new MockServiceRegistry();

// Register a streaming route so collectStream has data to read
app.router.get('/stream', (c) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'));
      controller.enqueue(new TextEncoder().encode(' world'));
      controller.close();
    },
  });
  return c.response.stream(stream);
});

// Collect a streaming body — use fetch() which returns a real web Response
const fetchRes = await app.fetch(new Request('http://localhost/stream'));
const stream = await collectStream(fetchRes);
console.log(stream.text); // → "hello world"
```

### Notes

- The testing package does **not** start an HTTP server; `createTestApp` returns a started kernel
  application that can be exercised via `inject()` or `fetch()`.
- **`plugins` must include a runtime provider.** The package depends only on `common` and `kernel`,
  so it cannot import `RuntimePlugin` to supply one for you, and the kernel treats the `runtime`
  capability as mandatory at `start()`. `await createTestApp()` with no plugins therefore rejects
  with `No plugin provides the mandatory 'runtime' capability`. Pass `RuntimePlugin()`, or for a
  dependency-free unit test
  `createMockPlugin({ name: 'runtime', service: fakeRuntime, provides: CAPABILITIES.RUNTIME })`.
- **Adding global middleware requires `autoStart: false`.** `start()` compiles the pipeline, after
  which `app.middleware.add(...)` throws
  `Cannot add middleware after the pipeline has been
  compiled.` Routes are unaffected —
  `app.router.get(...)` works on a started app.
- **A mock providing only `runtime` cannot serve `fetch()`.** The real `RuntimePlugin` also provides
  `http-adapter`; without it `app.fetch()` throws `No HTTP adapter registered.` `inject()` needs
  only `runtime`, so unit tests use `inject()` and `fetch()` assertions belong to integration/e2e
  tests on the real `RuntimePlugin()`.
- The free-function `inject()` accepts a web `Request`, and reading its body **consumes** it. The
  same `Request` cannot be injected twice, nor injected and then passed to `app.fetch()` — the
  second call throws and names the cause instead of silently sending no body. Build a separate
  `Request` per call.
- `inject()` returns `body: string | null`, where a byte body from `response.send(bytes)` is UTF-8
  decoded and `null` means the response genuinely had no body. A **streaming** response cannot be
  rendered as a string without draining the live stream, so `inject()` throws for one — read those
  through `app.fetch()` plus `collectStream` instead.
- `createTestContext` uses a built-in monotonic fake runtime (`hrtime: () => 0`) by default — inject
  your own `IRuntimeServices` when you need controllable timing. Its timers are inert no-ops, so a
  fixture can never leak a callback past the test that created it.
- `MockServiceRegistry` and `MockResponse` reproduce their kernel counterparts' observable semantics
  (factory caching, single-vs-multi registration and `getAll` merge order, override policy, the
  verbatim not-registered message, `content-type` defaults, and the `snapshot()` discriminated
  union) so a test cannot pass against the double and fail against the real thing.

---

## SDK — Client SDK (`@hono-enterprise/sdk`)

Portable, zero-npm-dependency client SDK for consuming Hono Enterprise APIs from browsers and
servers. Does not register a plugin or resolve capability tokens — it is an external-consumer
library.

### Installation

```bash
deno add jsr:@hono-enterprise/sdk@^0.1.0-alpha.3
```

### createClient()

Factory that returns an `IHttpClient`. Requires a base URL; accepts default headers, an injectable
`fetch` seam, a timing seam, resilience policies, rate-limit policy, and interceptor arrays.

```typescript
import { createClient } from '@hono-enterprise/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  headers: { 'X-Trace-Id': 'abc' },
});

const res = await client.request<User>({
  method: 'GET',
  path: '/users/123',
});
console.log(res.data); // User
```

### IHttpClient

The public client interface. Its single generic method is `request<TResponse, TBody>`.

```typescript
interface IHttpClient {
  request<TResponse, TBody = unknown>(
    request: ClientRequest<TBody>,
  ): Promise<ClientResponse<TResponse>>;
}
```

### ClientOptions

```typescript
interface ClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  timing?: IClientTiming;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;
  rateLimit?: ClientRateLimitPolicy;
  requestInterceptors?: ClientRequestInterceptor[];
  responseInterceptors?: ClientResponseInterceptor[];
}
```

| Option                 | Consumer                     | Behavior                                                      |
| ---------------------- | ---------------------------- | ------------------------------------------------------------- |
| `baseUrl`              | `HttpClient` URL resolver    | Required base for every relative `ClientRequest.path`         |
| `headers`              | `HttpClient` request builder | Cloned into each request; request-specific values win         |
| `fetch`                | `HttpClient` transport       | Called after policy gates; defaults to global `fetch`         |
| `timing`               | retry, breaker, limiter      | Optional; defaults to `createDefaultClientTiming()`           |
| `retry`                | retry strategy               | `limit < 1` throws at construction                            |
| `circuitBreaker`       | origin breaker map           | `threshold < 1` throws at construction                        |
| `rateLimit`            | origin limiter map           | Non-positive `maxRequests`/`windowMs` throws                  |
| `requestInterceptors`  | request pipeline             | Run once in array order before resilient execution            |
| `responseInterceptors` | response pipeline            | Run in array order after successful parse; skipped on failure |

### ClientRequest

```typescript
interface ClientRequest<TBody = unknown> {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  json?: TBody;
  signal?: AbortSignal;
}
```

### ClientResponse

```typescript
interface ClientResponse<T> {
  status: number;
  headers: Headers;
  data?: T;
}
```

### Interceptors

```typescript
type ClientRequestInterceptor = (ctx: ClientRequestContext) => void | Promise<void>;
type ClientResponseInterceptor<T> = (
  response: ClientResponse<T>,
  request: ClientRequestContext,
) => ClientResponse<T> | Promise<ClientResponse<T>>;
```

Request interceptors receive a mutable `ClientRequestContext` (resolved `URL` and `Headers`) and
execute once in registration order before the outbound attempt sequence. Response interceptors
receive a successful `ClientResponse<T>` and its immutable request description; they are skipped
entirely when the request throws.

### IClientTiming and createDefaultClientTiming()

```typescript
interface IClientTiming {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function createDefaultClientTiming(): IClientTiming;
```

`now()` uses `performance.now()` (monotonic); `sleep()` uses `setTimeout` with an abort listener.
Inject a deterministic implementation in tests.

### ClientRateLimitPolicy

```typescript
interface ClientRateLimitPolicy {
  maxRequests: number;
  windowMs: number;
}
```

Per-origin sliding-window limiter. When the window is full, the client waits until the oldest
retained timestamp expires.

### Re-exported policy types

`RetryPolicy`, `CircuitBreakerPolicy`, and `BackoffStrategy` are re-exported from
`@hono-enterprise/common` so consumers can name their types without adding `common` to their own
manifest.

### Authentication interceptors

```typescript
function createBearerAuthInterceptor(
  token: string | (() => string | Promise<string>),
): ClientRequestInterceptor;

function createApiKeyAuthInterceptor(
  key: string | (() => string | Promise<string>),
  headerName?: string,
): ClientRequestInterceptor;
```

`createBearerAuthInterceptor` sets `Authorization: Bearer <token>`. `createApiKeyAuthInterceptor`
sets the header named `X-API-Key` (default) or `headerName`. Each accepts a literal or an async
value provider and sets its header only when the request has not already supplied that header.

### Errors

| Error                    | When thrown                             | Fields                      |
| ------------------------ | --------------------------------------- | --------------------------- |
| `HttpClientError`        | Non-2xx HTTP response                   | `status`, `headers`, `body` |
| `ClientCircuitOpenError` | Circuit breaker is open for the origin  | (none)                      |
| `OpenApiCodegenError`    | Invalid OpenAPI document during codegen | `path`, `method`            |

`ClientCircuitOpenError` is named distinctly from the resilience plugin's `CircuitOpenError` to
avoid a barrel collision.

### generateOpenApiClient()

Pure function that turns an M21-compatible OpenAPI 3.1 document into TypeScript source.

```typescript
import { generateOpenApiClient } from '@hono-enterprise/sdk';

const source = generateOpenApiClient(document, {
  sdkImport: '@hono-enterprise/sdk',
  factoryName: 'createApi',
});
```

### OpenApiCodegenOptions

```typescript
interface OpenApiCodegenOptions {
  sdkImport?: string;
  factoryName?: string;
}
```

| Option        | Default                  | Description                     |
| ------------- | ------------------------ | ------------------------------- |
| `sdkImport`   | `'@hono-enterprise/sdk'` | Generated type-import specifier |
| `factoryName` | `'createApi'`            | Exported generated factory name |

#### Generated naming contract

| Emitted symbol           | Derivation                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Operation method         | lower-camelCase from `operationId`, split on non-alphanumeric runs, **interior casing preserved** (`listUsers` → `listUsers`) |
| Component type           | PascalCase from the component name (`User` → `export type User`)                                                              |
| Argument interface       | PascalCase from `operationId` plus `Args` (`listUsers` → `ListUsersArgs`)                                                     |
| Leading digit / reserved | digit run prefixed `n`; reserved word prefixed `_`; a name that sanitizes to nothing becomes `operation`                      |
| Duplicate derived name   | throws `OpenApiCodegenError` naming both originals — for operations AND component schemas                                     |

Path parameters are emitted as positional arguments (each substituted and percent-encoded, including
a placeholder sharing a segment with literal text such as `/files/{id}.json`); query parameters,
headers, and the JSON body live on `opts`. `opts` is **required** when any of its fields is
required. Query keys and header names keep their original OpenAPI spelling; only the TypeScript
field identifier is derived, and header values are stringified so a non-`string` header schema
compiles.

All eight operation slots are generated, including `trace`. Path-item-level `parameters` are merged
into every operation on that path, with an operation's own entry overriding a shared one of the same
`name` and `in`. Document text emitted into a comment has comment terminators escaped and line
breaks collapsed, and every emitted string literal and path template is escaped for its own context,
so a hostile document cannot inject code into the generated file.

`generateOpenApiClient` throws `OpenApiCodegenError` (carrying `path` and `method` where applicable)
instead of emitting a client that misbehaves or does not compile, for: a missing `operationId`; two
operations or two component schemas deriving onto one name; a `cookie` parameter; a path placeholder
with no matching `in: 'path'` parameter; an `in: 'path'` parameter absent from the template; two
placeholders deriving onto one argument name; and a malformed local `$ref`.

### SdkOpenApi\* types

`SdkOpenApiDocument`, `SdkOpenApiPathItem`, `SdkOpenApiOperation`, `SdkOpenApiParameter`,
`SdkOpenApiRequestBody`, `SdkOpenApiResponse`, and `SdkOpenApiSchema` are the structural OpenAPI 3.1
subset accepted by the generator. They are intentionally different from the openapi-plugin types
(which have different shapes) and take the `SdkOpenApi*` prefix to avoid a barrel collision.

---

## API Reference: @hono-enterprise/grpc-plugin

gRPC/Connect co-serving on the same port as ordinary Hono routes. Registered under
`CAPABILITIES.GRPC`. Added in Milestone 49.

### Registration

```typescript
import { GrpcPlugin } from '@hono-enterprise/grpc-plugin';

app.register(GrpcPlugin({
  basePath: '/grpc', // default
  reflection: true, // default — grpc.reflection.v1.ServerReflection
  health: true, // default — grpc.health.v1.Health (bridged to M20)
  services: [], // initial service definitions
  connectModule: undefined, // inject for testing; otherwise lazy-loaded
}));
```

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IGrpcService } from '@hono-enterprise/common';

const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
grpc.addService(MyServiceDefinition, myServiceImpl);
```

### Options

| Option          | Type                                     | Default | Description                                                                                           |
| --------------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `basePath`      | `string`                                 | `/grpc` | URL prefix that marks a request as RPC. Requests outside this prefix fall through to Hono.            |
| `reflection`    | `boolean`                                | `true`  | Register `grpc.reflection.v1.ServerReflection`. Bidi streaming — requires HTTP/2 or in-process fetch. |
| `health`        | `boolean`                                | `true`  | Register `grpc.health.v1.Health` (`Check` only), bridged to the M20 health plugin.                    |
| `services`      | `Array<{ definition, implementation? }>` | `[]`    | Initial services to register at startup.                                                              |
| `connectModule` | `ConnectRuntime`                         | omitted | Injected Connect runtime for tests; omitted triggers lazy `import()` of four npm specifiers.          |

### Exports

| Export                 | Kind     | Purpose                                                                                       |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GrpcPlugin`           | function | Plugin factory — registers `IGrpcService` under `CAPABILITIES.GRPC`                           |
| `GrpcService`          | class    | The `IGrpcService` implementation; exported so tests can compose it without subclassing       |
| `adaptConnectModule`   | function | Structural adaptation of raw Connect/Protobuf modules into the internal `ConnectRuntime` port |
| `GrpcUnavailableError` | class    | Thrown by `handleRequest` when the adapter lacks `setRpcHandler`                              |
| `GrpcRuntimeLoadError` | class    | Thrown by `loadConnectModule` when any of the four npm specifiers cannot be imported          |
| `GrpcDescriptorError`  | class    | Thrown when an embedded descriptor set cannot be decoded or lacks its expected service        |
| `GrpcPluginOptions`    | type     | The factory parameter shape                                                                   |
| `ConnectModuleLike`    | type     | The four-module bundle `adaptConnectModule` accepts                                           |

> `ConnectRuntime` and the structural Connect facades are **not** exported. They are an internal
> port; publishing them would commit the package to a shape that tracks Connect's own API.

### Notes

- **Co-serves with Hono.** gRPC requests are detected by path prefix only (`/grpc` by default).
  Content-type sniffing is deliberately not used because Connect's real unary content types include
  `application/json` and `application/proto`. A non-prefixed path returns `null` and falls through
  to the Hono pipeline unchanged.
- **`inject()` does not reach the interceptor.** The kernel's `inject()` bypasses the HTTP adapter
  entirely. RPC must be exercised via `app.fetch(webRequest)` in tests.
- **Bidi streaming requires HTTP/2.** `grpc.reflection.v1.ServerReflection` is bidi-only. Over a
  real HTTP/1.1 socket, bidi calls fail at the transport. Unary, server-streaming, and
  client-streaming work on every runtime.
- **Health bridge maps `degraded → SERVING`**. `'up' → SERVING (1)`, `'down' → NOT_SERVING (2)`,
  `'degraded' → SERVING (1)`. Degraded still serves; mapping it to `NOT_SERVING` would shed capacity
  in the wrong direction.
- **`Check` honors the `service` field.** The empty string means "the whole server" and returns the
  mapped aggregate health. A name the server does not serve returns `SERVICE_UNKNOWN (3)`,
  regardless of overall health.
- **`List` and `Watch` are unimplemented.** Connect auto-responses `unimplemented` for methods not
  provided by the bridge.
- **Reflection covers four request variants.** `list_services`, `file_by_filename`,
  `file_containing_symbol` (services, methods, messages, nested types, enums and extensions), and
  `all_extension_numbers_of_type`. `file_containing_extension` answers `UNIMPLEMENTED` — the
  framework registers no extensions. An unknown filename, symbol or type answers `NOT_FOUND (5)`.
- **Reflection sees the app's own protos.** A registered service's `DescFile` and its transitive
  `dependencies` are indexed, so `file_containing_symbol` resolves types declared in imported protos
  too. Nothing beyond the registered services and the plugin's own two files is exposed.
- **Descriptors are addressed by their suffixed proto path.** Reflection clients ask for
  `example/echo.proto`; Protobuf-ES's `DescFile.name` drops the `.proto` suffix while `proto.name`
  retains it, and the registry keys on the latter.
- **Lazy loading.** The four npm specifiers (`@connectrpc/connect@^2.1.2`,
  `@bufbuild/protobuf@^2.7.0`, `@bufbuild/protobuf@^2.7.0/wkt`) are loaded on first `register()`.
  Absence throws `GrpcRuntimeLoadError` with the install command.
- **Optional seam.** If the HTTP adapter does not implement `setRpcHandler?`, the plugin still
  registers and reports `available: false`; `handleRequest` throws `GrpcUnavailableError` while
  `createFetchHandler` returns `null` for every request.
- **gRPC-binary trailers on Deno.** Native gRPC-binary protocol (`application/grpc`) relies on
  HTTP/2 response trailers (specifically `grpc-status`) for proper status signaling. Deno's
  `Deno.serve` does not expose HTTP/2 trailers, so native gRPC-binary responses may not work
  correctly on Deno. This is a **platform limitation**, not a plugin bug. Connect-JSON and gRPC-Web
  protocols work on all runtimes. For native gRPC-binary, Node.js or Bun may provide better trailer
  support.

---

## GraphQL

Schema-first and code-first GraphQL support over the kernel router.

### Overview

GraphQL plugin providing schema construction, execution, and HTTP transport. Supports both SDL-based
schema definition with resolver maps and pre-built schemas. Includes media-type negotiation for
`application/graphql-response+json`, error masking, query-depth limiting, and optional GraphiQL UI.

### Capability Token

- `CAPABILITIES.GRAPHQL` (`'graphql'`) — the capability token under which `GraphqlPlugin` registers
  the `IGraphqlService`.

### Usage

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IGraphqlService } from '@hono-enterprise/common';

// Schema-first
app.use(
  GraphqlPlugin({
    typeDefs: `
      type Query {
        hello(name: String!): String
      }
    `,
    resolvers: {
      Query: {
        hello: (_, { name }) => `Hello, ${name}!`,
      },
    },
  }),
);

// Code-first
import { buildSchema } from 'npm:graphql@^16';
const schema = buildSchema(`type Query { hello: String }`);

app.use(
  GraphqlPlugin({
    schema,
  }),
);

// Resolve the service
const graphql = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
```

### Options

| Option               | Type                                      | Default    | Description                                                   |
| -------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------- |
| `typeDefs`           | `string`                                  | -          | SDL schema definition (schema-first mode)                     |
| `resolvers`          | `ResolverMap`                             | -          | Resolver map (schema-first mode)                              |
| `schema`             | `GraphqlSchemaLike`                       | -          | Pre-built schema (code-first mode)                            |
| `path`               | `string`                                  | `/graphql` | Endpoint path                                                 |
| `graphiql`           | `boolean`                                 | `true`     | Enable GraphiQL UI                                            |
| `introspection`      | `boolean`                                 | `true`     | Enable schema introspection                                   |
| `maxDepth`           | `number`                                  | `10`       | Maximum query depth (0 to disable)                            |
| `validationRules`    | `unknown[]`                               | omitted    | Additional validation rules                                   |
| `maskInternalErrors` | `boolean`                                 | `true`     | Mask internal server errors                                   |
| `formatError`        | `(error: unknown) => unknown`             | omitted    | Custom error formatter applied after masking                  |
| `documentCacheSize`  | `number`                                  | `1000`     | Max cached documents (0 to disable)                           |
| `buildContext`       | `(input: GraphqlContextInput) => unknown` | omitted    | Custom context builder                                        |
| `rootValue`          | `unknown`                                 | omitted    | Root value for resolvers                                      |
| `graphqlModule`      | `GraphqlModuleLike`                       | omitted    | Injected graphql module (for testing or code-first scenarios) |

### Exports

| Export                      | Kind     | Purpose                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------- |
| `GraphqlPlugin`             | function | Plugin factory — registers `IGraphqlService` under `CAPABILITIES.GRAPHQL` |
| `GraphqlService`            | class    | The `IGraphqlService` implementation; exported for testing                |
| `adaptGraphqlModule`        | function | Structural adaptation of graphql module into internal runtime port        |
| `graphiqlHtml`              | function | Generates GraphiQL UI HTML page                                           |
| `createDepthLimitRule`      | function | Creates a validation rule for query depth limiting                        |
| `GraphqlSchemaError`        | class    | Thrown when schema construction or resolver attachment fails              |
| `GraphqlRuntimeLoadError`   | class    | Thrown when graphql runtime cannot be loaded                              |
| `loadGraphqlModule`         | function | Loads `npm:graphql@^16` through a real dynamic import                     |
| `GraphqlPluginOptions`      | type     | The factory parameter shape (union of the two arms)                       |
| `GraphqlSchemaFirstOptions` | type     | The schema-first arm of that union                                        |
| `GraphqlCodeFirstOptions`   | type     | The code-first arm of that union                                          |
| `ResolverMap`               | type     | Resolver map for schema-first mode                                        |
| `FieldResolver`             | type     | Field resolver function type                                              |
| `GraphqlSchemaLike`         | type     | Structural constraint for pre-built schemas                               |
| `GraphqlModuleLike`         | type     | Structural constraint for injected graphql modules                        |
| `DefaultGraphqlContext`     | type     | Default context shape passed to resolvers                                 |
| `GraphqlContextInput`       | type     | Input type for custom context builder                                     |

> `GraphqlRuntime` and the structural graphql facades are **not** exported. They are an internal
> port.

### Notes

- **Two schema construction arms.** Schema-first (`typeDefs` + `resolvers`) and code-first
  (`schema`) are mutually exclusive; supplying both is a compile error.
- **Resolver context.** Without `buildContext`, resolvers receive a `DefaultGraphqlContext` of
  `{ services, requestContext, user, tenant }` — `services` is the live `IServiceRegistry`, so a
  resolver reaches any other capability through it, and `user`/`tenant` are whatever the auth and
  multi-tenancy middleware published on the request. Supplying `buildContext` replaces that object
  wholesale.
- **Media-type negotiation and the status watershed.** Responds with
  `application/graphql-response+json` when the client requests it, otherwise `application/json`.
  Under `graphql-response`, a **request** error (parse, validation, operation resolution) is `400`
  and a mutation over `GET` is `405`. Under `application/json`, every well-formed GraphQL request
  answers `200` — only a transport refusal (`METHOD_NOT_ALLOWED`,
  `SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`) keeps its status, because a client predating the new
  media type reads a non-200 as a network failure and never reads the `errors` array.
- **An executed operation is always `200`.** A field error that nulls `data` is not a request error,
  so it does not become a `400` even under `graphql-response`.
- **`405` carries `Allow: POST`.** A mutation sent over `GET` is refused with `METHOD_NOT_ALLOWED`
  and the endpoint advertises the verb that would work.
- **Ambiguous operations.** A document whose operation cannot be resolved — several operations with
  no `operationName`, or a name absent from the document — is a `400` with code
  `OPERATION_RESOLUTION_FAILED`, decided after parse and before validation.
- **Error masking.** Internal errors (resolvers throwing without a `code` in extensions) are masked
  by default. The original is logged through the plugin context's `logger` when one is registered,
  so masking never silently discards it.
- **Query depth limiting.** Defaults to 10 levels; set to 0 to disable.
- **Document caching.** Parse and validation results are cached together, keyed on the raw query
  string, and the operation guard reads the cached AST — so a repeated query is neither re-parsed
  nor re-validated. `documentCacheSize: 0` disables the cache.
- **GraphiQL UI.** Enabled by default, served on `GET /graphql` when the request has no `query`
  parameter and accepts `text/html`.
- **Platform notes.** The `graphql` package reads `process.env.NODE_ENV` at import time. Deno
  requires `--allow-env`; Cloudflare Workers requires `nodejs_compat`.
- **Subscriptions.** Not supported in this milestone. Subscription operations return a 400 error
  with code `SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`.

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
