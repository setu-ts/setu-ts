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
33. [Programmatic vs Decorator API](#programmatic-vs-decorator-api)
34. [Developer Ergonomics](#developer-ergonomics)
35. [API Reference: @hono-enterprise/common](#api-reference-hono-enterprisecommon)
36. [API Reference: @hono-enterprise/kernel](#api-reference-hono-enterprisekernel)
37. [API Reference: @hono-enterprise/runtime](#api-reference-hono-enterpriseruntime)

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
}
```

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
}
```

- **`envFilePath`** — Path or paths to `.env` files. Defaults to no file loading. When supplied, the
  runtime must provide `fs` (absent on edge platforms).
- **`validationSchema`** — A Zod-compatible schema for startup validation. The schema's `parse()` is
  called once after merging and expansion; the parsed output is stored as the configuration
  snapshot, preserving Zod coercions and defaults.
- **`expandVariables`** — When `true` (default), expand `${NAME}` references in values using the
  final merged configuration.

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
   * Strip unknown properties not defined in the schema.
   *
   * **Limitation:** Cannot be enforced at the middleware layer because schemas
   * are duck-typed via `safeParse()`. Configure on the schema instead:
   * `z.object({ ... }).strip()`.
   */
  readonly whitelist?: boolean;

  /**
   * Reject requests with properties not defined in the schema.
   *
   * **Limitation:** Cannot be enforced at the middleware layer because schemas
   * are duck-typed via `safeParse()`. Configure on the schema instead:
   * `z.object({ ... }).strict()`.
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

`authMiddleware` writes the authenticated principal to `ctx.request.user` (`user` is the one
writable field on `IRequest`, so the shipped `@CurrentUser` decorator resolves it).

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

| Option        | Type     | Default | Description                                           |
| ------------- | -------- | ------- | ----------------------------------------------------- |
| `heartbeatMs` | `number` | omitted | When set, sends `: heartbeat\n\n` at this interval.   |
| `retryMs`     | `number` | omitted | When set, sends `retry: <ms>\n\n` as the first frame. |

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

### Notes

- Built entirely on web-standard `ReadableStream`; no platform-specific server socket APIs.
- The plugin is in-memory only. Cross-process broadcast requires a future milestone bridging to the
  messaging capability.
- Cloudflare Workers and other edge platforms bound long-lived connections by their own limits — the
  plugin opens the stream the same way everywhere, but the platform may truncate the connection.
- The `inject()` method discards streaming bodies; SSE integration tests must use a real socket
  (`app.start({ port })` + `fetch()`).

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

| Export                        | Kind     | Purpose                                                                                                 |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                | const    | Standard capability tokens — the single source of truth. Includes `SSE: 'sse'` (Server-Sent Events hub) |
| `createCapabilityToken(name)` | function | Validates and creates a custom (optionally dot-namespaced) token; throws `TypeError` on invalid names   |
| `PLUGIN_PRIORITY`             | const    | Well-known plugin priority bands (`HIGHEST`…`LOWEST`)                                                   |
| `ok(value)` / `err(error)`    | function | `Result` constructors                                                                                   |
| `isOk(r)` / `isErr(r)`        | function | `Result` type guards                                                                                    |
| `unwrap(r)`                   | function | Returns the `Ok` value or throws the `Err` error                                                        |
| `some(value)` / `none()`      | function | `Option` constructors (`none()` returns a frozen singleton)                                             |
| `isSome(o)` / `isNone(o)`     | function | `Option` type guards                                                                                    |
| `fromNullable(v)`             | function | Converts `T \| null \| undefined` to `Option<T>`                                                        |

### Types

| Group               | Exports                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens              | `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                  |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PluginPriority`                                                                                                                            |
| Utilities           | `Result<T, E>`, `Ok<T>`, `Err<E>`, `Option<T>`, `Some<T>`, `None`                                                                                                                                                                        |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, `StartOptions`                                                                                                                                                                              |
| Plugin context APIs | `IMiddlewareApi`, `MiddlewareOptions`, `IRouterApi`, `IEnvironmentApi`, `EnvVarSpec`, `IHealthApi`, `IMetricsApi`, `IOpenApiApi`, `IDecoratorApi`, `DecoratorHandler`, `ICliApi`, `CliCommandHandler`, `ILifecycleApi`, `IMetadataStore` |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory<T>`                                                                                                                                                                               |
| HTTP                | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `NextFunction`, `RouteHandler`, `RouteDefinition`, `RouteSchema`, `HandlerResult`, `ResponseSnapshot`                                                   |
| Runtime             | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`, `TimerHandle`, `ServerHandle`, `StatResult`                                                                                                                                           |
| DI (optional)       | `IContainer`, `Constructor<T>`, `ServiceScope`, `Provider<T>`, `ClassProvider<T>`, `FactoryProvider<T>`, `ValueProvider<T>`, `ProviderOptions`                                                                                           |
| Logging             | `ILogger`, `LogMetadata`                                                                                                                                                                                                                 |
| Config              | `IConfig`                                                                                                                                                                                                                                |
| Validation          | `IValidationService`, `ValidationTarget`, `ValidationIssue`                                                                                                                                                                              |
| Health              | `IHealthIndicator`, `HealthIndicatorFn`, `HealthCheckResult`, `IHealthService`, `HealthReport`, `HealthStatus`                                                                                                                           |
| Metrics             | `IMetric`, `MetricConfig`, `IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, `MetricOptions`                                                                                                                            |
| Auth                | `IPrincipal`, `IJwtService`, `JwtSignOptions`                                                                                                                                                                                            |
| Database            | `IOrmAdapter`, `ITransaction`                                                                                                                                                                                                            |
| Cache               | `ICacheStore`                                                                                                                                                                                                                            |
| Events              | `IEventBus`, `IDomainEvent<T>`, `EventHandler<T>`, `Unsubscribe`                                                                                                                                                                         |
| Messaging           | `IMessageBroker`, `ISubscription`, `MessageHandler<T>`, `MessageMetadata`, `SubscribeOptions`                                                                                                                                            |
| Queue               | `IQueue`, `IJob<T>`, `JobProcessor<T>`, `AddJobOptions`, `ProcessOptions`, `RecurringOptions`                                                                                                                                            |
| Scheduler           | `IScheduler`, `ScheduledJob<T>`, `SchedulerJobHandler<T>`, `ScheduleOptions<T>`, `RetryOptions`, `SchedulerBackoff`                                                                                                                      |
| Secrets             | `ISecretManager`                                                                                                                                                                                                                         |
| Audit               | `IAuditLogger`, `AuditEntry`                                                                                                                                                                                                             |
| Resilience          | `ICircuitBreaker`, `CircuitState`                                                                                                                                                                                                        |
| Storage             | `IStorage`, `SignedUrlOptions`                                                                                                                                                                                                           |
| Mail                | `IMailer`, `MailMessage`                                                                                                                                                                                                                 |
| Notifications       | `INotifier`, `NotificationMessage`                                                                                                                                                                                                       |
| Feature flags       | `IFeatureFlags`, `FlagContext`                                                                                                                                                                                                           |
| Multi-tenancy       | `ITenantResolver`, `ITenant`                                                                                                                                                                                                             |
| SSE                 | `ISseService`, `ISseConnection`, `SseChannel`, `SseMessage`                                                                                                                                                                              |

Contract notes:

- `IPluginContext.runtime` is **non-optional**: a runtime provider is mandatory and registers first,
  so every plugin may rely on it (ARCHITECTURE.md §7).
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
| `buildNodeHost`                   | function | Builds a `NodeHost` from injected `NodeModules` (defaults to real `node:` built-ins)       |
| `createDenoRuntimeServices`       | function | Creates `IRuntimeServices` backed by Deno APIs                                             |
| `createNodeRuntimeServices`       | function | Creates `IRuntimeServices` backed by Node.js APIs                                          |
| `createBunRuntimeServices`        | function | Creates `IRuntimeServices` backed by Bun APIs                                              |
| `createCloudflareRuntimeServices` | function | Creates `IRuntimeServices` backed by Cloudflare Workers APIs (edge-compatible)             |
| `DenoHttpAdapter`                 | class    | Deno HTTP server adapter implementing `IHttpAdapter`                                       |
| `NodeHttpAdapter`                 | class    | Node.js HTTP server adapter implementing `IHttpAdapter`                                    |
| `BunHttpAdapter`                  | class    | Bun HTTP server adapter implementing `IHttpAdapter`                                        |
| `CloudflareWorkersHttpAdapter`    | class    | Cloudflare Workers HTTP adapter implementing `IHttpAdapter` (fetch-only, no listen)        |
| `isDenoHttpServerHandle`          | function | Type guard for `DenoHttpServerHandle`                                                      |
| `isNodeHttpServerHandle`          | function | Type guard for `NodeHttpServerHandle`                                                      |
| `isBunHttpServerHandle`           | function | Type guard for `BunHttpServerHandle`                                                       |

### Types

| Export                              | Kind | Purpose                                                         |
| ----------------------------------- | ---- | --------------------------------------------------------------- |
| `RuntimeOptions`                    | type | Options for `RuntimePlugin` (`{ platform?: RuntimePlatform }`)  |
| `GlobalScope`                       | type | Injectable global scope shape for `detectRuntime`               |
| `DenoHost`                          | type | Host interface for the Deno adapter (extension point)           |
| `DenoFileInfo`                      | type | File info returned by `DenoHost.stat()`                         |
| `DenoDirEntry`                      | type | Directory entry returned by `DenoHost.readdir()`                |
| `NodeHost`                          | type | Host interface for the Node adapter (extension point)           |
| `NodeFsInfo`                        | type | File info returned by `NodeHost.stat()`                         |
| `NodeModules`                       | type | Injectable Node built-ins for `buildNodeHost` (testing seam)    |
| `BunHost`                           | type | Host interface for the Bun adapter (extension point)            |
| `BunFileInfo`                       | type | File info returned by `BunHost.stat()`                          |
| `DenoHttpServerHandle`              | type | Internal server handle for DenoHttpAdapter                      |
| `NodeHttpServerHandle`              | type | Internal server handle for NodeHttpAdapter                      |
| `BunHttpServerHandle`               | type | Internal server handle for BunHttpAdapter                       |
| `CloudflareWorkersHttpServerHandle` | type | Internal server handle for CloudflareWorkersHttpAdapter         |
| `DenoServeHost`                     | type | Injectable host interface for DenoHttpAdapter (extension point) |
| `NodeServeHost`                     | type | Injectable host interface for NodeHttpAdapter (extension point) |
| `BunServeHost`                      | type | Injectable host interface for BunHttpAdapter (extension point)  |
| `BunServer`                         | type | Bun server handle returned by `Bun.serve`                       |
| `HttpAdapterFactories`              | type | Platform→adapter factory map for RuntimePlugin                  |

Contract notes:

- **M23 replaced M39's HTTP server adapters.** The `IHttpAdapter` contract now exposes the
  web-standard `fetch` entry: `setHandler` installs the framework handler, `fetch` is the universal
  entry point callable without `listen` (Cloudflare Workers), `listen` binds a real TCP socket, and
  `close` tears it down. Adapters (`NodeHttpAdapter`, `DenoHttpAdapter`, `BunHttpAdapter`,
  `CloudflareWorkersHttpAdapter`) are registered under `CAPABILITIES.HTTP_ADAPTER` via
  `RuntimePlugin`.
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
  uses `detail`).
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

| Export                                               | Kind     | Purpose                                                             |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `DecoratorPlugin`                                    | function | Plugin factory — registers `MetadataStore` and routes/services      |
| `MetadataStore`                                      | class    | `IMetadataStore` implementation (the concrete store)                |
| `metadataStore`                                      | value    | The process-wide singleton decorators write to and the plugin reads |
| `Controller`                                         | function | Class decorator — base path prefix                                  |
| `Version`                                            | function | Class decorator — API version prefix                                |
| `Get`/`Post`/`Put`/`Patch`/`Delete`/`Head`/`Options` | function | HTTP method decorators                                              |
| `Body`/`Query`/`Param`/`Header`/`Cookie`             | function | Request parameter decorators                                        |
| `Injectable`                                         | function | Class decorator — marks a class for DI registration                 |
| `Inject`                                             | function | Class decorator — declares constructor injection tokens             |
| `Roles`/`Permissions`                                | function | Class/method decorator — authorization requirements                 |
| `CurrentUser`                                        | function | Parameter decorator — injects `ctx.request.user`                    |
| `Public`                                             | function | Method decorator — bypasses auth                                    |
| `UseGuards`/`UseInterceptors`/`UseFilters`           | function | Class/method pipeline decorators                                    |
| `ValidateBody`/`ValidateQuery`/`ValidateParams`      | function | Method decorators — attach validation schemas                       |
| `ApiTags`                                            | function | Class decorator — OpenAPI tags                                      |
| `ApiOperation`/`ApiResponse`                         | function | Method decorators — OpenAPI operation metadata                      |
| `createDecorator`                                    | function | Custom class/method decorator factory                               |
| `createParameterDecorator`                           | function | Custom parameter decorator factory                                  |
| `resolveParameters`                                  | function | Resolves an ordered argument array from parameter metadata          |
| `resolveParameter`                                   | function | Resolves a single parameter value                                   |
| `registerParameterResolver`                          | function | Registers a resolver for a custom parameter type                    |
| `getParameterResolver`                               | function | Looks up a custom parameter resolver                                |
| `clearParameterResolvers`                            | function | Clears the custom resolver registry (tests)                         |
| `parseCookies`                                       | function | Parses a `Cookie` header into a name→value record                   |
| `discoverControllers`                                | function | Auto-discovers decorated classes from a directory                   |

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
- **No runtime-specific APIs**: the package uses no `Date.now()`, `Deno`, `process`, or `fs` — all
  file/time operations go through `IRuntimeServices`.

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
