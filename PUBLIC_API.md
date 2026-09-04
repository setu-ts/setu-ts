# Setu-TS — Public API Contract

> **This document describes how developers use the framework.** Implementation details are
> intentionally omitted.

---

## Table of Contents

1. [Installation](#installation)
2. [Full Stack Application](#full-stack-application)
3. [Minimal Application](#minimal-application)
4. [createApplication() (`@setu-ts/kernel`)](#createapplication-setu-tskernel)
5. [RuntimePlugin() (`@setu-ts/runtime`)](#runtimeplugin-setu-tsruntime)
6. [LoggerPlugin() (`@setu-ts/logger-plugin`)](#loggerplugin-setu-tslogger-plugin)
7. [ConfigPlugin() (`@setu-ts/config-plugin`)](#configplugin-setu-tsconfig-plugin)
8. [ValidationPlugin() (`@setu-ts/validation-plugin`)](#validationplugin-setu-tsvalidation-plugin)
9. [DatabasePlugin() (`@setu-ts/database-plugin`)](#databaseplugin-setu-tsdatabase-plugin)
10. [AuthPlugin() (`@setu-ts/auth-plugin`)](#authplugin-setu-tsauth-plugin)
11. [HttpSecurityPlugin() (`@setu-ts/http-security-plugin`)](#httpsecurityplugin-setu-tshttp-security-plugin)
12. [CachePlugin() (`@setu-ts/cache-plugin`)](#cacheplugin-setu-tscache-plugin)
13. [EventsPlugin() (`@setu-ts/events-plugin`)](#eventsplugin-setu-tsevents-plugin)
14. [SsePlugin() (`@setu-ts/sse-plugin`)](#sseplugin-setu-tssse-plugin)
15. [WebSocketPlugin() (`@setu-ts/websocket-plugin`)](#websocketplugin-setu-tswebsocket-plugin)
16. [RealtimeBackplanePlugin() (`@setu-ts/realtime-backplane-plugin`)](#realtimebackplaneplugin-setu-tsrealtime-backplane-plugin)
17. [SessionPlugin() (`@setu-ts/session-plugin`)](#sessionplugin-setu-tssession-plugin)
18. [ReactRouterPlugin() (`@setu-ts/react-router-plugin`)](#reactrouterplugin-setu-tsreact-router-plugin)
19. [WorkerPoolPlugin() (`@setu-ts/worker-pool-plugin`)](#workerpoolplugin-setu-tsworker-pool-plugin)
20. [SecretsPlugin() (`@setu-ts/secrets-plugin`)](#secretsplugin-setu-tssecrets-plugin)
21. [AuditPlugin() (`@setu-ts/audit-plugin`)](#auditplugin-setu-tsaudit-plugin)
22. [CQRS (`@setu-ts/cqrs-plugin`)](#cqrs-setu-tscqrs-plugin)
23. [Messaging (`@setu-ts/messaging-plugin`)](#messaging-setu-tsmessaging-plugin)
24. [Queue (`@setu-ts/queue-plugin`)](#queue-setu-tsqueue-plugin)
25. [Scheduler (`@setu-ts/scheduler-plugin`)](#scheduler-setu-tsscheduler-plugin)
26. [Resilience (`@setu-ts/resilience-plugin`)](#resilience-setu-tsresilience-plugin)
27. [Storage (`@setu-ts/storage-plugin`)](#storage-setu-tsstorage-plugin)
28. [MailPlugin() (`@setu-ts/mail-plugin`)](#mailplugin-setu-tsmail-plugin)
29. [Notifications (`@setu-ts/notification-plugin`)](#notifications-setu-tsnotification-plugin)
30. [Feature Flags (`@setu-ts/feature-flags-plugin`)](#feature-flags-setu-tsfeature-flags-plugin)
31. [Multi-Tenancy Plugin (`@setu-ts/multi-tenancy-plugin`)](#multi-tenancy-plugin-setu-tsmulti-tenancy-plugin)
32. [Health (`@setu-ts/health-plugin`)](#health-setu-tshealth-plugin)
33. [Metrics (`@setu-ts/metrics-plugin`)](#metrics-setu-tsmetrics-plugin)
34. [Telemetry (`@setu-ts/telemetry-plugin`)](#telemetry-setu-tstelemetry-plugin)
35. [OpenAPI (`@setu-ts/openapi-plugin`)](#openapi-setu-tsopenapi-plugin)
36. [CLI (`@setu-ts/cli`)](#cli-setu-tscli)
37. [REST API Application](#rest-api-application)
38. [Microservice Application](#microservice-application)
39. [CQRS Application](#cqrs-application)
40. [Plugin Creation](#plugin-creation)
41. [Custom Middleware](#custom-middleware)
42. [Custom Decorators](#custom-decorators)
43. [Service Discovery (`@setu-ts/service-discovery-plugin`)](#service-discovery-setu-tsservice-discovery-plugin)
44. [Programmatic vs Decorator API](#programmatic-vs-decorator-api)
45. [Developer Ergonomics](#developer-ergonomics)
46. [API Reference: @setu-ts/common](#api-reference-setu-tscommon)
47. [API Reference: @setu-ts/kernel](#api-reference-setu-tskernel)
48. [API Reference: @setu-ts/runtime](#api-reference-setu-tsruntime)
49. [API Reference: @setu-ts/exceptions](#api-reference-setu-tsexceptions)
50. [API Reference: @setu-ts/di-plugin](#api-reference-setu-tsdi-plugin)
51. [API Reference: @setu-ts/decorator-plugin](#api-reference-setu-tsdecorator-plugin)
52. [Testing Package (`@setu-ts/testing`)](#testing-package-setu-tstesting)
53. [SDK — Client SDK (`@setu-ts/sdk`)](#sdk--client-sdk-setu-tssdk)
54. [API Reference: @setu-ts/grpc-plugin](#api-reference-setu-tsgrpc-plugin)
55. [API Reference: @setu-ts/cloudflare-plugin](#api-reference-setu-tscloudflare-plugin)
56. [GraphQL (`@setu-ts/graphql-plugin`)](#graphql-setu-tsgraphql-plugin)
57. [Static Files Plugin (`@setu-ts/static-plugin`)](#static-files-plugin-setu-tsstatic-plugin)
58. [Boundary-Type Compatibility](#boundary-type-compatibility)
59. [Summary](#summary)

---

## Installation

Packages are published to [JSR](https://jsr.io) under the `@setu-ts` scope and are consumable from
every runtime:

```bash
# Deno
deno add jsr:@setu-ts/kernel jsr:@setu-ts/runtime

# npm / pnpm / yarn (via JSR's npm compatibility layer)
npx jsr add @setu-ts/kernel @setu-ts/runtime
pnpm dlx jsr add @setu-ts/kernel @setu-ts/runtime

# bun
bunx jsr add @setu-ts/kernel @setu-ts/runtime
```

Add plugins as needed:

```bash
deno add jsr:@setu-ts/logger-plugin jsr:@setu-ts/config-plugin \
         jsr:@setu-ts/validation-plugin jsr:@setu-ts/database-plugin \
         jsr:@setu-ts/auth-plugin jsr:@setu-ts/openapi-plugin
```

Or use a starter bundle:

```bash
deno add jsr:@setu-ts/rest-starter
```

---

## Full Stack Application

A full-featured service with caching, events, scheduling, and more:

```typescript
import { createFullStackApp } from '@setu-ts/full-stack-starter';

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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

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

## createApplication() (`@setu-ts/kernel`)

The entry point to the framework.

A capability is not resolvable from `app.services` until `start()` has run.

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

### Route Introspection

`app.router.listRoutes()` returns `RouteInfo` entries. Each entry has an optional `owner`: it is the
name of the plugin whose `register()` call created the route, and is absent for a route added
directly through `app.router`. Registering the same method and path twice throws instead of silently
replacing the first handler.

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
[Testing Package](#testing-package-setu-tstesting) for the full API.

---

## RuntimePlugin() (`@setu-ts/runtime`)

Provides runtime-agnostic services (UUID, timers, crypto, env, HTTP server).

### Registration

```typescript
import { RuntimePlugin } from '@setu-ts/runtime';

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
  onSignal?(signal: RuntimeSignal, handler: () => void): void;
}

type RuntimeSignal = 'SIGTERM' | 'SIGINT';
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
  // Answerable BEFORE a worker exists, which is why it sits on the host: a
  // consumer that must warn about undetectable worker death needs to know at
  // registration time. A host that omits it is treated as reporting `false`.
  reportsExit?(): boolean;
}

interface IWorkerHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  // The worker's THREAD ENDING, however it ended — a clean self-termination
  // included, which raises no error at all. `code` is `null` when the runtime
  // ends the worker without reporting one, and the listener also fires for a
  // host-requested `terminate()` on runtimes that implement it that way.
  onExit?(listener: (code: number | null) => void): void;
  terminate(): Promise<void>;
}
```

`onExit`/`reportsExit` are **omitted, not no-ops**, on a runtime that cannot report a worker exit:
their absence means "this runtime cannot tell me a worker died", never "no worker has died". The
Node host implements both over `node:worker_threads`' `'exit'`; the shared web-worker host does when
its runtime names an event that fires, which **Bun does (`'close'`) and Deno does not** — measured,
Deno's `Worker` emits nothing on `self.close()` and a later `postMessage` still resolves.

`dns` is an **optional** `IDnsResolver` for name resolution. It is implemented by the Node, Deno,
and Bun runtime adapters and **absent on Cloudflare Workers**, whose network access is `fetch` —
that resolves names internally and exposes no lookup surface. Callers must degrade gracefully when
it is not present; the `ServiceDiscoveryPlugin`'s `'dns'` provider throws a typed
`DiscoveryUnavailableError` during `register()`, naming the alternatives.

| Member     | Node | Deno           | Bun | Workers |
| ---------- | ---- | -------------- | --- | ------- |
| `fs`       | ✅   | ✅             | ✅  | ❌      |
| `workers`  | ✅   | ✅             | ✅  | ❌      |
| `dns`      | ✅   | ✅             | ✅  | ❌      |
| `onSignal` | ✅   | ✅ (not Win32) | ✅  | ❌      |

`onSignal` registers a process-termination handler so an application can run `app.stop()` — its
shutdown hooks, discovery deregistration, and broker disconnects — before the process dies. Handlers
are additive and are never removed: a process that received a termination signal is ending.

It is the one member absent for **two unrelated reasons**, and a caller must treat both the same way
(`runtime.onSignal?.(...)`). Cloudflare Workers omits it because an isolate is evicted rather than
signalled, so there is nothing to register for. The **Deno** adapter omits it on **Windows**, where
registering for `SIGTERM` throws rather than no-opping — so the presence of the key means "this
runtime can register a handler", never "this platform raises signals". A no-op was rejected
deliberately: it would let a caller conclude its shutdown handler runs when it never would.

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
`node:worker_threads`), each behind an injectable seam, plus a `@setu-ts/runtime/worker` subpath
whose sole export is `defineWorkerTask` (see the WorkerPoolPlugin section).

---

## LoggerPlugin() (`@setu-ts/logger-plugin`)

Provides structured logging via a capability token. The plugin depends on `RuntimePlugin` and
registers its `ILogger` under `CAPABILITIES.LOGGER` at `PLUGIN_PRIORITY.HIGH` (100) so logging is
available before most other plugins register.

### Registration

```typescript
import { LoggerPlugin } from '@setu-ts/logger-plugin';

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
import { CAPABILITIES, ILogger } from '@setu-ts/common';

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
import { ConsoleLogger, NoopLogger, PinoLogger } from '@setu-ts/logger-plugin';

const consoleLogger = new ConsoleLogger(runtime, { level: 'debug', pretty: true });
const noopLogger = new NoopLogger();
// PinoLogger uses async construction (import('npm:pino') is async):
const pinoLogger = await PinoLogger.create({ level: 'info', redact: ['password'] });
```

### Request Logging Middleware

```typescript
import { createRequestLoggerMiddleware } from '@setu-ts/logger-plugin';

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

## ConfigPlugin() (`@setu-ts/config-plugin`)

Provides strongly-typed configuration with environment validation and `.env` file loading.
Configuration is an immutable application-startup snapshot — values are loaded once at startup and
never mutated. Hot reload is deferred (the runtime contract has no file-watching abstraction).

### Registration

```typescript
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { CAPABILITIES } from '@setu-ts/common';
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
  readonly envFileOptional?: boolean;
  readonly validationSchema?: StructuralSchema<unknown>;
  readonly expandVariables?: boolean;
  readonly instance?: IConfig;
}
```

- **`envFilePath`** — Path or paths to `.env` files. Defaults to no file loading. When supplied, the
  runtime must provide `fs` (absent on edge platforms).
- **`envFileOptional`** — When `true`, a path in `envFilePath` that does not exist is skipped
  instead of throwing. Defaults to `false`, which is the behaviour released in `0.1.0`. Only ABSENCE
  is tolerated: a file that exists and cannot be read still throws. This is what a scaffolded
  project uses, because the dotenv file the CLI emits is gitignored and therefore absent on every
  fresh clone, in CI, and in a container built from the repository.
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
import { loadConfig } from '@setu-ts/config-plugin';
import { createRuntimeServices } from '@setu-ts/runtime';

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

## ValidationPlugin() (`@setu-ts/validation-plugin`)

Provides schema-based request validation with standardized error responses. Schemas are duck-typed
via a structural `safeParse()` interface — no hard Zod dependency in the plugin itself.

### Registration

```typescript
import { ValidationPlugin } from '@setu-ts/validation-plugin';

app.register(ValidationPlugin({
  // ValidationPlugin's own ErrorFormat union — distinct from the exceptions
  // package's, which has no 'nestjs' arm.
  errorFormat: 'rfc9457', // 'default' | 'rfc9457' | 'rfc7807' | 'nestjs' | custom function
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
import { CAPABILITIES, IValidationService, validatedStateKey } from '@setu-ts/common';

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

      ctx.state.set(validatedStateKey('body'), result.value);
      await next();
    },
  ],
  handler: async (ctx) => {
    const body = ctx.state.get<z.infer<typeof CreateUserSchema>>(validatedStateKey('body'));
    // body is fully typed and validated
    const user = await createUser(body);
    return ctx.response.status(201).json(user);
  },
});
```

### Validation Middleware Helpers

The helpers resolve `IValidationService` from the request context automatically. Validated values
are stored in `ctx.state` under `validatedStateKey(target)`.

```typescript
import { z } from 'zod';
import { validatedStateKey } from '@setu-ts/common';
import {
  validateBody,
  validateCookies,
  validateHeaders,
  validateParams,
  validateQuery,
} from '@setu-ts/validation-plugin';

app.router.get('/users', {
  middleware: [validateQuery(ListUsersQuerySchema)],
  handler: async (ctx) => {
    const query = ctx.state.get<z.infer<typeof ListUsersQuerySchema>>(validatedStateKey('query'));
    // query is validated
  },
});

app.router.put('/users/:id', {
  middleware: [
    validateParams(z.object({ id: z.string().uuid() })),
    validateBody(UpdateUserSchema),
  ],
  handler: async (ctx) => {
    const params = ctx.state.get(validatedStateKey('params'));
    const body = ctx.state.get(validatedStateKey('body'));
    // both are validated
  },
});
```

### Using the Service's middleware() Method

The `IValidationService.middleware()` method builds middleware with the formatter chosen at plugin
construction time:

```typescript
import { CAPABILITIES, IValidationService } from '@setu-ts/common';

app.router.post('/users', (ctx, next) => {
  const validation = ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION);
  return validation.middleware(CreateUserSchema, 'body')(ctx, next);
});
```

### Sanitization

Sanitization is a standalone export (not a method on `IValidationService`):

```typescript
import { SanitizationRules, sanitize } from '@setu-ts/validation-plugin';

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
import { createSanitizer } from '@setu-ts/validation-plugin';

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

#### RFC 9457 Problem Details

The `'rfc7807'` alias produces a **byte-identical** body: this formatter's `type` is a semantic URI
that was never derived from the status code, so it was already valid under RFC 9457.

```json
{
  "type": "https://setu-ts.dev/errors/validation",
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
import { ValidationPlugin } from '@setu-ts/validation-plugin';

app.register(ValidationPlugin({
  errorFormat: (issues) => ({
    ok: false,
    fields: issues.map((i) => ({ name: i.path, reason: i.message })),
  }),
}));
```

---

## DatabasePlugin() (`@setu-ts/database-plugin`)

Provides database access with repository pattern and unit of work.

### Registration

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

// Prisma 7 removed the Rust query engine, so a driver adapter is REQUIRED —
// `new PrismaClient()` with no argument does not compile.
const prismaClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.getOrThrow('DATABASE_URL') }),
});

app.register(DatabasePlugin({
  type: 'prisma',
  options: {
    prismaClient,
    logQueries: config.get('NODE_ENV') === 'development',
  },
}));
```

`DatabasePluginOptions` is a union discriminated on `type`, and each arm names the options its
adapter cannot run without: `'prisma'` requires `options.prismaClient`, `'drizzle'` requires both
`options.drizzleInstance` and `options.drizzleTables`, `'mongodb'` requires `options.url` (or an
injected `options.client`), `'dynamodb'` requires `options.region` (or an injected
`options.client`), and `'custom'` requires `adapter`. Omitting one is a **compile error** rather
than a startup throw. The exported arms are `MemoryDatabaseOptions`, `PrismaDatabaseOptions`,
`DrizzleDatabaseOptions`, `MongoDatabaseOptions`, `DynamoDatabaseOptions` and
`CustomDatabaseOptions`; `BuiltInDatabaseOptions` is the union of the five built-in arms and keeps
its published name, so an existing annotation carrying a memory configuration still compiles.
`PrismaAdapterOptions` and `DrizzleAdapterOptions` narrow `DatabaseAdapterOptions` for their arm;
`MongoAdapterOptions` and `DynamoAdapterOptions` are their arms' dedicated driver option bags.

Three Prisma 7 prerequisites are the application's to supply and are documented in the package
README: the driver-adapter package, a `prisma.config.ts` (Prisma 7 rejects `url` in
`schema.prisma`), and `new PrismaPg({ connectionString }, { schema })` for a non-`public` PostgreSQL
schema.

`DatabaseAdapterOptions.transactionTimeout` (ms, default `30000`) raises Prisma's ~5 s
interactive-transaction default, which is too short for a full Unit of Work. It is read by the
Prisma adapter only; Memory and Drizzle ignore it.

Prisma v7 clients are generated into an application-selected output path, so the Prisma adapter
requires an application-created `options.prismaClient`; it never imports or constructs that client.
`DatabaseAdapterOptions.url` remains source-compatible but is deprecated for Prisma configuration.
`DatabaseAdapterOptions.provider` (type `PrismaSqlProvider`) names the SQL connector the injected
client is bound to. Only the `contains` filter is connector-sensitive: it is escaped on
PostgreSQL/MySQL/SQL Server/CockroachDB, passed through unchanged on MongoDB (whose `contains`
compiles to a `$regex` match, where `%` and `_` are already literal so escaping them would be
wrong), and refused on SQLite (see the `contains` note above). When omitted, the adapter reads the
client's active provider structurally at `connect()` time; if it cannot be determined, a `contains`
filter throws `UnsupportedFilterOperatorError` naming this option, so pass it explicitly in that
case. Drizzle requires both `options.drizzleInstance` and `options.drizzleTables`. The instance is a
opaque `DrizzleDatabase<T>` configuration created by
`createDrizzleDatabase(database, transactionBridge)`; the registry's tables must carry an `id`
column and the adapter translates every repository field to a real Drizzle column. Drizzle `create`,
`update`, and `delete` require a driver with `RETURNING` support so their results are actual driver
rows; an unsupported dialect throws a descriptive error. Promise-aware SQLite Proxy and
libsql-shaped Drizzle instances without `execute()` are accepted for repository, transaction, and
typed-builder use. Calling `IDatabaseService.query()` on such an instance rejects with guidance to
use Drizzle's typed query builder. That refusal is permanent rather than pending: those drivers do
expose `all()`, but on a raw statement the proxy protocol answers with **positional** rows, because
Drizzle has no field map for a statement it did not build — and `query<T>()` promises row objects.

Synchronous callback drivers (`better-sqlite3`, Bun SQLite, Expo SQLite, and OP SQLite) are
unsupported: their native transaction closes when the callback returns, before awaited UoW work can
run. `createDrizzleDatabase()` rejects those published types at compile time, and startup rejects an
unwrapped structural instance. The explicit source-owned bridge is the positive capability that
asserts the selected driver awaits its callback Promise; unknown adopting-Promise and thenable
wrappers are rejected at startup before native transaction work begins.

`PrismaSqlProvider` still carries a `'mongodb'` member and the `PASSTHROUGH_PROVIDERS` mechanism
that holds it, but that arm is **unreachable on Prisma v7**: a Prisma client for MongoDB cannot be
constructed (generation succeeds, construction fails — Prisma states MongoDB "did not make the
Prisma 7 release" and returns in Prisma 8). The `'mongodb'` **adapter arm** above is the supported
MongoDB route; the `'mongodb'` provider string on the Prisma union is retained only because removing
it is a published export (AI_GUIDELINES §9.2), and the `contains`-to-`$regex` reasoning behind
`PASSTHROUGH_PROVIDERS` stays correct for any future Prisma-Mongo client.

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
    const newOrder = await orderRepo.create(await ctx.request.json());

    const stock = await inventoryRepo.findById(newOrder.productId);
    await inventoryRepo.update(newOrder.productId, {
      quantity: stock!.quantity - newOrder.quantity,
    });

    await paymentRepo.create({ orderId: newOrder.id, amount: newOrder.total });

    return newOrder;
  });

  return ctx.response.status(201).json(order);
});
```

### Typed Drizzle queries

```typescript
interface DrizzleDatabase<TDatabase extends object> { /* package-owned typed witness */ }
interface DrizzleDatabaseIdentity { /* erased opaque configuration identity */ }
type DrizzleTransaction<TDatabase extends object> = /* Drizzle transaction callback parameter */;
type DrizzleTransactionBridge<TDatabase extends object> = <T>(
  database: TDatabase,
  work: (transaction: DrizzleTransaction<TDatabase>) => Promise<T>,
) => Promise<T>;

function createDrizzleDatabase<const TDatabase extends object>(
  database: TDatabase,
  transaction: DrizzleTransactionBridge<TDatabase>,
): DrizzleDatabase<TDatabase>;
function getDrizzleDatabase<TDatabase extends object>(
  service: IDatabaseService,
  database: DrizzleDatabase<TDatabase>,
): TDatabase;
function getDrizzleTransaction<TDatabase extends object>(
  unitOfWork: IUnitOfWork,
  database: DrizzleDatabase<TDatabase>,
): DrizzleTransaction<TDatabase>;
```

Pass the same package-created opaque configuration supplied in `options.drizzleInstance`.
`getDrizzleDatabase()` infers and returns that complete configured type. `getDrizzleTransaction()`
structurally derives Drizzle's native transaction callback parameter from it, so schema and
selected-row inference survive while outer-only operations (for example SQLite Proxy's `batch()`)
are absent. Native joins and repository writes still participate in the same commit or rollback:

```typescript
import { eq } from 'drizzle-orm';
import {
  createDrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from '@setu-ts/database-plugin';

const drizzleDatabase = createDrizzleDatabase(
  drizzleDb,
  (database, work) => database.transaction(work),
);
const outer = getDrizzleDatabase(db, drizzleDatabase);
const rows = await outer.select().from(users);

await db.transaction(async (uow) => {
  await uow.getRepository<User>('User').create(newUser);

  const tx = getDrizzleTransaction(uow, drizzleDatabase);
  const joined = await tx
    .select({ userId: users.id, teamName: teams.name })
    .from(users)
    .innerJoin(teams, eq(users.teamId, teams.id));
});
```

The opaque configuration carries compile-time correlation while its database, bridge, and validity
remain in package-private storage. It is frozen with a null prototype as defense in depth; mutation,
spread, assignment, cloning, prototype inheritance, and cross-instance reuse do not create accepted
identities. A caller cannot select a forged generic at the UoW call, and a configuration from
another database throws. Use `getDrizzleDatabase()` for outer-only operations;
`getDrizzleTransaction()` intentionally returns only the transaction-safe callback surface. The
distinct functions also keep a service widened structurally to `IUnitOfWork` runtime-truthful.
Memory, Prisma, and custom services/UoWs throw
`Drizzle query access requires adapter 'drizzle'; configured adapter is '<type>'.` A structural
service or Unit of Work not created by this package throws
`Drizzle query access requires a database-plugin service or unit of work.`

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

interface IRepository<Entity, Id extends EntityKey = string> {
  findById(id: Id): Promise<Entity | null>;
  findAll(options?: FindOptions): Promise<Entity[]>;
  findOne(options?: FindOptions): Promise<Entity | null>;
  findPage(options: PageOptions): Promise<Page<Entity>>;
  create(data: Partial<Entity>): Promise<Entity>;
  update(id: Id, data: Partial<Entity>): Promise<Entity>;
  delete(id: Id): Promise<boolean>;
  exists(id: Id): Promise<boolean>;
  count(options?: CountOptions): Promise<number>;
}
```

`query()` is the existing backend-specific raw-SQL escape hatch. It requires a configured Drizzle
instance with `execute()`; typed builders obtained through the Drizzle accessors do not.

Every adapter binds `params` and never interpolates them, and the statement carries the connector's
own placeholders — `$1…` on PostgreSQL, `?` on MySQL and SQLite. Prisma and D1 forward the text
verbatim; the Drizzle adapter splits it at its placeholders and rebuilds it through Drizzle's own
`SQL` chunks, which emits an ascending-placeholder statement byte-identically. A placeholder count
that disagrees with `params`, a gap in the `$N` sequence, or both placeholder styles in one
statement is refused before the driver is reached, because a mis-bound parameter is silent. On
PostgreSQL, `?`, `?|` and `?&` are also jsonb key-containment operators that no scanner can tell
from a placeholder; such a statement is refused or fails at the database, never mis-bound — write it
with `$N` placeholders. Programmatic `migrate()` is unsupported by all current adapters and rejects
because each ORM owns migrations through its CLI.

`FindOptions.filter` and `CountOptions.filter` accept a portable expression tree in addition to the
existing equality-only `where` map. `where` and `filter` are conjoined, and every built-in adapter
evaluates the same operators: `eq`, `contains`, `gt`, `gte`, `lt`, `lte`, and `in`, nested with
`and` / `or`. `findOne()` applies the same options as `findAll()` and returns the first match or
`null`.

```typescript
const users = await userRepo.findAll({
  where: { active: true },
  filter: {
    type: 'or',
    filters: [
      { type: 'comparison', field: 'name', operator: 'contains', value: 'Ada' },
      { type: 'comparison', field: 'age', operator: 'gte', value: 18 },
    ],
  },
});
```

An `in` with an empty list matches nothing, and a list containing `null` matches rows whose column
is null — SQL `IN` never matches `NULL` by itself, so the SQL adapters emit an explicit null branch.
`contains` is a substring match whose `%` and `_` are always data rather than wildcards; its **case
sensitivity is the database's**, not the framework's — Memory, D1 and Mongo match case-sensitively,
while a `LIKE`-based backend follows the column's collation (case-sensitive on PostgreSQL,
case-insensitive on SQLite and most MySQL collations). Mongo compiles to `$regex`, to which MongoDB
does not apply collation, so a case-insensitive collection collation does not make it
case-insensitive. Collation control is not part of this contract.

On the **Prisma** adapter the connector decides how that guarantee is met. On PostgreSQL, MySQL, SQL
Server, and CockroachDB the value is escaped and matched literally, because their `LIKE` defaults
its escape character to backslash. On **SQLite** the guarantee is not expressible through Prisma's
filter API (Prisma emits no `ESCAPE` clause and SQLite has no default escape character), so a
`contains` filter throws `UnsupportedFilterOperatorError` rather than return wrong rows; pass a raw
query, or use the Memory/Drizzle adapter (both honour `contains` as a literal substring). When the
adapter cannot determine the connector it throws the same error naming the `provider` option; pass
`provider` (e.g. `provider: 'postgresql'`) in the adapter options to name it explicitly.

### The Memory adapter's guarantees

`MemoryAdapter` is the default and is never given a schema, which fixes what it can enforce. An
unknown `select` or `orderBy` field — one that **no stored row carries** — is refused by name,
matching what Drizzle answers for the same call; a field present on at least one row counts as
known, and an entity holding no rows accepts anything, since there is nothing to observe and nothing
to return. An unknown `where` or `filter` field is **not** refused: without a schema the adapter
cannot tell an unknown column from one absent on every row, and matching nothing is a defensible
answer.

Uniqueness, column types, foreign keys, checks and defaults are **not enforced** and cannot be by a
schema-less store. Use this adapter for development and tests, and run integration tests against the
backend you deploy on.

### Custom Adapters (external backends)

`DatabasePluginOptions` is a union discriminated on `type`. The `'custom'` arm accepts any
`IDatabaseAdapter` from `@setu-ts/common`, which is how a backend implemented outside this package
is registered — no plugin imports another plugin.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { D1Adapter, type ID1Database } from '@setu-ts/cloudflare-plugin';

app.register(DatabasePlugin({
  type: 'custom',
  adapter: new D1Adapter(env.DB as ID1Database),
}));
```

`adapter` is required by the union, so a `'custom'` registration that omits it is a compile error
rather than a startup throw. The plugin calls `connect()` on the adapter during `register()` and
`disconnect()` on shutdown; it never constructs or replaces it. `name` and `options` apply as usual
— `logQueries` routes a custom adapter's data sources through the same single logging wrapper every
built-in adapter uses.

The port to implement:

```typescript
interface IDatabaseAdapter extends IOrmAdapter {
  createDataSource(entity: string): IDataSource;
  beginTransaction(): Promise<IAdapterTransaction>;
  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface IDataSource {
  findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]>;
  findById(id: EntityKey): Promise<Record<string, unknown> | null>;
  create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>>;
  update(
    id: EntityKey,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  delete(id: EntityKey): Promise<boolean>;
  findPage?(query: NormalizedQuery): Promise<PageResult>;
  count(where: Record<string, unknown>, filter?: FilterExpression): Promise<number>;
}
```

A data source owns query evaluation end to end — it applies `where`, `orderBy`, `offset`/`limit` and
`select` itself, and `BaseRepository` must not re-apply any of them.

**Breaking for implementors as of M79.** `findById`/`update`/`delete` moved from `string | number`
to `EntityKey`, which adds a composite-record arm. A parameter is contravariant, so an adapter still
declaring the scalar-only form is a compile error; callers passing a scalar are unaffected. The same
release widened `FilterComparison.field` to `string | readonly string[]` (an array is a nested
document path) and the `gt`/`gte`/`lt`/`lte` value to accept `Date`, so any code READING those
fields must handle both forms.

`findPage` is **optional**. Every adapter this framework ships implements it; an adapter that cannot
page by cursor omits it, and the repository refuses by name rather than returning an empty page — so
absence means "this backend cannot page by cursor", never "there are no more rows".

### Composite keys, nested paths and cursor pagination (M79)

`@setu-ts/common` exports the portable data-access contract these three features rest on, and is
where a backend author imports it from — the codec lives there because `cloudflare-plugin` needs the
identical encoding and a plugin may not import another plugin (AI_GUIDELINES §2.2).

`@setu-ts/database-plugin` re-exports the subset its own consumers reach for — `EntityKey`,
`PageResult`, `CursorPayload`, `CursorValue`, `encodeCursor`, `decodeCursor` and `keysetPredicate`.
`sortFingerprint`, `mintNextCursor` and `resolveKeysetSort` are **not** re-exported; import them
from `@setu-ts/common`.

| Symbol              | Kind      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EntityKey`         | type      | A primary key: a scalar `string`/`number`, or a composite `Readonly<Record<string, string \| number>>`. A record rather than an array, because a composite key is named columns and an array would make the caller depend on a column order the mapping owns.                                                                                                                                                              |
| `PageResult`        | interface | `{ rows, nextCursor }` returned by `IDataSource.findPage`. `nextCursor` is `null` exactly when the page is the last.                                                                                                                                                                                                                                                                                                       |
| `CursorPayload`     | interface | The decoded contents of a cursor: `orderedValues`, `keyValues`, and a `sortFingerprint`.                                                                                                                                                                                                                                                                                                                                   |
| `CursorValue`       | type      | A scalar a cursor can carry: `string \| number \| Date`. Dates survive the round trip as `Date`, not as ISO strings.                                                                                                                                                                                                                                                                                                       |
| `encodeCursor`      | function  | Encodes a `CursorPayload` as an opaque base64url token.                                                                                                                                                                                                                                                                                                                                                                    |
| `decodeCursor`      | function  | Decodes a token, or returns `null` when it is malformed — it never throws, because the token is untrusted caller input.                                                                                                                                                                                                                                                                                                    |
| `keysetPredicate`   | function  | Builds the "row after this one" comparison as a portable `FilterExpression`.                                                                                                                                                                                                                                                                                                                                               |
| `sortFingerprint`   | function  | The stable fingerprint embedded in every cursor.                                                                                                                                                                                                                                                                                                                                                                           |
| `mintNextCursor`    | function  | Mints the next-page cursor from the last row of a non-terminal page. Refuses a value that cannot survive the wire — `null`/`undefined`, a non-finite number, an invalid `Date`, or a non-scalar — naming the field, because each of those otherwise fails on the NEXT request or one frame from its cause.                                                                                                                 |
| `resolveKeysetSort` | function  | The sort a keyset comparison is expanded over: the caller's `orderBy` plus any key columns it lacks, appended ascending. **A backend must order by this, not by `orderBy`** — ordering by the caller's fields alone leaves tied rows in an order the database picks freely, and the predicate then skips or repeats them. `keysetPredicate` derives its own comparison from the same function, so the two cannot disagree. |

#### Composite keys

`findById`, `update` and `delete` accept a composite record. Each adapter learns its key columns
from a per-entity mapping whose primary-key field accepts a column list:

```typescript
// Cloudflare D1
new D1Adapter(env.DB as ID1Database, {
  tables: { Membership: { table: 'memberships', primaryKey: ['tenant_id', 'user_id'] } },
});

// MongoDB — flat top-level key columns (the default for a composite key)
DatabasePlugin({
  type: 'mongodb',
  options: { url },
  mongoEntities: { Membership: { primaryKey: ['tenantId', 'userId'] } },
});
```

A repository declares its key type and addresses rows with a record:

```typescript
const repo = db.getRepository<Membership, { tenantId: string; userId: string }>('Membership');
await repo.findById({ tenantId: 't1', userId: 'u1' });
```

A scalar key against a multi-column entity, or a record missing a column, is refused by name.

**MongoDB `idType: 'compound'`** stores the composite key as a subdocument `_id`. The subdocument is
built in the **mapping's** declared column order, never the caller's key-object order: a Mongo
subdocument `_id` is matched by exact, order-sensitive equality, so `{userId, tenantId}` does not
match a document stored as `{tenantId, userId}`. The default for a composite key is flat top-level
columns, which are order-independent and constrained by a unique index.

**Prisma** addresses a compound key through Prisma's own compound-key field. The name is derived by
joining the key columns with `_`, matching what Prisma generates for an unnamed `@@id`. A model
declaring a **named** `@@id` must set `compositeKeyName` — Prisma rejects the derived name on such a
model, so this is required rather than optional:

```typescript
DatabasePlugin({
  type: 'prisma',
  options: { prismaClient },
  entities: {
    Membership: { keyColumns: ['tenantId', 'userId'] },
    Enrollment: { keyColumns: ['courseId', 'personId'], compositeKeyName: 'enrollmentKey' },
  },
});
```

#### Nested field paths

`FilterComparison.field` accepts a `readonly string[]` as a document path. A plain `string` is a
flat field, unchanged. A dotted string is **not** a path — a column whose name legitimately contains
a dot keeps its meaning.

```typescript
await repo.findAll({
  filter: { type: 'comparison', field: ['address', 'city'], operator: 'eq', value: 'Kolkata' },
});
```

Every adapter that supports a path translates it natively; none filters in JavaScript. **D1 is the
explicit exception** and refuses one by name. An empty path array is always refused — a filter that
quietly matches everything is a data-exposure defect, not a no-op.

| Adapter | Translation                                                                                 |
| ------- | ------------------------------------------------------------------------------------------- |
| Memory  | walks the document                                                                          |
| Mongo   | the native dotted key (`address.city`)                                                      |
| Prisma  | the JSON `path` filter — an array on PostgreSQL/CockroachDB, `$.a.b` on MySQL               |
| Drizzle | per dialect: PostgreSQL `#>>`, MySQL `JSON_UNQUOTE(JSON_EXTRACT(…))`, SQLite `json_extract` |
| D1      | refused by name (SQLite's `LIKE` has no expressible escape character)                       |

Two translation facts are worth knowing before relying on a path filter, both measured rather than
inferred:

- **`in` is expanded, not translated.** Neither Prisma's JSON path filter nor any SQL dialect offers
  a path membership operator, so `in` becomes an `OR` of equality legs. An empty list compiles to a
  match-nothing predicate that binds no values.
- **Extraction normalises to text, and an ordered comparison against a `number` casts back.**
  PostgreSQL's `#>>` and MySQL's `JSON_UNQUOTE` are text-valued while SQLite's `json_extract`
  preserves the JSON type, so without normalising, one filter would mean two different things.
  Casting back for `gt`/`gte`/`lt`/`lte` on a number is what makes `age > 9` match `30` — as text,
  `'30' > '9'` is false.

A `Date` is refused on a path filter on every SQL adapter: a JSON document has no date type, so the
stored representation is whatever the writer chose. Compare an ISO string, or give the value its own
column.

**Prisma requires `provider`** and **Drizzle may require `dialect`** for a path filter, because the
syntax differs per connector and neither library publishes a discriminant the adapter can read
reliably. Drizzle detects its dialect from the instance and needs the option only when detection
fails; either way, an adapter that cannot determine the syntax **refuses by name** rather than
emitting a guess — a guessed syntax returns wrong rows on the engine it guessed wrong about, where a
refusal names the option that fixes it.

```typescript
DatabasePlugin({
  type: 'drizzle',
  options: { drizzleInstance, drizzleTables, dialect: 'postgresql' },
});
```

#### Cursor pagination

```typescript
let cursor: string | null = null;
do {
  const page = await repo.findPage({ orderBy: { createdAt: 'desc' }, limit: 50, cursor });
  handle(page.rows);
  cursor = page.nextCursor;
} while (cursor !== null);
```

`offset` is unchanged and not deprecated; the cursor is additive beside it. A query carrying
**both** a non-zero `offset` and a `cursor` is refused, because the two express contradictory
positions — "skip this many from the start" and "after this row".

`nextCursor` carries one guarantee: it is non-`null` exactly when a further page exists — including
a zero-row page that is not the last — and it is never derived from `rows.length`. Backends mint it
by one of two mechanisms. The row-based adapters fetch `limit + 1` rows and answer `null` precisely
when the extra row is absent. The DynamoDB adapter instead carries the server's own continuation key
(`LastEvaluatedKey`) inside the token and answers `null` exactly when the server returned none:
DynamoDB applies `Limit` before `FilterExpression`, so a filtered page can return fewer rows than
`limit` — or none — while further matching rows remain, and a row-count probe would report the walk
terminal and silently drop rows.

The cursor is opaque and carries a fingerprint of the sort it was minted under, so presenting it
under a different `orderBy` is refused rather than served a silently wrong page. The resolved sort
always ends in the entity's key columns: over rows sharing a sort value, a walk without that
tiebreaker silently **loses rows** — measured at four of six against live PostgreSQL and MongoDB.

`ORDER BY` on a `Date` column requires the `Date` arm of the ordered comparison, which is why that
widening ships alongside. Cloudflare D1 refuses a `Date` by name: SQLite has no date type, so the
adapter cannot know whether the column stores an ISO string or an epoch integer.

### MongoDB backend (`'mongodb'` arm)

`MongoAdapter` is a document-store backend over the native `mongodb` driver (`npm:mongodb@^6.21.0`),
registered through the same discriminated union as every other backend:

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'mongodb',
  options: {
    url: 'mongodb://127.0.0.1:27017/app',
    // or inject a constructed client so the driver is never imported:
    // client: new MongoClient(url),
  },
}));
```

`MongoAdapterOptions` is the Mongo-specific option bag, and it is a **union of two arms**: one
requires `url` (the connection string), the other requires `client` (an already-constructed
`IMongoClient`). Supplying neither is a compile error rather than a `connect()` throw — the
guarantee every other built-in arm gives. `MongoAdapterOptionsBase` is the half both arms share
(`objectIdCtor`, `database`, `collections`). When `client` is present the lazy
`import('npm:mongodb@^6.21.0')` never runs; the injected client is structural, so a driver of a
different major that honours the same shapes is accepted. An injected client that uses ObjectId
values supplies its `objectIdCtor` companion, so the adapter can convert 24-hex repository ids
without importing the driver. `database` names the database; when absent the one encoded in `url` is
used, and if neither yields a name `connect()` fails at startup naming the option. `collections` is
a per-entity override (`{ collection?, primaryKey?,
idType? }`); an unmapped entity uses its own
name as the collection and `'id'` as the primary key — the D1-shaped two-layer mapping, where the
public surface is a per-entity override with a zero-config default and the internal target is
unexported.

Identity maps `_id` to the configured primary key on read and back on write. Because a
`findOne({_id: "<24-hex>"})` misses when `_id` is an `ObjectId`, the driver id is converted with a
24-hex **string** test for an `idType` of `'auto'` (the default), forced for `'objectId'`, and
forbidden for `'raw'`. The string half of that test is load-bearing rather than defensive: the
driver's own `ObjectId.isValid` answers `true` for **any number** while its constructor rejects one,
so a collection keyed by application-assigned numbers is passed through verbatim — `findById`,
`update` and `delete` accept `string | number`, and a numeric key must reach the driver unconverted.
On read the inverse holds: an `ObjectId` is rendered as its 24-hex string, while a JSON scalar keeps
its own type, so the value `create()` returns is the value `findById()` accepts. `primaryKey` may
name `_id` itself, in which case the row keeps that field rather than having it renamed away. The
primary key never travels in an update payload — MongoDB refuses a `$set` that would change `_id`,
and `update` moves no row to a new key on any adapter.

`find` serves `orderBy`/`offset`/`limit`/`select` natively as `sort`/`skip`/`limit`/`projection`,
and `contains` compiles to a `$regex` match with an escaped value (the inverse of the SQL
`contains`), so `%` and `_` in the searched value stay literal. An empty filter group compiles to
its boolean identity — an empty `and` matches every document, an empty `or` matches none — because
MongoDB refuses `$and: []`/`$or: []` outright, and those are the answers Memory and Drizzle give.

`rawQuery` is refused by name with `UnsupportedRawQueryError` — MongoDB has no SQL, so an
application reaches the injected client directly for native commands, exactly as it does for a
Prisma raw query. Transactions use a `startSession()` and are refused at `beginTransaction()` with
`MongoTransactionUnavailableError` on a deployment that is not a replica set, never at `connect()`.

`IMongoClient` and `IMongoObjectIdCtor` are the exported injection seam. The real driver implements
their structural shapes. The types the client's members reference — `IMongoDatabase`,
`IMongoSession`, and the `IMongoObjectId` instance shape — are exported alongside them so the seam's
return types are nameable from the package entry, as are the collection-level shapes
`IMongoDatabase.collection()` reaches (`IMongoCollection`, `IMongoCursor`,
`IMongoCollectionFindOneAndUpdateOptions`, and the `MongoOptions`/`MongoWriteOptions` option bags).

### DynamoDB backend (`'dynamodb'` arm)

`DynamoAdapter` is a key-value backend over the native AWS SDK v3 client
(`npm:@aws-sdk/client-dynamodb@^3`), registered through the same discriminated union as every other
backend:

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'dynamodb',
  options: {
    region: 'us-east-1',
    // `endpoint` addresses the local emulator in development and tests; absent
    // in production, where the SDK's own endpoint resolution applies.
    entities: { Order: { partitionKey: 'tenantId', sortKey: 'orderId' } },
  },
}));
```

`DynamoAdapterOptions` is the DynamoDB-specific option bag, and it is a **union of two arms**: one
requires `region` (with an optional `endpoint` — the emulator address — and `credentials`), the
other requires `client`, an already-constructed client behind the structural `IDynamoClient` facade.
Supplying neither is a compile error rather than a `connect()` throw — the guarantee every other
built-in arm gives. `DynamoAdapterOptionsBase` is the half both arms share (`entities`,
`maxPageFetches`). When `client` is present the lazy `import('npm:@aws-sdk/client-dynamodb@^3')`
never runs. The adapter owns marshalling and deliberately does **not** use `lib-dynamodb`'s
`DocumentClient`: automatic marshalling would hide two facts the adapter must decide — DynamoDB has
no date type, so the encoding of a `Date` comparison is the mapping's decision, and a DynamoDB `N`
is an arbitrary-precision decimal that `Number()` degrades.

`entities` is the per-entity mapping
(`{ table?, partitionKey, sortKey?, indexes?, dateAttributes? }`); an unmapped entity uses its own
name as the table and `'id'` as the partition key. A scalar key is accepted only for a
partition-only entity — against a sort-keyed entity it is refused by name, because a `GetItem`
carrying only the partition key is a server-side `ValidationException`. A composite key record is
projected down to exactly the resolved key columns (an extra attribute is the same server-side
refusal), and a record missing a column, or carrying an empty-string value, is refused by name. The
key map itself is order-insensitive — the opposite of a Mongo compound `_id` subdocument — so no
canonical ordering is applied.

Both single-row writes are conditional, because the unguarded forms violate the `IDataSource`
contracts silently — both measured against the real emulator. `create` carries
`attribute_not_exists(<partitionKey>)`: an unguarded `PutItem` on an existing key silently
overwrites the item and drops every attribute absent from the new one, answering `200`. `update`
carries `attribute_exists(<partitionKey>)` with `ReturnValues: 'ALL_NEW'`: an unguarded `UpdateItem`
on a missing key upserts a ghost item and returns it as though it were an update, so the conditional
failure (`ConditionalCheckFailedException`) is what produces the documented rejection. `delete`
reads `ReturnValues: 'ALL_OLD'` for its boolean — no read-before-delete round trip, and no constant
`true`.

The access path is resolved from the caller's query: an equality on the entity's partition key (or
on a configured index's partition key, selecting that GSI) is a `Query`; everything else is a
`Scan`, because a `Query` without a partition-key equality is a server-side `ValidationException` —
the selection is forced, not an optimisation. Every predicate not folded into the key condition
becomes a `FilterExpression`, and every attribute name is aliased through a generated placeholder,
so a reserved word like `status` cannot reach the server raw. A non-empty `select` is pushed down as
a `ProjectionExpression`, so the server returns only the projected attributes rather than whole
items; repeated and empty field names are dropped first, because DynamoDB refuses a projection
naming one path twice (`Two document paths overlap with each other`, even under distinct aliases)
and refuses an empty attribute name outright. Push-down is safe for cursor paging:
`LastEvaluatedKey` is computed independently of the projection, so a projection omitting the key
columns still resumes correctly. `orderBy` is served only when it names exactly the resolved access
path's sort key (as `ScanIndexForward`); a non-key or multi-field `orderBy` is refused by name with
`UnsupportedQueryFeatureError`, and a non-zero `offset` is refused the same way — both because the
SDK **accepts and silently discards** the unrecognised parameter, answering `200` with unordered or
unskipped rows, so forwarding one returns confidently wrong rows with no diagnostic anywhere in the
stack.

Pagination is the server's own continuation token carried inside the portable cursor codec, and the
invariant is exact: `nextCursor` is non-`null` **if and only if** the response carried a
`LastEvaluatedKey` — never derived from `rows.length`, because `Limit` is applied before
`FilterExpression` and a filtered page can return fewer rows than the limit, or zero, and still not
be the last. A bounded fill loop (`maxPageFetches`, default `10`) keeps fetching while a page is
short and a token remains; at the bound it returns what it has with a non-`null` cursor, never a
terminal page. `maxPageFetches` must be a positive integer and is validated at construction: the
loop runs while `fetches < maxPageFetches`, so `Infinity` would silently remove the very bound the
option imposes (a `findPage` whose filter matches nothing would scan the whole partition to
exhaustion) and `NaN` would make the comparison `false` on the first pass, collapsing the loop to a
single server page — neither raises anything on its own, so both are refused by name up front.
`count()` loops to exhaustion for the same reason — a paged `COUNT` response under-reports past the
first page. A `Date` comparison must be declared per attribute
(`dateAttributes: { createdAt: 'iso' | 'epochMs' }`) or it is refused by name naming the option, and
an out-of-range decimal `N` is preserved on read as its string rather than degraded through
`Number()`. Transactions buffer writes and flush them as one `TransactWriteItems` at commit —
refused by name past 100 items, or on two operations for one item key — and reads inside a
transaction see committed state (no read-your-own-writes), documented rather than emulated.

`IDynamoClient` and `DynamoSdkModule` are the exported injection seam, with
`createInjectedDynamoLoader` and `createLazyDynamoLoader` as its two arms. The command and attribute
shapes the client's members reference — `DynamoAttributeValue`, `DynamoEntityMapping`,
`DynamoIndexMapping`, `DynamoDateEncoding`, and the `Dynamo*CommandInput`/`Output`/`Transact*`
closure — are exported alongside them so the seam's return types stay nameable from the package
entry. The internal target resolution, expression builder, marshaller and access-path resolver are
not exported.

### Cosmos DB backend (`'cosmos'` arm)

`CosmosAdapter` serves Azure Cosmos DB's **NoSQL (SQL) API** over `npm:@azure/cosmos@^4`, registered
through the same discriminated union as every other backend:

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'cosmos',
  options: {
    endpoint: 'https://my-account.documents.azure.com:443/',
    key: cosmosKey,
    database: 'app',
    containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
  },
}));
```

Cosmos DB's **MongoDB API** is a different wire protocol; it is served by the `'mongodb'` arm
pointed at a Cosmos connection string. That route is documented and **not verified against a live
account**: the emulator's MongoDB endpoint tops out at API version 4.0 (wire version 7) while the
`npm:mongodb@^6` driver this package pins requires wire version 8, so it cannot be exercised there.

`CosmosAdapterOptions` is a **union of two arms**: one requires `endpoint` + `key`, the other
requires `client` (an already-constructed structural `ICosmosClient`, which is how an Entra ID or
connection-string client reaches the adapter). `database` is required on BOTH arms, because a Cosmos
endpoint encodes no database name and there is nothing to fall back to. `CosmosAdapterOptionsBase`
is the half both arms share (`database`, `containers`, `logQueries`). `containers` is a per-entity
override (`{ container?, primaryKey?, partitionKey? }`); an unmapped entity uses its own name as the
container and `'id'` as the primary key — the D1-shaped two-layer mapping.

**The adapter provisions nothing.** Cosmos creates no database or container implicitly, and
throughput, partition-key and indexing choices belong to the application; a missing container is
refused by name at first use.

**The partition key is discovered from the container definition** and read once per container. A
declared `partitionKey` is validated against it and refused by name on a mismatch — a point read
carrying the wrong partition key answers **404 rather than an error**, so an unvalidated mapping
would report "not found" for every row of a healthy container.

**Identity.** A document is addressed by (partition key, `id`). `findById` point-reads when the key
carries the partition key, or when the container partitions by the primary-key field; otherwise it
resolves the row by a cross-partition query, which costs more request units and is refused by name
when the id matches two documents, since an id is unique only within a partition. A primary key must
be a **string** — the service refuses any other type, and converting silently would change the type
a caller gets back from `create()`.

**`update`** merges through a server-side `patch` while the payload fits one request and through a
read-merge-`replace` guarded by `_etag` beyond it, raising `CosmosConcurrentModificationError` on a
lost race. A payload that would change a partition-key value is refused by name, because such a
replace answers 404 rather than moving the item.

`contains` compiles to `CONTAINS`, a literal substring match (no `%`/`_` escaping, case-sensitive);
`in` compiles to `ARRAY_CONTAINS` with the list bound as one array parameter, so an empty list
matches nothing natively. `offset`/`limit` are served natively, with the contract's `-1` sentinel
translated rather than passed through (Cosmos refuses `LIMIT -1`, and refuses `OFFSET` without
`LIMIT`).

**Pagination uses the portable keyset cursor**, not a Cosmos continuation token — this adapter's
design choice, matching what the tested backend supports: measured against the emulator, an
`ORDER BY` query returns no continuation token even with `maxItemCount` passed as a query option.
The claim is scoped to that measurement rather than asserted of every Cosmos deployment. On a real
account, keyset paging therefore needs a composite index over `(sort field, id)` for each paged
container, because the walk always adds the key column as its tiebreaker.

**`rawQuery` is refused by name** with `UnsupportedRawQueryError`: a Cosmos SQL query is scoped to
one container and the signature names none, so an application reaches the injected client directly.

**Transactions are a deferred batch.** `beginTransaction()` buffers every write and flushes it as
one transactional batch at commit; `rollback()` discards it and sends nothing. The batch is atomic
within one container and one partition-key value and caps at 100 operations, and a write crossing
any of those bounds raises `CosmosTransactionScopeError` at that write. Reads inside a transaction
observe committed state only — the deferred-write clause `IDataSource` documents. A buffered
`update` is sent as a **patch**, so it writes only the fields its payload names and two updates of
one row compose; an update too wide for a single patch request falls back to a whole-document
replace, which cannot compose, so buffering one for a row the transaction has already written is
refused rather than silently discarding the earlier write. `rollback()` is idempotent (`commit()` is
not), because the framework rolls back inside the same `catch` that sees a failed commit — refusing
there would replace the batch's own per-operation diagnostic with a complaint about rollback.

**What the arm deliberately cannot do**, split by who could close it. Two are platform limits:
Cosmos rejects a **cross-container join** with a 400 (a query addresses one container; its own
`JOIN` unwinds an array inside a single item), and returns **no continuation token** for an
`ORDER BY` query on the tested emulator. Three are contract limits: **grouping** is absent from
`NormalizedQuery`, which carries no aggregate beyond `count` — the Cosmos dialect does support
`GROUP BY`, so closing that is a `common` widening every adapter must answer; `rawQuery` is refused
because the committed signature names no container; and request units, consistency levels, TTL and
index policy are outside the portable contract by design (the M79 exclusion). An application needing
any of them reaches the injected client, as it does for a Prisma raw query.

`ICosmosClient` and the shapes it reaches (`ICosmosDatabase`, `ICosmosContainer`, `ICosmosItems`,
`ICosmosItem`, `ICosmosQueryIterator`, `CosmosQuerySpec`, `CosmosQueryParameter`,
`CosmosPartitionKeyValue`) are the exported injection seam, together with the response and operation
shapes those members return and accept (`CosmosItemResponse`, `CosmosFeedResponse`,
`CosmosRequestOptions`, `CosmosAccessCondition`, `CosmosPatchOperation`, `CosmosBatchOperation` with
its four arms `CosmosBatchInsertOperation`, `CosmosBatchReplaceOperation`,
`CosmosBatchPatchOperation` and `CosmosBatchDeleteOperation`, `CosmosBatchResponse`,
`CosmosContainerDefinition`) — so the seam's own signatures are nameable from the package entry. The
real SDK implements their structural shapes.

### Cloud Bigtable backend (`'bigtable'` arm)

`BigtableAdapter` serves Google Cloud Bigtable over `npm:@google-cloud/bigtable@^6`, registered
through the same discriminated union as every other backend:

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'bigtable',
  options: {
    projectId: 'my-project',
    instance: 'app-instance',
    tables: {
      Order: {
        table: 'orders',
        rowKey: { fields: ['tenantId', 'orderId'], separator: '#' },
        columnFamily: 'o',
        columns: { total: 'metrics:amount' },
      },
    },
  },
}));
```

**Bigtable inverts the DynamoDB problem.** Its row key is a single lexicographically-sorted string,
so `findById` fits it natively with no key object at all. What it lacks instead is everything around
the key: there is **no secondary index of any kind**, so a predicate on a non-key column is a scan
and `orderBy` is row-key order or nothing.

`BigtableAdapterOptions` is a **union of two arms**: one requires `projectId` (with an optional
`apiEndpoint` for an emulator), the other requires `client` (an already-constructed structural
`IBigtableClient`, which is how a client built with non-default credentials reaches the adapter).
`instance` is required on BOTH arms, because a table is addressed as `project/instance/table` and
neither a client nor a project encodes it. `BigtableAdapterOptionsBase` is the half both arms share
(`instance`, `tables`, `maxPageFetches`, `logQueries`). `tables` maps each entity name to a
`BigtableEntityMapping` — `{ table?, rowKey?, columnFamily?, columns?, valueEncoding? }`, whose
`rowKey` is a `BigtableRowKeyMapping` and whose `valueEncoding` is a `BigtableValueEncoding`; an
unmapped entity uses its own name as the table, `['id']` as the row-key fields, `'cf'` as the column
family and tagged values. `BigtableAdapter`'s constructor also takes an optional second parameter, a
`BigtableClientLoader`, which overrides the inject-or-lazy choice and whose `owned` flag decides
whether `disconnect()` closes the client it produced.

**The adapter provisions nothing and `connect()` issues no RPC.** Column families,
garbage-collection policies and split points belong to the application's provisioning, and a missing
table or instance is already reported by the service as `5 NOT_FOUND` quoting the full resource path
— while `instance.getTables()` is a table-ADMIN call a data-plane service account commonly cannot
make, so probing at connect time would refuse a working configuration. Configuration mistakes are
refused at construction instead, by name.

**The row key is composed from logical fields.** `BigtableRowKeyMapping` is
`{ fields, separator?, prefix? }`, defaulting to `{ fields: ['id'], separator: '#' }`. A
single-field key accepts a scalar `EntityKey`; a multi-field key requires a record naming every
field and refuses a scalar, which cannot say which field it is. A key field's **type is not part of
the row key** — a numeric field renders as its decimal text, so `1` and `'1'` are one physical row
and `findById('1')` answers the row stored under `1`, whose `id` cell still decodes as the number.
Choose one type per key field, and zero-pad a numeric one whose lexicographic order matters. A field
value **containing the separator is refused**: two different logical keys would otherwise compose to
one row key, so a write would silently overwrite an unrelated row. Composing a row key from several
fields is a _mapping_ concern rather than the composite-key _contract_ concern, which is why this
arm needs no `common` change — Bigtable's key shares no type with DynamoDB's partition/sort pair.

Key fields are written as ordinary cells AND recovered from the row key on read, with the **cells
winning**. All three parts are load-bearing: a Bigtable row cannot exist with zero cells; the row
key is bytes and records no type, so overlaying it would turn a numeric key field into a string; and
a table written outside this framework has no key cells at all, which is what the parse-back serves.

**Values are tagged by default.** `BigtableValueEncoding` is `'tagged' | 'raw'`. Tagged writes
`<tag>:<payload>`, so a number, boolean, `null`, `Date` or object round-trips as itself; a cell
carrying no recognised tag decodes as its raw string, which is the interop path. `'raw'` writes
`String(value)` and reads every cell as a string, removing that residual ambiguity for an
application whose table is entirely foreign.

**`orderBy` is the row key or nothing.** An empty sort is honoured, and so is one naming exactly the
mapped key fields, in order, all ascending — that IS the scan order. Everything else raises
`UnsupportedQueryFeatureError`: a non-key field has no index, and **descending is refused
deliberately** rather than shipped on `reversed: true`, because the emulator this adapter is tested
against silently ignores that option (measured: it answered ascending with no error), so the path
could not be verified. A non-zero `offset` is refused too — Bigtable has no row offset, and
discarding scanned rows would read and bill them; `findPage` is the route.

**Three narrowings reach the server, and nothing else.** The row set (an `eq` on every key field is
an exact key; an `eq` pinning a leading prefix is a prefix range with an exclusive successor end; a
pinned prefix plus an `in` on the final field is an explicit key list), byte-exact value equality
for each conjunctive non-key `eq`, and the column projection. Everything else is evaluated by the
same evaluator the memory adapter uses as the portable reference, so the six backends cannot drift
about what a `FilterExpression` means. The invariant is that **a push-down may only ever match a
superset** of what the client-side evaluator keeps; every fallback widens. Two details are
correctness requirements rather than tuning: a value test is an exact byte RANGE and never the SDK's
string form, which is a regex (measured, `{ value: 'a.*b' }` matched both `a.*b` and `axxb`); and it
is wrapped in a `condition` filter rather than chained, because a bare chain strips every
non-matching cell and the row would come back carrying only the cell that matched. An ordered
comparison on a key field is not pushed down either — the composed key is a string, so a numeric key
field does not sort numerically inside it. The projection is **interleaved with a one-cell arm**
rather than emitted bare: a filter that removes every cell of a row removes the row (the service
answers with no empty row), so a bare projection would silently drop a row carrying none of the
projected columns — unreachable for a row this adapter wrote, reachable for a table written
elsewhere. `count` reuses that projection, restricted to the columns its predicate needs.

**Pagination is a start-key cursor** over the portable keyset codec, which is exactly Bigtable's own
continuation mechanism. `nextCursor` is non-`null` if and only if the page is non-terminal, never
derived from `rows.length`: a client-side filter can empty a whole raw batch, so a page bounded by
`maxPageFetches` (default 10) returns zero rows AND a cursor, minted from the last row scanned.

**`rawQuery` is refused by name** with `UnsupportedRawQueryError`: Bigtable has no query language
behind `query(sql, params)` — its data plane is ReadRows, MutateRow and CheckAndMutateRow.

**Transactions are one row.** Bigtable's only atomicity unit is the single row (a multi-row batch is
atomic per entry, not as a whole), so `beginTransaction()` buffers writes, refuses a second row key
at the write that crosses the bound with `BigtableTransactionScopeError`, and commits the buffer as
ONE CheckAndMutateRow whose mutation list applies atomically and in order — a buffered delete
followed by writes replaces the row wholesale. `rollback()` discards, sends nothing, and is
idempotent. Reads inside a transaction observe committed state only. `create` and `update` are
conditional writes: Bigtable's `insert` is an upsert, so the CheckAndMutateRow match flag is what
makes `create` refuse an existing row and `update` refuse an absent one — including inside a
transaction, where a buffered `create` whose row turns out to exist is refused at commit.

**What the arm deliberately cannot do.** Platform limits: no secondary index of any kind, no row
offset, no multi-row atomicity, and no descending scan this adapter can verify. Contract limits:
grouping and joins are absent from `NormalizedQuery`, whose only aggregate is `count`; `rawQuery`
has no Bigtable surface; and cell versioning plus garbage-collection policies are outside the
portable contract by design — no other backend has a counterpart, so exposing them would invent a
concept for one adapter. An application needing any of them reaches the injected client.

`IBigtableClient` and the shapes it reaches (`IBigtableInstance`, `IBigtableTable`, `IBigtableRow`,
`BigtableReadOptions`, `BigtableReadRow`, `BigtableRowData`, `BigtableCell`, `BigtableRowRange`,
`BigtableRowBoundary`, `BigtableValueRange`, `BigtableFilter`, `BigtableMutation`) are the exported
injection seam, so an application implementing its own facade can name every signature.
`createInjectedBigtableLoader` and `createLazyBigtableLoader` build the two loader arms;
`BigtableClientConfiguration` is what the lazy one takes.

### Exports

| Export                                                                                                                                                                                                                                                                                                                  | Kind                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `DatabasePlugin`                                                                                                                                                                                                                                                                                                        | factory                            |
| `DatabaseService`                                                                                                                                                                                                                                                                                                       | class                              |
| `BaseRepository`, `UnitOfWork`                                                                                                                                                                                                                                                                                          | classes                            |
| `MemoryAdapter`, `PrismaAdapter`, `DrizzleAdapter`, `MongoAdapter`, `DynamoAdapter`                                                                                                                                                                                                                                     | classes                            |
| `PrismaRepository`, `DrizzleRepository`                                                                                                                                                                                                                                                                                 | classes                            |
| `UnsupportedFilterOperatorError`, `UnsupportedRawQueryError`, `UnsupportedQueryFeatureError`                                                                                                                                                                                                                            | classes                            |
| `PageOptions`, `Page`                                                                                                                                                                                                                                                                                                   | types                              |
| `PrismaCompositeKeyOptions`, `DrizzleCompositeKeyOptions`                                                                                                                                                                                                                                                               | types                              |
| `EntityKey`, `PageResult`, `CursorPayload`, `CursorValue` (re-exported from `common`)                                                                                                                                                                                                                                   | types                              |
| `encodeCursor`, `decodeCursor`, `keysetPredicate` (re-exported from `common`)                                                                                                                                                                                                                                           | functions                          |
| `MongoTransactionUnavailableError`                                                                                                                                                                                                                                                                                      | class                              |
| `CosmosAdapter`                                                                                                                                                                                                                                                                                                         | class                              |
| `CosmosTransactionScopeError`, `CosmosConcurrentModificationError`                                                                                                                                                                                                                                                      | classes                            |
| `CosmosDatabaseOptions`, `CosmosAdapterOptions`, `CosmosAdapterOptionsBase`, `CosmosEntityMapping`                                                                                                                                                                                                                      | types                              |
| `ICosmosClient`, `ICosmosDatabase`, `ICosmosContainer`, `ICosmosItems`, `ICosmosItem`, `ICosmosQueryIterator`                                                                                                                                                                                                           | interfaces (Cosmos injection seam) |
| `CosmosQuerySpec`, `CosmosQueryParameter`, `CosmosPartitionKeyValue`                                                                                                                                                                                                                                                    | types (Cosmos query seam)          |
| `CosmosItemResponse`, `CosmosFeedResponse`, `CosmosRequestOptions`, `CosmosAccessCondition`, `CosmosPatchOperation`, `CosmosBatchOperation`, `CosmosBatchInsertOperation`, `CosmosBatchReplaceOperation`, `CosmosBatchPatchOperation`, `CosmosBatchDeleteOperation`, `CosmosBatchResponse`, `CosmosContainerDefinition` | interfaces (Cosmos operation seam) |
| `PrismaSqlProvider`                                                                                                                                                                                                                                                                                                     | type                               |
| `SqlJsonDialect`                                                                                                                                                                                                                                                                                                        | type                               |
| `createPrismaDataSource`, `createDrizzleDataSource`, `createDrizzleDatabase`, `getDrizzleDatabase`, `getDrizzleTransaction`                                                                                                                                                                                             | functions                          |
| `DrizzleDatabase`, `DrizzleDatabaseIdentity`, `DrizzleTransaction`, `DrizzleTransactionBridge`                                                                                                                                                                                                                          | types                              |
| `IDatabaseService`, `IRepository`, `IUnitOfWork`                                                                                                                                                                                                                                                                        | interfaces                         |
| `DatabasePluginOptions`, `BuiltInDatabaseOptions`, `CustomDatabaseOptions`, `DatabaseConnectionOptions`                                                                                                                                                                                                                 | types                              |
| `MemoryDatabaseOptions`, `PrismaDatabaseOptions`, `DrizzleDatabaseOptions`, `MongoDatabaseOptions`, `DynamoDatabaseOptions`                                                                                                                                                                                             | interfaces                         |
| `MongoAdapterOptions` (union of two arms), `MongoAdapterOptionsBase`, `MongoEntityMapping`                                                                                                                                                                                                                              | types                              |
| `PrismaAdapterOptions`, `DrizzleAdapterOptions`                                                                                                                                                                                                                                                                         | interfaces                         |
| `DatabaseAdapterType`, `DatabaseAdapterOptions`                                                                                                                                                                                                                                                                         | types                              |
| `FindOptions`, `CountOptions`, `OrderDirection`, `FilterOperator`, `FilterComparison`, `FilterExpression`                                                                                                                                                                                                               | types                              |
| `IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`, `NormalizedQuery`                                                                                                                                                                                                                                             | re-exports from `common`           |
| `DataSource`                                                                                                                                                                                                                                                                                                            | deprecated alias of `IDataSource`  |
| `IMongoClient`, `IMongoDatabase`, `IMongoObjectId`, `IMongoObjectIdCtor`, `IMongoSession`                                                                                                                                                                                                                               | interfaces (Mongo injection seam)  |
| `IMongoCollection`, `IMongoCursor`, `IMongoCollectionFindOneAndUpdateOptions`, `MongoOptions`, `MongoWriteOptions`                                                                                                                                                                                                      | interfaces (Mongo collection seam) |
| `DynamoAdapterOptions` (union of two arms), `DynamoAdapterOptionsBase`, `DynamoEntityMapping`, `DynamoDateEncoding`, `DynamoIndexMapping`                                                                                                                                                                               | types                              |
| `IDynamoClient`, `DynamoAttributeValue`, `DynamoAttributeMap`, `DynamoExpressionAttributes`, `DynamoConditionExpression`, and the `Dynamo*CommandInput`/`Output`/`Transact*` command-shape closure                                                                                                                      | interfaces (DynamoDB client seam)  |
| `DynamoClientConfiguration`, `DynamoClientLoader`, `DynamoCommandConstructor`, `DynamoSdkClient`, `DynamoSdkCommand`, `DynamoSdkModule`                                                                                                                                                                                 | types (DynamoDB SDK seam)          |
| `createInjectedDynamoLoader`, `createLazyDynamoLoader`                                                                                                                                                                                                                                                                  | functions                          |

`DataSource` is retained under AI_GUIDELINES §9.2 — it is already published. It is now an alias of
the promoted `IDataSource` (the same type), and will be removed in the next major version.

`DatabaseAdapterType` gained `'custom'`, then `'mongodb'`, then `'dynamodb'`, then `'cosmos'`, then
`'bigtable'`; `DatabasePluginOptions` became a union discriminated on `type`. All are additive for
callers — every existing registration compiles unchanged. `MongoDatabaseOptions`,
`DynamoDatabaseOptions` and `CosmosDatabaseOptions` each extend `DatabaseConnectionOptions` and
carry their arm's dedicated option bag (`MongoAdapterOptions`, `DynamoAdapterOptions`,
`CosmosAdapterOptions`), as does `BigtableDatabaseOptions` with `BigtableAdapterOptions`, so a
registration carrying a memory, Prisma, Drizzle or custom configuration still compiles unchanged.

**Query refusals answer `501 Not Implemented` (M89b, X19-1).** The three query-shape errors —
`UnsupportedQueryFeatureError`, `UnsupportedFilterOperatorError` and `UnsupportedRawQueryError` —
carry an `HttpStatusHint` from `@setu-ts/common`, so `@setu-ts/exceptions`' `errorHandler` answers
them `501` with a caller-safe sentence naming the feature or operator and the adapter that refused
it. Each is a condition the CALLER caused — the query asks for something the active backend does not
implement, permanently — which is exactly what `501` states, and it is the shape a developer meets
when SWITCHING BACKENDS: before this, an application that worked on Mongo answered
`500 Internal Server Error` on every ordered endpoint under DynamoDB, and the response said the
server was broken.

The served `detail` is composed from this package's own structured fields (`feature`, `operator`,
`connector`, `adapter`), **never** from the error's `message` — which remains the full diagnostic,
is reachable only in the log, and is what `errorHandler` records. So the response gains a status and
a sentence without gaining a disclosure channel; a hinted error is exempt from `maskInternalErrors`
precisely because there is no driver output in its body to mask.

**Not every `UnsupportedQueryFeatureError` is branded, and that is deliberate.** The class is shared
by two kinds of refusal: a caller-caused query shape, and a **configuration** refusal. Only the
former is answered `501`; the latter keeps the masked `500` that is correct for an internal fault.
Branding the constructor unconditionally made a blank `columnFamily` — a value the developer wrote —
answer every request
`501 "Query feature 'mapping' is not supported by the 'bigtable' database
adapter."`, which is a lie
twice over. The split is an allowlist of `feature` values (`attribute-value`, `composite-key`,
`cursor-pagination`, `key`, `nested-path`, `offset`, `order-by`/`orderBy`, `row-key`, `update`);
`mapping`, `endpoint`, `date-encoding` and `transaction` are excluded, and **an unclassified value
is not branded** — so a feature name added later keeps its masked `500` until someone decides
otherwise.

The four transaction and concurrency errors — `MongoTransactionUnavailableError`,
`CosmosTransactionScopeError`, `CosmosConcurrentModificationError` and
`BigtableTransactionScopeError` — are deliberately **not** branded and keep their masked `500`: they
may legitimately quote backend state, and a concurrency conflict is transient and retryable rather
than permanent, which is a different contract statement deserving its own decision.

### Multiple Databases

```typescript
// Each named connection injects its own application-generated Prisma client;
// `options.url` is deprecated and unread — a v7 client carries its own
// connection configuration.
app.register(DatabasePlugin({
  type: 'prisma',
  name: 'primary',
  options: { prismaClient: primaryPrismaClient },
}));

app.register(DatabasePlugin({
  type: 'prisma',
  name: 'analytics',
  options: { prismaClient: analyticsPrismaClient },
}));

// Access by name
app.router.get('/analytics', async (ctx) => {
  const primaryDb = ctx.services.get<IDatabaseService>('database.primary');
  const analyticsDb = ctx.services.get<IDatabaseService>('database.analytics');
  // ...
});
```

---

## AuthPlugin() (`@setu-ts/auth-plugin`)

Provides JWT and API-key authentication, local credential verification, RBAC authorization with role
hierarchy, and short-circuiting route guards. All cryptography (HS256/RS256 JWT, PBKDF2-SHA256
password hashing) runs through Web Crypto via `IRuntimeServices`, so **no npm package is involved in
issuing or verifying a token, or in hashing a password**. The package declares one optional driver —
`RedisRateLimitStore` lazy-loads `ioredis` — which nothing imports unless that store is constructed.

Registers JWT and authentication services under existing capability tokens, plus authorization when
RBAC is configured:

- `IJwtService` under `CAPABILITIES.JWT` (`'jwt'`) — sign/verify/decode JWTs.
- `IAuthService` under `CAPABILITIES.AUTH` (`'authentication'`) — passive strategy chain + login.
- `IAuthorizationService` under `CAPABILITIES.AUTHORIZATION` (`'authorization'`) — RBAC checks, only
  when `rbac` is supplied.

`rbac` is optional. A JWT-only registration provides `jwt` and `authentication`; it deliberately
does not register an authorization service or advertise the authorization capability.

**What the guards then do (M89b, X18-2).** `requireAuth()` and `publicRoute()` resolve nothing and
are unaffected. The four authorization guards — `requireRole`, `requirePermission`, `requireAnyRole`
and `requireAllPermissions` — answer **`501 Not Implemented`** with
`Authorization is not configured`, short-circuiting before the handler. The status is `501` rather
than `403` because nothing is wrong with the caller: the deployment cannot evaluate the policy at
all, and the condition is permanent for that deployment. A principal that genuinely fails a policy
check still gets `403`; that path is unchanged. Before M89b these four resolved the capability
unconditionally, so the registry's throw escaped into the pipeline and the caller received a masked
`500 Internal Server Error` — a real fault with `/health`, `/ready` and `/live` all reporting `up`.
They still fail closed either way; what changed is that the refusal is legible.

> **Session authentication and caller-supplied strategies (M73):** `session` takes a
> `SessionAuthOptions` whose single required member, `toPrincipal(view)`, maps the opened
> `SessionView` to the principal it carries — returning `null` continues the chain. When present,
> the plugin appends an internal `SessionStrategy` after the API-key strategy and requires the
> `session` capability (`SessionPlugin`) to be registered, or `register()` throws naming both
> plugins. `strategies` accepts caller-supplied `IAuthStrategy`s, appended after every built-in in
> declaration order; a `name` colliding with any other strategy in the assembled chain throws at
> `register()`. The assembled order is fixed — **jwt → api-key → session → caller-supplied** — and
> the first non-null principal wins, so a request carrying both a bearer header and a session cookie
> authenticates by the JWT.
>
> **Phasing (M16b, shipped):** **refresh tokens** and **rate limiting** shipped in M16b as
> standalone additions — `RefreshTokenService` (app-instantiated; NOT an `IAuthStrategy`, since a
> refresh token arrives in the request body, not as a passive header credential) and
> `rateLimitMiddleware` (a decoupled middleware factory with no capability token). Neither is an
> `AuthPlugin` option: the plugin's option shape, `provides`, and registration are unchanged from
> M16. `IJwtService` still exposes only `sign`/`verify`/`decode` — a refresh token is a signed JWT
> carrying `type: 'refresh'` and a `jti`.

### Exports

| Export                       | File                                      | Description                                                                             |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `AuthPlugin`                 | `src/plugin/auth-plugin.ts`               | Plugin factory                                                                          |
| `AuthPluginOptions`          | `src/interfaces/index.ts`                 | Plugin factory options (`jwt` / `apiKey` / `local` / `rbac` / `session` / `strategies`) |
| `JwtOptions`                 | `src/interfaces/index.ts`                 | JWT config (key material, algorithm, expected aud/iss, header/scheme)                   |
| `ApiKeyOptions`              | `src/interfaces/index.ts`                 | API-key strategy config (header + `validate` callback)                                  |
| `LocalOptions`               | `src/interfaces/index.ts`                 | Local credential config (`verify` callback)                                             |
| `SessionAuthOptions`         | `src/interfaces/index.ts`                 | Session strategy config (required `toPrincipal` callback)                               |
| `PasswordHasher`             | `src/services/password-hasher.ts`         | PBKDF2-SHA256 hash/verify utility                                                       |
| `MalformedPasswordHashError` | `src/services/password-hasher.ts`         | Thrown by `PasswordHasher.verify` when `stored` is not a well-formed hash               |
| `authMiddleware`             | `src/middleware/auth-middleware.ts`       | Global middleware: authenticates and populates `ctx.request.user`                       |
| `requireAuth`                | `src/guards/index.ts`                     | Guard: require an authenticated principal (401)                                         |
| `requireRole`                | `src/guards/index.ts`                     | Guard: require a role (401/403)                                                         |
| `requirePermission`          | `src/guards/index.ts`                     | Guard: require a permission (401/403)                                                   |
| `requireAnyRole`             | `src/guards/index.ts`                     | Guard: require any of the given roles                                                   |
| `requireAllPermissions`      | `src/guards/index.ts`                     | Guard: require all of the given permissions                                             |
| `publicRoute`                | `src/guards/index.ts`                     | Guard: explicitly allow unauthenticated access                                          |
| `RefreshTokenService`        | `src/services/refresh-token-service.ts`   | Refresh tokens: `issue` / `refresh` (rotation) / `revoke`                               |
| `RefreshTokenOptions`        | `src/services/refresh-token-service.ts`   | `RefreshTokenService` constructor options                                               |
| `TokenPair`                  | `src/services/refresh-token-service.ts`   | `{ accessToken, refreshToken }` returned by `issue`/`refresh`                           |
| `RefreshTokenStore`          | `src/stores/refresh-token-store.ts`       | Pluggable async store interface for refresh-token records                               |
| `RefreshTokenRecord`         | `src/stores/refresh-token-store.ts`       | Record shape store implementations produce/consume                                      |
| `MemoryRefreshTokenStore`    | `src/stores/refresh-token-store.ts`       | Default in-memory store with lazy expiry                                                |
| `rateLimitMiddleware`        | `src/middleware/rate-limit-middleware.ts` | Fixed-window rate limiter middleware factory (429 short-circuit)                        |
| `RateLimitOptions`           | `src/middleware/rate-limit-middleware.ts` | `rateLimitMiddleware(options)` parameter                                                |
| `RateLimitStore`             | `src/stores/rate-limit-store.ts`          | Pluggable store interface (`increment`/`reset`)                                         |
| `RateLimitResult`            | `src/stores/rate-limit-store.ts`          | `{ count, resetTime }` returned by `increment`                                          |
| `MemoryRateLimitStore`       | `src/stores/rate-limit-store.ts`          | Default in-memory fixed-window store                                                    |
| `RedisRateLimitStore`        | `src/stores/redis-rate-limit-store.ts`    | Redis-backed store (inject-or-lazy `npm:ioredis@5.x`)                                   |
| `IAuthService`               | re-export                                 | From `@setu-ts/common`                                                                  |
| `IJwtService`                | re-export                                 | From `@setu-ts/common`                                                                  |
| `IAuthorizationService`      | re-export                                 | From `@setu-ts/common`                                                                  |
| `IAuthStrategy`              | re-export                                 | From `@setu-ts/common`                                                                  |
| `IPrincipal`                 | re-export                                 | From `@setu-ts/common`                                                                  |
| `JwtSignOptions`             | re-export                                 | From `@setu-ts/common`                                                                  |
| `RbacConfig`                 | re-export                                 | From `@setu-ts/common`                                                                  |
| `RoleDefinition`             | re-export                                 | From `@setu-ts/common`                                                                  |

### Registration

```typescript
import { authMiddleware, AuthPlugin } from '@setu-ts/auth-plugin';

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
// The priority is explicit and deliberate: the §10 table in ARCHITECTURE.md
// reserves 300 for authentication, but a bare add() takes the kernel's default
// of 500 — AFTER every band in that table, including the row named for it.
app.middleware.add(authMiddleware(), { priority: 300 });
```

### Login (Issue Token)

`IAuthService.verifyCredentials({ identifier, secret })` resolves to an `IPrincipal | null`; mint a
JWT with the separate `IJwtService` resolved from `'jwt'` (or issue an access + refresh pair with
`RefreshTokenService` — see Refresh Tokens below).

```typescript
import type { IAuthService, IJwtService } from '@setu-ts/common';

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
import { MemoryRefreshTokenStore, RefreshTokenService } from '@setu-ts/auth-plugin';
import type { IJwtService, IRuntimeServices } from '@setu-ts/common';

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
import { rateLimitMiddleware, RedisRateLimitStore } from '@setu-ts/auth-plugin';

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
} from '@setu-ts/auth-plugin';

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
— so the shipped `CurrentUser()` parameter source resolves it).

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
import { PasswordHasher } from '@setu-ts/auth-plugin';

const hasher = new PasswordHasher(runtime); // IRuntimeServices resolved from the 'runtime' token
const stored = await hasher.hash('correct horse battery staple');
const ok = await hasher.verify(stored, 'correct horse battery staple'); // true
```

`verify(stored, secret)` **throws** the exported `MalformedPasswordHashError` when `stored` is not a
well-formed `pbkdf2$…` string, instead of returning `false`. The two parameters are both plain
`string`s, so a reversed call — password in the `stored` position — used to fail closed and
silently: every correct password answered `401 Invalid credentials` with nothing logged. The
malformed branch detects exactly that mistake and names both positions; a genuinely wrong password
still returns `false`.

---

## HttpSecurityPlugin() (`@setu-ts/http-security-plugin`)

Provides HTTP transport security as a middleware-only plugin: CORS, security response headers, CSRF
(stateless Origin/Referer validation), request-size limiting, and IP resolution. Registers **no
capability token** and **no service** — each concern is registered as global middleware via
`ctx.middleware.add(...)` and also exported as a standalone factory for per-route use.

**Defaults:** Security headers are ON by default; CORS, CSRF, request-size, and IP-security are
opt-in via their option blocks. Each concern is secure-by-default when enabled.

### Registration

```typescript
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';

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
`Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and (when configured)
`Access-Control-Max-Age`. Credentials reflect specific origin (never `*`). Non-preflight disallowed
origins call `next()` without CORS headers (browser enforces block).

`Access-Control-Allow-Headers` follows `allowedHeaders`, and omitting it is NOT the same as passing
`[]`. Omitted, an allowed origin's preflight is answered by **echoing** that request's own
`Access-Control-Request-Headers`, and the response also carries
`Vary: Access-Control-Request-Headers` — mandatory rather than cosmetic, since the answer now
depends on a request header and a shared cache would otherwise serve one caller's preflight to a
caller asking for different headers. An explicit list allows exactly those headers; an explicit `[]`
allows none. A denied origin echoes nothing. Echoing is the default because the previous empty-list
default advertised every standard method and then refused `content-type`, so every browser blocked
every JSON request; it does not widen the boundary, which the `origin` allowlist alone decides.

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

Resolves client IP and publishes to `ctx.state.set(CLIENT_IP_STATE_KEY, ip)`. When
`trustProxy: true`, reads the configured `ipHeader` (default `X-Forwarded-For`) and takes the
leftmost address. Never short-circuits.

**`trustProxy` is the only working source on the first-party adapters.** The fallback to
`request.ip` is vestigial since M23: a web `Request` carries no peer address, so the shared `fetch`
mapping cannot populate `IRequest.ip` and `clientIp` is `undefined` unless the proxy header is
present. The fallback is retained for a custom `IHttpAdapter` that does set it.

---

## CachePlugin() (`@setu-ts/cache-plugin`)

Provides caching with multiple stores (Memory, Redis, Noop) and a transparent response-caching
middleware.

Registers `ICacheStore` under `CAPABILITIES.CACHE`.

### Exports

| Export                   | File                                 | Description                             |
| ------------------------ | ------------------------------------ | --------------------------------------- |
| `CachePlugin`            | `src/plugin/cache-plugin.ts`         | Plugin factory                          |
| `CacheService`           | `src/services/cache-service.ts`      | Wrapper applying prefix + defaultTTL    |
| `MemoryStore`            | `src/stores/memory-store.ts`         | In-memory LRU + TTL store               |
| `RedisStore`             | `src/stores/redis-store.ts`          | Redis store via ioredis                 |
| `NoopStore`              | `src/stores/noop-store.ts`           | No-op store (dev/test)                  |
| `cacheMiddleware`        | `src/middleware/cache-middleware.ts` | Transparent response-caching middleware |
| `CacheStoreType`         | `src/interfaces/index.ts`            | `'memory' \| 'redis' \| 'noop'`         |
| `CacheStoreOptions`      | `src/interfaces/index.ts`            | Store-specific options                  |
| `CachePluginOptions`     | `src/interfaces/index.ts`            | Plugin factory options                  |
| `IRedisClient`           | `src/interfaces/index.ts`            | Structural ioredis shape                |
| `CacheMiddlewareOptions` | `src/interfaces/index.ts`            | Middleware options                      |
| `CachedResponsePayload`  | `src/interfaces/index.ts`            | Cached response shape                   |
| `ICacheStore`            | `src/interfaces/index.ts`            | Re-export from `@setu-ts/common`        |

### Registration

```typescript
import { CachePlugin } from '@setu-ts/cache-plugin';

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
import type { ICacheStore } from '@setu-ts/common';

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
import { cacheMiddleware } from '@setu-ts/cache-plugin';

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

#### Options

| Option              | Type                         | Default              | Behavior                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttlSeconds`        | `number`                     | store default        | Per-route TTL override in seconds; when omitted the store's `defaultTtl` applies                                                                                                                                                          |
| `key`               | `(ctx) => string`            | `${method}:${url}`   | Custom cache key generator. The tenant discriminator segment is composed around this key too, so a tenant-aware application stores one entry per tenant even when a custom key is supplied                                                |
| `vary`              | `(ctx) => readonly string[]` | —                    | Per-request discriminator values appended to the key after the tenant segment. Each returned string is length-prefixed and joined in order, so two requests differing in any value never share an entry; omitted leaves the key unchanged |
| `bypass`            | `(ctx) => boolean`           | —                    | When `true`, skip caching entirely for this request and pass through to the handler                                                                                                                                                       |
| `store`             | `string`                     | `CAPABILITIES.CACHE` | Capability token for the cache store to use                                                                                                                                                                                               |
| `cacheableStatuses` | `number[]`                   | `[200]`              | HTTP status codes eligible for caching                                                                                                                                                                                                    |

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

## EventsPlugin() (`@setu-ts/events-plugin`)

Provides in-memory event bus for domain events.

### Registration

```typescript
import { EventsPlugin } from '@setu-ts/events-plugin';

app.register(EventsPlugin({
  async: true,
  errorHandler: (error, event) => {
    const logger = ctx.services.get('logger');
    logger.error('Event handler failed', { error, eventType: event.type });
  },
}));
```

Handlers can also be subscribed declaratively, which is what `setu generate event-handler` wires for
you. Each entry is a `{ type, handler }` pair, and the plugin subscribes it through the same
`subscribeHandler` you would call by hand — so the two routes cannot diverge:

```typescript
import type { EventHandlerRegistration } from '@setu-ts/events-plugin';

const handlers: readonly EventHandlerRegistration[] = [
  { type: 'user-created', handler: new UserCreatedEventHandler() },
  // Or a factory that builds the handler from the service registry:
  { type: 'order-placed', handler: createOrderPlacedEventHandler },
];

app.register(EventsPlugin({ handlers }));
```

The `handler` accepts an instance or a `RegistryFactory`
(`(services: IServiceRegistry) =>
handler`). A factory is called at the `onInit` phase — the first
phase at which the registry holds every capability — so it can resolve any capability (the broker,
the queue, the logger) and build the handler with it; the result subscribes through the same
`subscribeHandler` the instance arm uses, so the two arms cannot diverge. A factory that throws
rejects `start()`, naming the option and the entry. Instance handlers keep their `register()` timing
byte-identically. The imperative `subscribeHandler` remains available for a handler wired from
another plugin's own `register`.

### Defining Events

```typescript
import { DomainEvent } from '@setu-ts/events-plugin';

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
  given dispatch options (`async`, `errorHandler`) and subscribes any `handlers` supplied.
- **`EventHandlerRegistration`** — One `{ type, handler }` pair for the `handlers` option. Exported
  because that option is typed as an array of it, so without it a caller could not declare its own
  array in a variable.
- **`InMemoryEventBus`** — In-memory publish/subscribe event bus implementing `IEventBus`.
- **`DomainEvent`** — Base class for domain events, generated by `defineDomainEvent`.
- **`IntegrationEvent`** — Semantic subclass of `DomainEvent` for integration events (no additional
  fields).
- **`defineDomainEvent`** — Factory that binds `DomainEvent` and `IntegrationEvent` to a runtime,
  returning event IDs and timestamps from the runtime's `uuid` and `now` services.
- **`IEventHandler`** — Class-based event handler interface with a `handle(event)` method.
- **`subscribeHandler`** — Function that adapts an `IEventHandler` instance to the `EventHandler`
  signature and subscribes it to the bus; returns an `Unsubscribe` function.

**Re-exports from `@setu-ts/common`:** `IEventBus`, `IDomainEvent`, `EventHandler`, `Unsubscribe`.

---

## SsePlugin() (`@setu-ts/sse-plugin`)

Provides Server-Sent Events (SSE) for real-time, one-way server-to-client messaging over
`text/event-stream`. Built on the Milestone 42 `IResponse.stream()` primitive and
`IRequestContext.signal` abort lifecycle.

### Registration

```typescript
import { SsePlugin } from '@setu-ts/sse-plugin';

app.register(SsePlugin({
  heartbeatMs: 15000,
  retryMs: 3000,
}));
```

### Usage

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ISseService } from '@setu-ts/common';

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
- `ISseService.channel(name): SseChannel` — get-or-create a named broadcast channel. First call
  creates, so reading `size` for a caller-supplied name is a write, and **nothing reclaims a channel
  before shutdown** — the registry has no removal path outside the one that runs when the
  application stops.
- `ISseService.peek(name): SseChannel | undefined` — the non-allocating counterpart. Returns the
  channel when one exists and `undefined` otherwise, registering nothing. Use it wherever the name
  comes from a request. Added in M74; a **required** member, so a replacement implementation of
  `ISseService` must supply it.
- `ISseService.connectionCount: number` — current open connections.
- `ISseService.channelCount: number` — channels the registry currently holds; the counterpart to
  `IWebSocketService.roomCount`, reported by the `sse` health indicator as `channels`. Nothing
  reclaims a channel, so the value **only rises for the life of a running application** and a
  steadily climbing one is the operator-visible signal that channel names are being derived from
  unbounded input. Shutdown is the sole exception: `onClose` discards every channel, so a probe
  racing teardown reads `0`. Added in M74; a **required** member, like `peek`.
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
| `ISseConnection`, `ISseService`, `SseChannel`, `SseMessage` | type (re-export)  | From `@setu-ts/common`                                              |
| `CAPABILITIES`                                              | const (re-export) | From `@setu-ts/common`                                              |

### Notes

- Built entirely on web-standard `ReadableStream`; no platform-specific server socket APIs.
- **Channels are in-process until a backplane is registered.** Register
  [`RealtimeBackplanePlugin`](#realtimebackplaneplugin-setu-tsrealtime-backplane-plugin) and every
  `publish` also reaches members on other replicas; with no `CAPABILITIES.REALTIME_BACKPLANE`
  provider the behavior is unchanged. `SseChannel.size` keeps reporting **local** membership either
  way.
- **`SseMessage.data` is `JsonValue`** — a recursive JSON-safe type exported from `@setu-ts/common`.
  Until M74 the union was
  `string | number | boolean | null | readonly unknown[] |
  Record<string, unknown>`, whose last
  two arms admitted values `JSON.stringify` cannot represent, so this section's own claim that the
  member "accepts any JSON-serializable value" was an aspiration rather than a guarantee. It is now
  enforced: a `bigint` (which throws) and a function or symbol value (which is silently dropped) are
  compile errors. A property written `T | undefined` still assigns, because `JSON.stringify` drops
  the key. Three limits remain and no type can close them: a **circular structure** throws at
  runtime; `NaN`, `Infinity` and `-Infinity` are members of `number` that JSON cannot represent, so
  `JSON.stringify` normalizes each to `null` and the value reaches the wire silently changed rather
  than refused (send it as a string when the distinction matters); and a named `interface` does not
  assign — TypeScript grants implicit index signatures only to object-literal types, which was true
  before the M70n widening and after it, so declare the payload with a `type` alias or extend
  `Record<string, JsonValue | undefined>`. What M70n's widening actually bought was arrays,
  primitives and `null`. `SseChannelImpl.publishLocal` is the local-only delivery path the backplane
  subscriber uses; applications call `publish`.
- Cloudflare Workers and other edge platforms bound long-lived connections by their own limits — the
  plugin opens the stream the same way everywhere, but the platform may truncate the connection.
- The `inject()` method cannot read a streaming body and throws when it meets one; SSE integration
  tests must use a real socket (`app.start({ port })` + `fetch()`).

---

## WebSocketPlugin() (`@setu-ts/websocket-plugin`)

Provides full-duplex, bidirectional real-time messaging, completing the real-time story that
`SsePlugin` covers one-way. Registers an `IWebSocketService` under `CAPABILITIES.WEBSOCKET`. Added
in Milestone 46.

The RFC 6455 handshake is performed by the runtime's HTTP adapter through the optional
`IHttpAdapter.setUpgradeRouter` seam, so the same application code runs on Node, Deno, Bun, and
Cloudflare Workers. The plugin never creates a server and never touches a runtime API.

Since M70a **the middleware pipeline runs before the handshake**. The adapter stores the router; the
kernel terminal handler consults `IWebSocketService.routeUpgrade` after the pipeline has run without
short-circuiting — and **before** route matching, so an application catch-all such as the SSR one
`ReactRouterPlugin` mounts cannot shadow the upgrade. A guard that answers `401` therefore refuses
the upgrade, metrics apply, and a draining application answers `503` — none of which happened
before, which was the security defect M70a closed. On an **accepted** upgrade the adapter answers
with the runtime's own `101`, which does not carry response headers a middleware set on
`ctx.response` (security headers, `Set-Cookie`); a refused upgrade is an ordinary HTTP response and
carries them all. Upgrade **detection** (the RFC 6455 header check) lives in the service's own
router, inside its error-reporting wrapper, because `WsRouteTable` matches on path alone and a
routing failure has no other place to be logged. A non-conformant upgrade carrying a body is refused
`400` by the kernel before any handshake is attempted, so the behaviour is one thing on all four
adapters instead of a runtime-specific failure inside the upgrade call.

Since M73 the pipeline's authenticated principal rides the upgrade: the kernel passes
`ctx.request.user` to `IWebSocketService.routeUpgrade`, and `onOpen`'s `WebSocketConnectionContext`
carries it as the optional `user` member — populated when a strategy authenticated the upgrade,
omitted when it did not. An unauthenticated upgrade is anonymous, and a guard in the authentication
band refuses it before the handshake. See the `session` arm of
[`AuthPlugin`](#authplugin-setu-tsauth-plugin) for the cookie-backed strategy that produces it.

### Registration

```typescript
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

app.register(WebSocketPlugin({
  maxConnections: 10_000,
  heartbeatMs: 30_000,
  heartbeatPayload: 'ping',
  idleTimeoutMs: 90_000,
  maxMessageBytes: 1_048_576,
}));
```

### Options

| Option             | Type                                                                 | Default  | Behavior                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConnections`   | `number`                                                             | `0`      | Simultaneous open connections across all routes; `0` is unlimited. At the limit, upgrades get HTTP 503.                                                                                                                                                                                                          |
| `heartbeatMs`      | `number`                                                             | `0`      | Heartbeat interval; `0` disables it and creates no timer.                                                                                                                                                                                                                                                        |
| `heartbeatPayload` | `string`                                                             | `'ping'` | The text frame sent each tick. Read only when `heartbeatMs > 0`.                                                                                                                                                                                                                                                 |
| `idleTimeoutMs`    | `number`                                                             | `0`      | Inbound silence after which a connection is closed with `1001`; `0` disables. Requires `heartbeatMs > 0` — otherwise `WebSocketPlugin()` throws, so the option can never be silently inert.                                                                                                                      |
| `maxMessageBytes`  | `number`                                                             | `0`      | Largest inbound frame; `0` is unlimited. A larger frame closes with `1009` and never reaches `onMessage`.                                                                                                                                                                                                        |
| `scalingNotice`    | `boolean`                                                            | `true`   | Logs one `info` line at registration when no realtime backplane is registered, stating that rooms broadcast in-process only. `false` silences the message; room delivery is unaffected.                                                                                                                          |
| `routes`           | `readonly WebSocketRouteEntry[]`                                     | —        | Declarative exact-path `route()` registrations. An entry is a `WebSocketRouteDefinition` (`{ path, handlers, options? }`) or a `RegistryFactory` resolved at `onInit`.                                                                                                                                           |
| `behaviors`        | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —        | Plugin-level chain around every route's `onMessage`. It sees `kind: 'websocket'`, the route path, and the frame; a configured chain returns a promise while preserving immediate execution for synchronous behaviours; a deferred `next()` delays the handler. No behaviours keep the direct synchronous invoke. |

`WebSocketRouteOptions.guards` is route-scoped: matching-route guards run before the handshake in
declared order, and the first non-`true` decision refuses. It is distinct from plugin-level frame
`behaviors`; no route-level behaviour arm exists.

### Usage

```typescript
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';

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

#### Route options

| Option      | Type                | Default | Purpose                                                                                                                 |
| ----------- | ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `protocols` | `readonly string[]` | omitted | Subprotocol allow-list; the first client match is echoed back                                                           |
| `heartbeat` | `boolean`           | `true`  | `false` excludes this route's connections from the shared heartbeat sweep — both the payload send AND the idle eviction |

> Set `heartbeat: false` when the route speaks its own liveness protocol. The sweeper sends
> `heartbeatPayload` as a raw text frame to every connection on every route, which a protocol client
> (a `graphql-transport-ws` peer, for instance) must treat as an invalid message; and it evicts on
> inbound silence, which is the normal state of a listen-only subscriber. The GraphQL plugin's
> WebSocket route claims this opt-out.

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
  kernel's matcher is internal to `@setu-ts/kernel` and hand-rolling a second one would duplicate
  logic.
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
- **`room(name)` is get-or-create; `peek(name)` is the read that is not.**
  `room(callerSupplied).size` creates a room per distinct name polled, and the registry reclaims
  never-joined rooms only on the next disconnection somewhere in this process — an idle application
  never does. `IWebSocketService.peek(name): WebSocketRoom | undefined` returns the room when one
  exists and `undefined` otherwise, registering nothing, and is what a presence or dashboard
  endpoint reading a request-supplied name should call. Added in M74; a **required** member, so a
  replacement implementation of `IWebSocketService` must supply it.
- **Rooms are in-process until a backplane is registered.** Register
  [`RealtimeBackplanePlugin`](#realtimebackplaneplugin-setu-tsrealtime-backplane-plugin) and every
  `broadcast` also reaches members on other replicas; with no `CAPABILITIES.REALTIME_BACKPLANE`
  provider the behavior is unchanged. `RoomBroadcastOptions.except` is honored on **every** replica:
  connection IDs come from `runtime.uuid()` and are globally unique, so the frame carries the
  excluded ID. `Room.size` keeps reporting **local** membership either way. `Room.broadcastLocal` is
  the local-only delivery path the backplane subscriber uses (its `LocalBroadcastOptions` adds
  `exceptId`); applications call `broadcast`.
- A `RoomRegistry` keeps a reverse `connection → rooms` index, so evicting a disconnecting peer
  costs only the rooms that peer had actually joined rather than a scan of every live room. The
  index is maintained through the `RoomMembershipListener` the registry gives each `Room` it
  creates; a standalone `new Room(name)` takes no listener and is not tracked.
- **A failing upgrade router is logged, then refused with `500`.** The service catches its own
  routing errors and reports them through the logger capability when one is registered — the HTTP
  adapter's `UpgradeRouterStore` backstop runs inside `@setu-ts/runtime`, which has no logger, so
  the cause would otherwise be lost. Register the LoggerPlugin to see it.
- **`app.inject()` cannot exercise a WebSocket**; tests must bind a real socket
  (`app.start({ port })` + `new WebSocket(...)`).
- A `websocket` health indicator reports `{ available, connections, rooms, routes }`. `onClose`
  closes every live connection with code `1001` and stops the heartbeat.

---

## RealtimeBackplanePlugin() (`@setu-ts/realtime-backplane-plugin`)

Provides cross-replica fan-out for WebSocket rooms and SSE channels. Registers an
`IRealtimeBackplane` under `CAPABILITIES.REALTIME_BACKPLANE` (`'realtime-backplane'`). Added in
Milestone 47.

Rooms and channels hold membership in in-process sets, so behind a load balancer a broadcast reaches
only the clients connected to the replica that issued it. `WebSocketPlugin` and `SsePlugin` resolve
this token **optionally**, so registering this plugin is the entire change; removing it restores
in-process behavior with no application code touched.

### Registration

```typescript
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

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

| Option                  | Applies to       | Default                  | Description                                                                                                                                                                                                                                 |
| ----------------------- | ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`             | all              | `'memory'`               | `'memory' \| 'messaging' \| 'redis' \| 'custom'`                                                                                                                                                                                            |
| `topic`                 | all but `memory` | `'setu-ts.realtime'`     | Broker topic / Redis channel. Every replica must agree on it                                                                                                                                                                                |
| `origin`                | all              | a fresh `runtime.uuid()` | This replica's identity. Override only to make a test deterministic                                                                                                                                                                         |
| `bus`                   | `'memory'`       | `'default'`              | Named in-process bus; separate names stay isolated                                                                                                                                                                                          |
| `url`                   | `'redis'`        | —                        | Connection URL, read only on the lazy `npm:ioredis@5.x` path                                                                                                                                                                                |
| `client` / `subscriber` | `'redis'`        | —                        | Injected client pair. **Required together** — see Notes                                                                                                                                                                                     |
| `module`                | `'redis'`        | —                        | An `ioredis`-shaped module, for testing without the real driver                                                                                                                                                                             |
| `instance`              | `'custom'`       | —                        | The `IRealtimeBackplane` to register, used as-is                                                                                                                                                                                            |
| `localNotice`           | `'memory'`       | `true`                   | Logs one `info` line at `register()` when the resolved transport is the process-local `'memory'`, naming `'redis'`/`'messaging'` as the cross-process choices. `false` suppresses it, matching the consumers' `scalingNotice` opt-out shape |

Registering the plugin **bare** is not a scaling fix: the default `'memory'` transport is a real bus
but a single-process one, and before the `localNotice` existed a bare registration also silenced the
consumers' startup notices without fanning anything out. The notice now comes from the plugin that
knows its own transport.

### Transports

| `transport`   | Crosses processes | Dependencies                   | Notes                                                          |
| ------------- | ----------------- | ------------------------------ | -------------------------------------------------------------- |
| `'memory'`    | No                | None                           | The default, and a real single-process bus rather than a no-op |
| `'messaging'` | Yes               | A plugin providing `messaging` | Reuses any registered messaging broker; adds no dependency     |
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
| `DEFAULT_TOPIC`                                                                                      | const             | `'setu-ts.realtime'`                                          |
| `IRedisBackplaneClient`                                                                              | interface         | Structural facade for an injected Redis client                |
| `IRedisModule`                                                                                       | interface         | Structural facade for the `ioredis` module                    |
| `RealtimeBackplanePluginOptions`                                                                     | type              | Discriminated union of the four transport arms                |
| `BackplaneCommonOptions`                                                                             | interface         | `topic` and `origin`, shared by every arm                     |
| `MemoryBackplaneOptions`                                                                             | interface         | The `'memory'` arm                                            |
| `MessagingBackplaneOptions`                                                                          | interface         | The `'messaging'` arm                                         |
| `RedisBackplaneOptions`                                                                              | interface         | The `'redis'` arm                                             |
| `CustomBackplaneOptions`                                                                             | interface         | The `'custom'` arm                                            |
| `IRealtimeBackplane`, `RealtimeFrame`, `RealtimeFrameHandler`, `RealtimeFrameKind`, `EncodedPayload` | type (re-export)  | From `@setu-ts/common`                                        |
| `encodeFrameData`, `decodeFrameData`, `CAPABILITIES`                                                 | value (re-export) | From `@setu-ts/common`                                        |

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
  `decodeFrameData`, in `@setu-ts/common` because three packages need the identical shape). An
  `SseMessage` is already JSON-serializable and travels as its JSON encoding.
- **Delivery is at-most-once** and inherits the transport's guarantees. Frames are not persisted or
  replayed. On `'redis'` a SHORT partition buffers rather than drops: ioredis's default
  `enableOfflineQueue: true` holds publishes issued while disconnected and flushes them on
  reconnect, so frames arrive LATE (measured ~6 s) until the `maxRetriesPerRequest` budget (default
  20, ~11 s) exhausts and the buffered commands reject with a `warn` per frame. Neither ioredis
  default is configurable through this plugin; inject a `client`/`subscriber` pair to change it.
- **`RoomBroadcastOptions.except` is honored cluster-wide.** It names a live connection object,
  which means nothing in another process — but connection IDs come from `runtime.uuid()` and are
  therefore globally unique, so `RealtimeFrame.exceptId` carries the ID and every replica skips the
  matching member. Excluding a peer connected to a _different_ replica works for the same reason.
- **`Room.size` / `SseChannel.size` remain local.** A cluster-wide count is inherently asynchronous
  (a scatter-gather across replicas), so it cannot satisfy the synchronous committed `size` getter;
  exposing one is a contract decision — a separate async method — that a later milestone owns.

---

### Health status

Since M70c the indicator probes the transport's reachability (`isHealthy()`). A fan-out failure is
`degraded` — local delivery still works, so `/ready` keeps serving — never `down`. A transport that
cannot probe reports `up` with `reachable: 'unknown'`.

| Status     | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `up`       | The transport is reachable, or cannot be probed (`reachable` is `'unknown'`).           |
| `degraded` | The transport is unreachable — a fan-out to a peer failed (local delivery still works). |

`data` reports `{ transport, origin, reachable }`, where `reachable` is `true`, `false`, or
`'unknown'`.

## SessionPlugin() (`@setu-ts/session-plugin`)

Cookie-backed sessions and session-backed form CSRF. Registers a `SessionService`
(`ISessionService`) under `CAPABILITIES.SESSION` (`'session'`). Added in Milestone 48.

The default is a self-contained **encrypted** cookie: AES-256-GCM under a key derived by
HKDF-SHA256, entirely through `IRuntimeServices.subtle` (the Milestone 16 `JwtService` precedent),
so the package has zero npm dependencies and works on Cloudflare Workers. Setting `store` moves the
payload server-side and leaves only an opaque id in the cookie, which is what makes immediate
revocation possible.

```typescript
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';

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
| `cookie.name`        | `string`                               | `setu_session`             | Renamed from `hono_session` — see the CHANGELOG migration note; pin the old name to preserve in-flight sessions                                                                                        |
| `cookie.path`        | `string`                               | `'/'`                      |                                                                                                                                                                                                        |
| `cookie.domain`      | `string`                               | —                          | Omitted produces a host-only cookie                                                                                                                                                                    |
| `cookie.sameSite`    | `'strict' \| 'lax' \| 'none'`          | `'lax'`                    | `'none'` forces `Secure`                                                                                                                                                                               |
| `cookie.secure`      | `boolean`                              | `true`                     | Escape hatch for plain-HTTP local development                                                                                                                                                          |
| `cookie.httpOnly`    | `boolean`                              | `true`                     |                                                                                                                                                                                                        |
| `csrf`               | `CsrfFormOptions`                      | —                          | Presence registers `csrfFormMiddleware` at priority 275                                                                                                                                                |
| `csrf.fieldName`     | `string`                               | `'_csrf'`                  | Form field carrying the token                                                                                                                                                                          |
| `csrf.headerName`    | `string`                               | `'x-csrf-token'`           | Header accepted as an alternative token source for `fetch` posts; an explicit name still wins. REQUIRED for `multipart/form-data`, which is not parsed for the field                                   |
| `csrf.ignoreMethods` | `readonly string[]`                    | `['GET','HEAD','OPTIONS']` | Methods that skip verification                                                                                                                                                                         |
| `csrf.exclude`       | `readonly (string \| RegExp)[]`        | —                          | Exact paths or regular expressions that skip form CSRF. Use only for a separately-mounted non-browser protocol surface; application form paths must remain protected.                                  |
| `tenantBinding`      | `boolean`                              | `true`                     | Seals the resolved tenant id into the session on commit; replaying it under a different tenant is refused with `403` before the handler. Inert when either side has no tenant; `false` disables both   |

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

- **`ISessionService.fromHeaders(headers)` is the headers-only read for non-HTTP entry points.** It
  opens the session from a `Headers` object alone — a WebSocket `onOpen` handler, an auth strategy
  reading a cookie — and returns a read-only `SessionView` (`{ id, data }`) or `null`. It runs the
  same envelope-open, snapshot-parse, and store-read path as the load behind `from(ctx)`, so it
  inherits real revocation on the store strategy, but it never commits, never advances the `seen`
  stamp, and never writes. It is a **required** member: an application that implements
  `ISessionService` itself must add it (see the CHANGELOG migration note).
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

## ReactRouterPlugin() (`@setu-ts/react-router-plugin`)

Embeds **React Router v7 framework mode** as a first-party plugin so a Setu-TS application can serve
a React frontend with Server-Side Rendering (SSR) and file-based routing. React Router's
framework-mode `createRequestHandler` is mounted behind a kernel catch-all route; static client
assets are served over `runtime.fs?.readFile`.

### Registration

```typescript
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

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
import { CAPABILITIES, ISsrService } from '@setu-ts/common';

// The plugin handles SSR automatically at the catch-all.
// Any route that NAMES its path beats the catch-all, in either registration order:
// the kernel ranks candidates by static segments (descending), then wildcards
// (ascending), then registration index. So /login, /openapi.json and /api/users/:id
// all win over /*, and registration order does not enter into it.
// Known limit: the ranking compares COUNTS, so /a/* loses to /:x/b on /a/b.
// Before M70g a `*` counted as a static segment, so single-segment routes TIED with
// /* and whichever registered first won — which silently removed /openapi.json and
// /docs from every full-stack application.
app.router.get('/api/health', (ctx) => {
  return ctx.response.json({ status: 'ok' });
});
```

### Options

| Option                | Type                                                         | Default        | Description                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serverBuildPath`     | `string`                                                     | **(required)** | Path to the React Router Vite server build (default export = `ServerBuild`).                                                                                                                                                               |
| `loadRequestHandler`  | `(buildPath, mode) => Promise<SsrRuntime>`                   | omitted        | Injectable seam for lazy loading. When omitted, the default performs `await import(serverBuildPath)`.                                                                                                                                      |
| `assetsDir`           | `string`                                                     | omitted        | Filesystem root of the built client bundle. Omit to disable the static-asset route.                                                                                                                                                        |
| `assetUrlPrefix`      | `string`                                                     | `/assets/`     | URL prefix for the asset route.                                                                                                                                                                                                            |
| `publicFiles`         | `boolean`                                                    | `true`         | Also serve files from the client build ROOT (Vite copies `public/` there — `robots.txt`, `favicon.ico`) with `must-revalidate`, not `immutable`: those files are not content-hashed. `false` reproduces the previous prefix-only behaviour |
| `basename`            | `string`                                                     | `/`            | Mount prefix for the SSR catch-all. MUST match `react-router.config.ts` `basename` for flat routes.                                                                                                                                        |
| `populateLoadContext` | `(ctx: IRequestContext, context: RouterLoadContext) => void` | omitted        | Adds app values to the per-request React Router context, on top of the keys the plugin always sets.                                                                                                                                        |
| `mode`                | `'production' \| 'development'`                              | `'production'` | Passed to `createRequestHandler(build, mode)`.                                                                                                                                                                                             |

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
import { servicesContext, userContext } from '@setu-ts/react-router-plugin';
import { CAPABILITIES, type ILogger } from '@setu-ts/common';

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
import { contextKeyFor } from '@setu-ts/react-router-plugin';
import type { ISession } from '@setu-ts/common';

export const sessionContext = contextKeyFor<ISession | null>('app.session', null);
```

Keys are matched by **identity**, and in a framework-mode application the declaring module reliably
exists twice: Vite inlines application modules into the server build, while the runtime loads
`setu.config.ts` from source. Two hand-written key objects then look identical and match nothing —
`context.get()` returns the default, so a session reads as `null` and a CSRF token as an empty
string, with no error anywhere. Resolving by name through this package gives both copies the same
object.

That guarantee needs this package to be a **single module instance**, which means the server build
must treat `@setu-ts/*` as external:

```typescript
// vite.config.ts
export default defineConfig({
  environments: {
    ssr: {
      build: {
        rollupOptions: { external: ['@setu-ts/react-router-plugin'] },
      },
    },
  },
});
```

Declared under `environments.ssr.build`, deliberately: React Router builds through Vite's
Environment API, and neither a top-level `ssr.external` nor `environments.ssr.resolve.external`
reaches that build. `setu new --template full-stack` emits all of this already.

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

## WorkerPoolPlugin() (`@setu-ts/worker-pool-plugin`)

Runs CPU-bound work (image processing, report generation, large data transforms) on **real worker
threads**, off the event loop, behind the capability model. Registers an `IWorkerPool` under
`CAPABILITIES.WORKER_POOL`. Task handlers are addressed by **module specifier**, never by closure —
closures cannot cross a thread boundary. Inputs and outputs travel by structured clone.

### Registration

```typescript
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';

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
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<Uint8Array, Uint8Array>(async (imageBytes) => {
  return await resize(imageBytes);
});
```

### Usage

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';

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
  instances. A clone failure surfaces as a rejected `run()` on both dispatch paths (immediately, and
  when the task is dispatched later from the queue); the worker is retained and the pool keeps
  serving.
- **A worker that ends its own thread** settles its in-flight task with `WorkerExitError` and frees
  the slot, independently of the task timeout — where the runtime reports the exit. It does on Node
  (`node:worker_threads` `'exit'`) and on Bun (its non-standard `'close'`); it does **not** on Deno,
  whose web `Worker` emits no host-side event at all when a worker calls `self.close()`, and where a
  later `postMessage` still resolves. On Deno the task timeout therefore remains the only backstop,
  so keep one on any pool whose task module can terminate itself. The pool reports which case it is
  in through `exitDetection` in its health payload, and warns once at `register()` when
  `taskTimeoutMs` resolves to `0` on a runtime that cannot report an exit.
- **Node `.ts` task modules** need an app-level loader/build, exactly as the frontend build is the
  app's responsibility (AI_GUIDELINES §12.2); the plugin consumes the module specifier as given.
- Health indicator `worker-pool` reports `{ available, exitDetection, pools }`.
- **Metrics (opt-in by capability).** When `CAPABILITIES.METRICS` is registered, the plugin
  publishes six series, all labelled `task_module`: gauges `worker_pool_workers`,
  `worker_pool_busy_workers`, `worker_pool_queued_tasks`, and counters
  `worker_pool_tasks_completed_total`, `worker_pool_tasks_failed_total` (also labelled `reason`:
  `handler`/`timeout`/`crash`/`clone`/`shutdown`) and `worker_pool_tasks_rejected_total` (`reason`:
  `queue_full`/`pool_closed`/`unavailable`). No plugin option enables them and none disables them —
  the instruments exist exactly when the metrics capability does. `..._failed_total` summed over
  `reason` equals the health payload's `failed`; `..._rejected_total` counts refusals that never
  became tasks, which the health payload cannot see. Gauges are written from the health snapshot on
  each state change, so the two surfaces cannot disagree, and no interval timer is armed.

---

## SecretsPlugin() (`@setu-ts/secrets-plugin`)

Provides secret management: registers an `ISecretManager` under `CAPABILITIES.SECRETS`, backed by a
pluggable provider with a monotonic-clock read-through cache. The default provider is `'env'`
(zero-dependency, every runtime). No cloud SDK is a hard dependency — each cloud provider accepts an
injected client facade or lazily imports its SDK (AI_GUIDELINES §12.2). Secret values are never
logged.

### Registration

```typescript
import { SecretsPlugin } from '@setu-ts/secrets-plugin';

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
import { CAPABILITIES } from '@setu-ts/common';
import type { ISecretManager } from '@setu-ts/common';

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
- `ISecretManager` — re-exported from `@setu-ts/common` (`get` / `has` / `rotate`).

### Notes

- `EnvProvider` is read-only: `rotate()` and provider `set` throw, since environment variables
  cannot be mutated at runtime. It reads env through `IRuntimeServices.env`, resolving Workers/Deno
  bindings.
- Secret names use provider-specific path syntax; `EnvProvider` maps a name to an env key by
  uppercasing and replacing `/`, `-`, `.` with `_` (e.g. `database/password` → `DATABASE_PASSWORD`).

---

## AuditPlugin() (`@setu-ts/audit-plugin`)

Provides an immutable audit trail: registers an `IAuditLogger` under `CAPABILITIES.AUDIT`, backed by
a pluggable storage backend. `log()` stamps each entry with an internally assigned `id`
(`runtime.uuid()`) and wall-clock `timestamp` (`runtime.now()`), deep-freezes the record
(immutability), then appends it to storage. The default backend is `'memory'` (zero-dependency, runs
on every runtime including Cloudflare Workers) — **non-durable**, so production should select
`'log'`, `'database'`, or `'file'`. No database driver is a hard dependency: the `'database'`
backend takes an injected client facade (`IAuditDbClient`), never the `database` capability token.

### Registration

```typescript
import { AuditPlugin } from '@setu-ts/audit-plugin';

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
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuditLogger } from '@setu-ts/common';

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
- `IAuditLogger`, `AuditEntry` — re-exported from `@setu-ts/common`.
- `StoredAuditEntry`, `AuditQuery` — the return and parameter types of the exported storage classes'
  `query` members. Exported so those signatures are nameable by a consumer (the M52c
  `NormalizedQuery` lesson); the read path belongs to the storages, not to `IAuditLogger`.

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

## CQRS (`@setu-ts/cqrs-plugin`)

Provides command/query separation with buses.

### Registration

```typescript
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import type { CqrsRequest, IPipelineBehavior } from '@setu-ts/common';

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
import type { CqrsCommand, CqrsQuery } from '@setu-ts/cqrs-plugin';

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
import type { ICommandHandler, IQueryHandler } from '@setu-ts/cqrs-plugin';

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

Two ways, and both end at the same `commandBus.register(type, handler)` call.

**Declaratively**, through the plugin's options — which is what a handler needing no constructor
dependencies wants, and what `setu generate command-handler` wires for you:

```typescript
import type { CommandHandlerRegistration, QueryHandlerRegistration } from '@setu-ts/cqrs-plugin';

const commandHandlers: readonly CommandHandlerRegistration[] = [
  { type: 'CreateUserCommand', handler: new CreateUserHandler() },
  // Or a factory that builds the handler from the service registry:
  { type: 'PlaceOrderCommand', handler: createPlaceOrderCommandHandler },
];
const queryHandlers: readonly QueryHandlerRegistration[] = [
  { type: 'GetUserQuery', handler: new GetUserHandler() },
];

app.register(CqrsPlugin({ commandHandlers, queryHandlers }));
```

Each entry is a `{ type, handler }` pair because that is exactly what the bus takes — the type is a
string the request carries, not something derivable from the handler's class. The `handler` accepts
an instance or a `RegistryFactory` (`(services: IServiceRegistry) => handler`), and `behaviors`
accepts the same `instance | RegistryFactory<IPipelineBehavior>` union. Factories are called at the
`onInit` phase — the first phase at which the registry holds every capability — so a factory can
resolve any capability (the event bus, a database, the logger) and build the handler or behavior
with it. A factory that throws rejects `start()`, naming the option and the entry, with the original
error preserved as `cause`. Instance entries keep their `register()` timing byte-identically.

**Imperatively**, from a plugin — the route to take when a handler needs a capability, since the
buses only exist once `CqrsPlugin` has registered and `IApplication` exposes no lifecycle hook:

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

## Messaging (`@setu-ts/messaging-plugin`)

Provides message broker abstraction for cross-service integration events.

### Registration

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

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
```

### Plugin Options

`MessagingPluginOptions` is a **discriminated union keyed on `broker`** — exactly mirroring
`packages/messaging-plugin/src/interfaces/index.ts`, which is the source of truth. Each arm carries
the fields the source defines; the cloud brokers split into an _injected-transport_ arm (no
production credentials) and a _production_ arm (credentials required, `client` typed `never`). The
shared `MessagingBrokerType` has eight literals.

```typescript
type MessagingBrokerType =
  | 'memory'
  | 'redis-streams'
  | 'rabbitmq'
  | 'nats'
  | 'kafka'
  | 'pubsub'
  | 'service-bus'
  | 'custom';

/** Present on every arm. */
interface MessagingCommonOptions {
  /** Instance name for multi-instance support (registers under messaging.<name>). */
  name?: string;
  /** Serializer for message payloads. @defaultValue new JsonSerializer() */
  serializer?: ISerializer;
  /** Create producer and consumer spans when telemetry is registered. @defaultValue true */
  tracing?: boolean;
}

// ── Default (in-memory). `broker` is optional so MessagingPlugin() and {} are valid. ──
interface MemoryMessagingOptions extends MessagingCommonOptions {
  broker?: 'memory';
}

// ── Redis Streams ────────────────────────────────────────────────────────────────────
interface RedisStreamsMessagingOptions extends MessagingCommonOptions {
  broker: 'redis-streams';
  /** Connection URL. */
  url?: string;
  /** Injected client — bypasses the lazy npm import. */
  client?: IRedisStreamsClient;
  /** Default consumer group / queue name. */
  defaultQueue?: string;
  /** XREADGROUP poll interval in ms. */
  pollIntervalMs?: number;
  /** XREADGROUP block timeout in ms. */
  blockSizeMs?: number;
}

// ── RabbitMQ ─────────────────────────────────────────────────────────────────────────
interface RabbitMqMessagingOptions extends MessagingCommonOptions {
  broker: 'rabbitmq';
  /** AMQP connection URL. */
  url?: string;
  /** Injected AMQP connection. */
  client?: IAmqpConnection;
  /** Topic exchange name. @defaultValue 'messaging' */
  exchangeName?: string;
  /** Default consumer group / queue name. */
  defaultQueue?: string;
}

// ── NATS (JetStream) ─────────────────────────────────────────────────────────────────
interface NatsMessagingOptions extends MessagingCommonOptions {
  broker: 'nats';
  /** NATS connection URL. */
  url?: string;
  /** Injected NATS connection. */
  client?: INatsConnection;
  /** Header factory required for propagation on an injected NATS connection. */
  headersFactory?: () => INatsHeaders;
  /** JetStream stream name. @defaultValue 'MESSAGING' */
  streamName?: string;
  /** Default consumer group / queue name. */
  defaultQueue?: string;
}

// ── Kafka ────────────────────────────────────────────────────────────────────────────
interface KafkaMessagingOptions extends MessagingCommonOptions {
  broker: 'kafka';
  /** Kafka bootstrap brokers. */
  brokers?: readonly string[];
  /** Injected Kafka client factory. */
  client?: IKafkaFactory;
  /** Kafka client ID. @defaultValue 'messaging-client' */
  clientId?: string;
  /** Default consumer group name. */
  defaultQueue?: string;
  /** Request-reply topic; must already exist on the broker. @defaultValue 'messaging.replies' */
  replyTopic?: string;
}

// ── GCP Pub/Sub — injected transport (client required; credentials optional) ─────────
interface PubSubMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'pubsub';
  /** Injected transport (bypasses the lazy SDK load). Required for this arm. */
  client: IPubSubTransport;
  /** GCP project ID. Optional when client is injected. */
  projectId?: string;
  /** Service-account credentials. Optional when client is injected. */
  credentials?: unknown;
  defaultQueue?: string;
  replyTopic?: string;
}

// ── GCP Pub/Sub — production (projectId required; client must be omitted) ────────────
interface PubSubMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'pubsub';
  /** GCP project ID. Required for production. */
  projectId: string;
  /** Service-account credentials. SDK ADC is used when omitted. */
  credentials?: unknown;
  /** Mutually exclusive with the injected arm — client?: never. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
}

/** GCP Pub/Sub options — exclusive union of injected and production arms. */
type PubSubMessagingOptions =
  | PubSubMessagingOptionsInjected
  | PubSubMessagingOptionsProduction;

// ── Azure Service Bus — injected transport (client required; credentials optional) ───
interface ServiceBusMessagingOptionsInjected extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Injected transport (bypasses the lazy SDK load). Required for this arm. */
  client: IServiceBusTransport;
  /** Connection string. Optional when client is injected. */
  connectionString?: string;
  /** Administration connection string. Optional when client is injected. */
  adminConnectionString?: string;
  defaultQueue?: string;
  replyTopic?: string;
}

// ── Azure Service Bus — production (connectionString required; client must be omitted) ─
interface ServiceBusMessagingOptionsProduction extends MessagingCommonOptions {
  broker: 'service-bus';
  /** Connection string for the Service Bus namespace. Required for production. */
  connectionString: string;
  /** Connection string for the administration client. Defaults to connectionString. */
  adminConnectionString?: string;
  /** Mutually exclusive with the injected arm — client?: never. */
  client?: never;
  defaultQueue?: string;
  replyTopic?: string;
}

/** Azure Service Bus options — exclusive union of injected and production arms. */
type ServiceBusMessagingOptions =
  | ServiceBusMessagingOptionsInjected
  | ServiceBusMessagingOptionsProduction;

// ── Custom — inject any IMessageBroker implementation ────────────────────────────────
interface CustomMessagingOptions extends MessagingCommonOptions {
  broker: 'custom';
  /** Pre-built IMessageBroker instance. Required for this arm. */
  instance: IMessageBroker;
}

/** The factory's single options parameter. */
type MessagingPluginOptions =
  | MemoryMessagingOptions
  | RedisStreamsMessagingOptions
  | RabbitMqMessagingOptions
  | NatsMessagingOptions
  | KafkaMessagingOptions
  | PubSubMessagingOptions
  | ServiceBusMessagingOptions
  | CustomMessagingOptions;
```

Every `MessagingPluginOptions` arm also inherits these ingress-registration options:

| Option                | Type                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions`       | `readonly SubscriptionEntry[]`                                       | Declarative `subscribe()` calls. A `SubscriptionDefinition` is `{ topic, handler, options? }`; factory entries resolve during async `onInit`, so subscriptions are established before the application serves. When a `behaviors` factory is declared, DELIVERY is held until `onInit` has resolved the chain, so no message reaches a handler through a partial one.                                                                            |
| `behaviors`           | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | Wraps subscribe handlers in declared order with `kind: 'messaging'`, topic, message payload, and available headers. No delivery attempt is invented. With no behaviours, no decorator is applied.                                                                                                                                                                                                                                               |
| `chainReadyTimeoutMs` | `number`                                                             | Bounds a dispatch held on the behaviour-chain gate (armed only when a `behaviors` FACTORY is declared). A held dispatch past the bound rejects with `ChainGateTimeoutError`, whose message names `register()`; the gate itself stays, so later dispatches refuse the same way rather than delivering through a partial chain. Default `10_000`; `0` waits forever. Ignored when no factory is configured, because the gate is then never armed. |

The chain deliberately does not wrap or add a registration arm for `respond()`: its handler returns
a value, unlike the void-returning subscribe handlers, and remains forwarded unchanged.

**Publish timing.** `publish` resolves once every matching subscription's work item has been handed
to dispatch — never once every handler has returned — the same guarantee real brokers give, so a
plugin publishing during its own `register()` cannot deadlock startup against the gate. A handler
that rejects never rejects the publish and never becomes an unhandled rejection: on the in-memory
broker, which has no ack model and no redelivery, the failure path terminates in a report through
the application's logger. `InMemoryBrokerOptions.onDispatchError` supplies that reporter for
applications constructing `InMemoryBroker` directly (the plugin always supplies one); absent it, the
rejection is observed and dropped.

**Cloud brokers require production credentials OR an injected transport:**

```typescript
// GCP Pub/Sub — production (requires projectId)
app.register(MessagingPlugin({
  broker: 'pubsub',
  projectId: 'my-gcp-project',
}));

// GCP Pub/Sub — injected transport
app.register(MessagingPlugin({
  broker: 'pubsub',
  client: myPubSubTransport,
}));

// Azure Service Bus — production (requires connectionString)
app.register(MessagingPlugin({
  broker: 'service-bus',
  connectionString: 'Endpoint=sb://...',
}));

// Azure Service Bus — injected transport
app.register(MessagingPlugin({
  broker: 'service-bus',
  client: myServiceBusTransport,
}));
```

### Publishing Messages

```typescript
import { CAPABILITIES } from '@setu-ts/common';

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

Signatures (on `IMessageBroker`, from `@setu-ts/common`):

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

`request` rejects with one of three exported error classes (import from `@setu-ts/messaging-plugin`
for `instanceof` handling):

| Error                        | Thrown when                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `RequestTimeoutError`        | No reply arrived within `timeoutMs`.                                             |
| `RemoteHandlerError`         | The responder threw; `.remoteMessage` carries the remote message.                |
| `MessagingNotSupportedError` | **Deprecated — no broker throws this.** Retained for `instanceof` compatibility. |

> **Broker support.** Request-reply is available on **all supported broker types** — in-memory,
> Redis Streams, RabbitMQ, NATS, Kafka, GCP Pub/Sub, Azure Service Bus, and `custom` (which
> delegates to the injected `IMessageBroker`).
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
import { CAPABILITIES } from '@setu-ts/common';

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
import { EventsMessagingBridge } from '@setu-ts/messaging-plugin';

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
export { MessagingPlugin } from '@setu-ts/messaging-plugin';
export { EventsMessagingBridge } from '@setu-ts/messaging-plugin';

// Broker implementations
export { InMemoryBroker } from '@setu-ts/messaging-plugin';
export { RedisStreamsBroker } from '@setu-ts/messaging-plugin';
export { RabbitMqBroker } from '@setu-ts/messaging-plugin';
export { NatsBroker } from '@setu-ts/messaging-plugin';
export { KafkaBroker } from '@setu-ts/messaging-plugin';
export { GcpPubSubBroker } from '@setu-ts/messaging-plugin';
export { ServiceBusBroker } from '@setu-ts/messaging-plugin';

// Adapter / load helpers. The `*SdkModule` types describe the SDK shape each
// `adapt*` consumes, so a consumer can type a substitute module.
export { adaptPubSubModule, loadPubSubModule } from '@setu-ts/messaging-plugin';
export { adaptServiceBusModule, loadServiceBusModule } from '@setu-ts/messaging-plugin';
export type { PubSubSdkModule, ServiceBusSdkModule } from '@setu-ts/messaging-plugin';

// Serializer
export { JsonSerializer } from '@setu-ts/messaging-plugin';
export type { ISerializer } from '@setu-ts/messaging-plugin';

// Request-reply and gate error classes
export {
  ChainGateTimeoutError,
  CloudBrokerUnavailableError,
  MessagingNotSupportedError,
  RemoteHandlerError,
  ReplyInboxUnavailableError,
  RequestTimeoutError,
} from '@setu-ts/messaging-plugin';

// Option types
export type {
  CustomMessagingOptions,
  EventsMessagingBridgeOptions,
  InMemoryBrokerOptions,
  KafkaMessagingOptions,
  KafkaOptions,
  MemoryMessagingOptions,
  MessagingBrokerType,
  MessagingCommonOptions,
  MessagingPluginOptions,
  NatsMessagingOptions,
  NatsOptions,
  PubSubMessagingOptions,
  RabbitMqMessagingOptions,
  RabbitMqOptions,
  RedisStreamsMessagingOptions,
  RedisStreamsOptions,
  ServiceBusMessagingOptions,
} from '@setu-ts/messaging-plugin';

// Port types (structural)
export type {
  IPubSubSubscription,
  IPubSubTransport,
  PubSubOptions,
} from '@setu-ts/messaging-plugin';
export type {
  IServiceBusProcessErrorArgs,
  IServiceBusReceiver,
  IServiceBusSubscribeOptions,
  IServiceBusSubscription,
  IServiceBusTransport,
  ServiceBusOptions,
} from '@setu-ts/messaging-plugin';

// Re-exported types from @setu-ts/common
export type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  SubscribeOptions,
} from '@setu-ts/messaging-plugin';
```

> **Kafka Commit Model:** Kafka uses the producer/consumer commit model — handler success
> auto-commits; a thrown handler prevents commit.

---

### Trace context across the broker

When `CAPABILITIES.TELEMETRY` is registered, the plugin wraps the broker so `publish`, `subscribe`,
`request` and `respond` create producer and consumer spans, writing a W3C `traceparent` on publish
and parenting delivery from the header it reads back. `MessagingPlugin({ tracing: false })` opts
out; with no telemetry capability registered, behaviour is unchanged.

Each broker uses the header channel its transport actually provides:

| Broker          | Channel                                         | Notes                                                          |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `memory`        | in-process metadata                             | No wire; headers are handed straight to the subscriber.        |
| `redis-streams` | extra `XADD` field/value pairs beside `payload` | Any non-`payload` field is read back as a header.              |
| `rabbitmq`      | AMQP `properties.headers`                       | Field-table values are normalized — see below.                 |
| `nats`          | `MsgHdrs`                                       | Needs a header factory — see the caveat below.                 |
| `kafka`         | record `headers`                                | String values; a delivered `Buffer` value is decoded as UTF-8. |
| `pubsub`        | message `attributes`                            | Pub/Sub attribute values must be strings.                      |
| `service-bus`   | `applicationProperties`                         | SDK values are normalized — see below.                         |

`MessageMetadata.headers` is populated by every first-party broker: it carries the headers the
broker read, and `{}` when the transport carried none. Three transports can deliver values that are
not strings — AMQP field tables carry numbers, booleans, timestamps and byte arrays; Service Bus
types its application properties `number | boolean | string | Date | null`; kafkajs delivers
`Buffer` and permits arrays — so each is normalized to satisfy the declared
`Record<string, string>`. A byte value is decoded as UTF-8, a number or boolean is stringified, a
`Date` becomes ISO-8601, and the first element of a repeated header is taken. A value with no
faithful string form (a nested table, `null`, `NaN`) is **dropped** rather than rendered as
`[object Object]`, so a missing key reads as absent rather than as a corrupted value. It is absent
only for a `'custom'` broker that does not supply it. Branch on emptiness rather than on the
member's presence.

Two cases drop the header rather than propagating, both by construction:

- **NATS with an injected `client`.** A `MsgHdrs` can only be built by the nats module's `headers()`
  function, and an injected connection carries no module. Pass `NatsOptions.headersFactory` (for
  example `() => nats.headers()`) alongside the client. Without it the broker publishes normally and
  reports the dropped headers once through its logger.
- **A Pub/Sub or Service Bus transport injected via `client` that predates this release.**
  `IPubSubTransport.publish` and `IServiceBusTransport.send` gained an optional third parameter
  (`attributes` / `applicationProperties`), and their delivered-message callbacks gained a matching
  optional member. A two-parameter implementation stays assignable and simply ignores the header.

---

### Health status

Since M70c the indicator reports two signals: the broker's lifecycle (`isReady()`) and its
reachability. A ready-but-unreachable broker is `down` with `data.reachable: false` — the
distinction an operator needs to tell "we never started" from "the broker restarted under us". An
unprobeable broker (e.g. the `custom` arm without `isHealthy`) is `up` with
`data.reachable: 'unknown'`, honestly reporting "we did not check".

| Status | Meaning                                                                                  |
| ------ | ---------------------------------------------------------------------------------------- |
| `up`   | The broker is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The broker is not connected, or is connected but unreachable.                            |

`data` reports `{ broker, reachable }`, where `reachable` is `true`, `false`, or `'unknown'`.

## Queue (`@setu-ts/queue-plugin`)

Provides background job queue with Memory and Redis adapters.

### Exports

- **`QueuePlugin`** — Plugin factory for registering the queue service
- **`QueueAdapterType`** — `'memory' | 'redis' | 'rabbitmq' | 'sqs'`
- **`QueuePluginOptions`** — Plugin configuration options (includes `client`, `url`, `prefix?`,
  `sqs?`)
- **`MemoryQueue`** — In-memory queue adapter for development/testing
- **`RedisQueue`** — Redis-backed queue adapter for production
- **`RedisQueueOptions`** — Redis adapter configuration
- **`RabbitMqQueue`** — RabbitMQ queue adapter via amqplib (polling via basicGet, TTL+DLX for
  delays)
- **`RabbitMqQueueOptions`** — RabbitMQ adapter configuration (includes `url`, `client`, `prefix?`)
- **`SqsQueue`** — AWS SQS queue adapter via `@aws-sdk/client-sqs` (receipt-handle bookkeeping,
  `ApproximateReceiveCount` attempt ladder, visibility-timeout backoff, dead-letter ordering)
- **`SqsQueueOptions`** — SQS adapter configuration (`queues`, `deadLetterQueues?`, `region?`,
  `credentials?`, `endpoint?`, `client?`)
- **`ISqsTransport`** — Structural SQS transport port (injected via `SqsQueueOptions.client`)
- **`SqsReceivedMessage`** — SQS received message shape (body, receiptHandle,
  approximateReceiveCount)
- **`SnsPublisher`** — SNS publisher for fan-out (SNS→SQS pairing)
- **`SnsPublisherOptions`** — SNS publisher configuration
- **`ISnsTransport`** — Structural SNS transport port
- **`adaptSqsModule`** / **`loadSqsModule`** — SQS SDK adapter and lazy loader
- **`SqsSdkModule`** — Shape of the SQS SDK module `adaptSqsModule` consumes; exported so a consumer
  can type a substitute module
- **`adaptSnsModule`** / **`loadSnsModule`** — SNS SDK adapter and lazy loader
- **`SnsSdkModule`** — Shape of the SNS SDK module `adaptSnsModule` consumes
- **`QueueBackendUnavailableError`** — Thrown when a cloud queue backend is unavailable (e.g., SQS
  on Cloudflare Workers)
- **`SqsDelayTooLongError`** — Thrown when SQS delay exceeds 900 s
- **`SqsQueueNotConfiguredError`** — Thrown when a job name has no queue URL mapping
- **`IQueue`** — Queue service interface (re-exported from `@setu-ts/common`)
- **`IJob<T>`** — Job interface (re-exported)
- **`JobProcessor<T>`** — Job processor type (re-exported)
- **`AddJobOptions`** — Options for `queue.add()` (re-exported)
- **`ProcessOptions`** — Options for `queue.process()` (re-exported)
- **`QueueDepths`** — `{ ready, processing, dead }` per job name, as the health indicator publishes
  them
- **`RecurringOptions`** — Options for `queue.addRecurring()` (re-exported)
- **`QueueLogger`** — Minimal `error`/`warn` logger surface the service reports background failures
  through (structurally compatible with `ILogger`)

### Registration

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

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

// SQS adapter (production, requires @aws-sdk/client-sqs)
app.register(QueuePlugin({
  adapter: 'sqs',
  sqs: {
    region: 'us-east-1',
    queues: {
      'send-welcome-email': 'https://sqs.us-east-1.amazonaws.com/123456789012/welcome-emails',
      'process-payment': 'https://sqs.us-east-1.amazonaws.com/123456789012/payments',
    },
    deadLetterQueues: {
      'process-payment': 'https://sqs.us-east-1.amazonaws.com/123456789012/payments-dlq',
    },
  },
  pollIntervalMs: 1000,
  defaultMaxAttempts: 3,
}));
```

### Declarative processors and behaviours

| Option       | Type                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processors` | `readonly QueueProcessorEntry[]`                                     | Declarative `process()` registrations. A `QueueProcessorDefinition` is `{ name, processor, options? }`; factory entries resolve at `onInit`. An array containing a factory registers wholly in `onInit`, in DECLARED order, because `process()` is last-wins on a job name. A `behaviors` factory additionally holds dispatch until the chain is final. |
| `behaviors`  | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | Wraps every processor in declared order with `kind: 'queue'`, job name, the delivered `IJob`, and its attempt count. A short circuit acknowledges the job; a throw preserves retry, `onFailed`, and final dead-letter behavior.                                                                                                                         |

Both arms coexist with imperative `queue.process()` calls. With no behaviours, a processor receives
the original job directly and no chain is allocated.

### Adding Jobs

```typescript
import type { AddJobOptions, IQueue } from '@setu-ts/queue-plugin';

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
import type { IJob, IQueue } from '@setu-ts/queue-plugin';

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
import type { IQueue, RecurringOptions } from '@setu-ts/queue-plugin';

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
import { MemoryQueue } from '@setu-ts/queue-plugin';

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
  // Invoked ONCE when a job has exhausted its attempts, immediately before it
  // is dead-lettered. Does NOT fire on an attempt that will be retried. A
  // callback that throws or rejects is reported through the logger and
  // swallowed — the dead-letter still happens.
  readonly onFailed?: (job: IJob, error: unknown) => void | Promise<void>;
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

### Health status

Since M70c the indicator reports two signals: the adapter's lifecycle (`isReady()`) and its
reachability (`isHealthy()`).

| Status | Meaning                                                                                   |
| ------ | ----------------------------------------------------------------------------------------- |
| `up`   | The adapter is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The adapter is not connected, or is connected but unreachable.                            |

Since M70k the payload also carries `queues`, keyed by job name, when the adapter can count its
states cheaply — the memory adapter (in process) and the Redis adapter (`ZCARD`). The key is OMITTED
rather than reported as zeros on RabbitMQ and SQS, whose counts need a management API or
`GetQueueAttributes`: "this adapter cannot tell you" and "there is nothing there" are different
answers, and an operator acting on a dead-letter alert needs to tell them apart.

The counts are read only once the adapter has reported itself reachable, so a `down` payload carries
`{ adapter, reachable }` and no `queues`. Counting against a backend already known to be unreachable
would cost a failing round trip per name on every probe interval and tell an operator nothing that
`reachable: false` does not.

```json
{
  "adapter": "RedisQueue",
  "reachable": true,
  "queues": { "thumbnail": { "ready": 0, "processing": 0, "dead": 1 } }
}
```

`data` reports `{ adapter, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the adapter has no liveness check.

## Scheduler (`@setu-ts/scheduler-plugin`)

Provides cron jobs, fixed-interval recurring jobs, and one-shot delayed jobs, with retry and
distributed locking.

Registers `IScheduler` under `CAPABILITIES.SCHEDULER` (`'scheduler'`).

Execution is in-process and time-driven — jobs are **not** durably persisted, so a restart drops the
schedule until the registering plugin re-creates it. For durable background work, use
[Queue](#queue-setu-tsqueue-plugin) instead.

### Exports

- **`SchedulerPlugin`** — Plugin factory for registering the scheduler service; **throws**
  `SchedulerUnavailableError` at `register()` on Cloudflare Workers, where its timers cannot fire —
  use `WorkersCron` with `[triggers] crons` there instead
- **`SchedulerUnavailableError`** — Thrown by `register()` when the runtime platform cannot run the
  scheduler (Cloudflare Workers); catch it by identity to branch on the refusal
- **`SchedulerPluginOptions`** — Plugin configuration options (`timezone?`, `distributedLock?`)
- **`DistributedLockOptions`** — Lock configuration (`enabled?`, `storage?`, `url?`, `client?`,
  `lock?`, `ttlMs?`)
- **`IDistributedLock`** — Lock seam (`acquire`/`release`) for a custom lock implementation
- **`IRedisLockClient`** — Structural ioredis shape accepted by `distributedLock.client`
- **`IScheduler`** — Scheduler service interface (re-exported from `@setu-ts/common`)
- **`ScheduledJob<T>`** — Job instance handed to the handler (re-exported)
- **`SchedulerJobHandler<T>`** — Handler callback type (re-exported)
- **`ScheduleOptions<T>`** — Options for `cron()`/`every()`/`delay()` (re-exported)
- **`RetryOptions`** — Retry configuration (re-exported)
- **`SchedulerBackoff`** — `'fixed' | 'exponential'` (re-exported)

### Registration

```typescript
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';

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

**Multi-instance deduplication** works across replicas sharing one lock backend. `cron` and `every`
fires each claim a never-released _slot_ lock keyed on the fire's intended time
(`scheduler:job:<name>:<slot>`), so two replicas whose timers land anywhere in the same intended
slot run the handler exactly once between them; `ttlMs` bounds how long a claimed slot is
remembered, so it must exceed the maximum skew between replicas. `delay` jobs claim their slot at
REGISTRATION, keyed on the job name plus a `:once` suffix (`scheduler:job:<name>:once`), because a
delay's intended fire time is `now + delayMs` and carries per-replica startup skew — the name is
what identifies "the same one-shot job" across replicas. The suffix is load-bearing: the bare
`scheduler:job:<name>` is the per-handler mutex, and a slot holding that key would make the mutex
acquire at fire time always lose to the slot's own claim. A delay's slot is released when the job
leaves the registry (on fire, `remove`, or TTL expiry), so re-registering the same name after it
fired gets a fresh slot and fires again.

**A `delay` job is lost if the replica that claimed it leaves before firing.** The claim is decided
at registration, so a replica that finds the slot held never re-attempts: if the claiming replica
crashes — or shuts down gracefully, since `disconnect()` clears timers without releasing the slot —
between registering the delay and firing it, no replica runs the handler and nothing reports it. The
exposure window is the delay itself, so it matters for a long `delayMs` on a replica set that may
lose a pod in that window. `cron` and `every` are unaffected: they claim at fire time, so the next
fire re-contends. A separate per-handler mutex preserves overlap protection — a second fire of a job
whose previous fire is still running is skipped locally. `every` jobs arm on an absolute epoch grid
(`(floor(now / interval) + 1) * interval`), so replicas registered at different instants agree on
slot keys; the first fire may come sooner than one full interval after registration.

### Declarative jobs and behaviours

| Option      | Type                                                                 | Behavior                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs`      | `readonly SchedulerJobEntry[]`                                       | Declarative `cron()`/`every()`/`delay()` registrations. `SchedulerJobDefinition` is a union discriminated by `trigger`, so each arm requires its `expression`, `intervalMs`, or `delayMs`; factory entries resolve at `onInit`. When a `behaviors` factory is declared, a fire is held until `onInit` has resolved the chain. |
| `behaviors` | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | Wraps every job handler in declared order with `kind: 'scheduler'`, job name, delivered `ScheduledJob`, and its 1-based attempt. Throws use the job's normal retry behavior.                                                                                                                                                  |

The chain runs inside the distributed lock: a replica that does not acquire the lock runs neither a
behaviour nor the handler. With no behaviours configured, the handler receives its job directly and
no chain is allocated.

### Scheduling Jobs

```typescript
import type { IScheduler } from '@setu-ts/common';

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

<!-- version:history -->

`resume` re-arms from the current time rather than resuming the original countdown: cron jobs
compute the next fire from now, `delay` jobs re-arm the **full** original `delayMs` from now, and
`every` jobs resume on the next epoch grid boundary of their interval
(`(floor(now / intervalMs) + 1) * intervalMs`) — **not** a full interval after now. This is
**breaking versus 0.1.0-alpha.8**, whose contract stated the interval "restarts from now": the fire
may now come sooner than one full interval after resume (never later). Grid alignment at resume is
deliberate — it is the same alignment that makes replicas agree on fire times and slot keys, and a
resume that restarted the phase would let one replica's resumed job drift out of slot agreement with
the others.

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

## Resilience (`@setu-ts/resilience-plugin`)

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
- **`IResilienceService`** — Resilience service interface (re-exported from `@setu-ts/common`)
- **`WrapOptions`** — Pattern-selection options for `wrap` (re-exported)
- **`CircuitBreakerPolicy`** — `threshold`, `timeout` (rolling failure window ms), `resetTimeout`
  (re-exported)
- **`RetryPolicy`** — `limit`, `delay`, `backoff` (re-exported)
- **`BulkheadPolicy`** — `maxConcurrent`, `maxQueue?` (re-exported)
- **`BackoffStrategy`** — `'fixed' | 'exponential'` (re-exported)

### Registration

```typescript
import { ResiliencePlugin } from '@setu-ts/resilience-plugin';

app.register(ResiliencePlugin({
  defaultCircuitBreaker: { threshold: 5, timeout: 10_000, resetTimeout: 30_000 },
  defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
  defaultBulkhead: { maxConcurrent: 10, maxQueue: 20 },
}));
```

### Programmatic API

```typescript
import type { IResilienceService } from '@setu-ts/common';
import { CircuitOpenError, TimeoutError } from '@setu-ts/resilience-plugin';

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

> **Hoist the wrapped call.** The state-preserving closure is built once per `wrap` — a `wrap()`
> written inside a handler constructs a fresh breaker on every request, so the breaker never opens
> while retry and timeout keep working (the broken shape looks identical to the working one). Wrap
> at module or plugin scope and call the returned closure per request.

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

## Storage (`@setu-ts/storage-plugin`)

Provides file storage abstraction.

### Registration

```typescript
import { createUploadMiddleware, getUploadedFile, StoragePlugin } from '@setu-ts/storage-plugin';
import type { IStorage } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

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
  fieldname: 'file', // parts with any other name are dropped
  maxSize: 10 * 1024 * 1024, // per file; exceeding it answers 413
  allowedMimeTypes: ['image/jpeg', 'image/png'], // optional
  maxFiles: 5, // optional; exceeding it answers 400
});

app.router.post('/upload', {
  middleware: [uploadMw],
  handler: async (ctx) => {
    // `getUploadedFile` returns `UploadedFile | undefined`, and the fieldname
    // must match the middleware's — it filters parts to that name.
    const file = getUploadedFile(ctx, 'file');
    if (!file) return ctx.response.status(400).json({ error: 'No file' });

    const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
    // `file.name` is the form field name; `file.filename` is the client's original file name.
    const key = `uploads/${file.filename}`;
    // Without `contentType` the object is stored as `application/octet-stream`
    // and the signed URL below downloads it instead of rendering it.
    await storage.put(key, file.data, { contentType: file.mimeType });

    const url = await storage.getSignedUrl(key, { expiresIn: 3600 });
    return ctx.response.json({ url, key });
  },
});
```

Refusal statuses: a body or file over its limit answers **413**; a malformed body, a disallowed MIME
type and too many files answer **400**.

`maxBodyBytes` (default 50 MB) caps the body the middleware will PARSE, with the effective bound
`min(maxSize * 2 + framing, maxBodyBytes)`. It does not bound the initial read — the HTTP adapter
buffers the whole body before any middleware runs, and `IRequest` exposes no body stream.

### Usage — buffered download

```typescript
app.router.get('/files/:key', async (ctx) => {
  const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
  const file = await storage.get(ctx.params.key);
  return ctx.response.header('content-type', 'application/octet-stream').send(file);
});
```

### Usage — streaming download (`getStream?`)

```typescript
app.router.get('/files/stream/:key', async (ctx) => {
  const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
  const stream = await storage.getStream!(ctx.params.key);
  return ctx.response.header('content-type', 'application/octet-stream').stream(stream);
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

All cloud providers support an injectable `client` option that bypasses the lazy import, but the
three types are NOT alike and the difference decides what you can pass:

| Option type        | Mirrors its SDK? | What injecting it means                                                               |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| `IGcsClient`       | yes              | A real `@google-cloud/storage` client fits structurally.                              |
| `IAzureBlobClient` | yes              | A real `@azure/storage-blob` client fits structurally.                                |
| `IS3Backend`       | **no**           | This package's own backend surface — implementing it, not handing over an `S3Client`. |

`IS3Backend` was named `IAwsS3Client` before the alpha.9 release, which promised something it never
was: `@aws-sdk/client-s3`'s surface is `send(command)`, so a real `S3Client` was refused with
`Injected S3 client is missing required methods`. There is consequently no supported way to
configure the underlying SDK client (custom retry policy, timeout, proxy agent). The old name is
still exported as a deprecated alias of the same type (AI_GUIDELINES §9.2), so existing imports keep
compiling; new code should use `IS3Backend`.

### IStorage methods

| Method                                                                   | Description                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `put(path, data, options?: PutObjectOptions): Promise<void>`             | Stores an object. `options` carries `contentType` and `metadata`; S3, GCS, Azure and Cloudflare R2 record them on the object, while the memory and local providers accept and do not persist them. |
| `get(path: string): Promise<Uint8Array>`                                 | Retrieves an object. **Throws** if absent.                                                                                                                                                         |
| `delete(path: string): Promise<boolean>`                                 | Deletes an object. Returns `true` if present.                                                                                                                                                      |
| `exists(path: string): Promise<boolean>`                                 | Checks existence.                                                                                                                                                                                  |
| `getSignedUrl(path: string, options: SignedUrlOptions): Promise<string>` | Creates a time-limited URL. Per-provider semantics: Memory → synthetic `memory://…?expires=…`; LocalStorage → throws; S3 → presigned GET; GCS → signed URL; Azure → SAS (requires `accountKey`).   |
| `getStream?(path: string): Promise<ReadableStream<Uint8Array>>`          | **Optional.** Streams an object for zero-copy downloads. Native on S3/GCS/Azure; Memory/Local fall back to wrapping `get(path)` in a one-chunk stream. Absent objects throw.                       |

### Per-provider `getSignedUrl` behavior

| Provider               | Behavior                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryProvider`       | Returns deterministic synthetic URL `memory://<encoded-key>?expires=<epoch-seconds>`. Test/process affordance only — never grants real access. |
| `LocalStorageProvider` | **Throws** `Error('LocalStorageProvider does not support signed URLs; use the s3, gcs, or azure provider')`.                                   |
| `S3Provider`           | Real presigned GET URL via `getSignedUrl(GetObjectCommand, { expiresIn })`.                                                                    |
| `GcsProvider`          | Real signed URL via `file.getSignedUrl([{ action: 'read', expires }])`.                                                                        |
| `AzureBlobProvider`    | Real SAS URL via `generateBlobSASQueryParameters`. Requires `accountKey`; throws if only managed-identity / account-name-only config.          |

---

### Health status

Since M70c the indicator reports two signals: the provider's lifecycle (`isReady()`) and its
reachability (`isHealthy()`).

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `up`   | The provider is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The provider is not connected, or is connected but unreachable.                            |

`data` reports `{ provider, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the provider has no liveness check.

## MailPlugin() (`@setu-ts/mail-plugin`)

Provides email sending: registers an `IMailer` under `CAPABILITIES.MAIL`, backed by a pluggable
provider. The default provider is `'log'` (zero-dependency, every runtime — records/logs each
message instead of sending it). No mail SDK is a hard dependency — the SMTP and SES providers accept
an injected client facade or lazily import their package (AI_GUIDELINES §12.2), and SendGrid sends
over web-standard `fetch`. A zero-dependency template engine renders named `{{ variable }}` bodies
for `sendTemplate`.

### Registration

```typescript
import { MailPlugin } from '@setu-ts/mail-plugin';

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
import { CAPABILITIES } from '@setu-ts/common';
import type { IMailer } from '@setu-ts/common';

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
- `IMailer`, `MailMessage` — re-exported from `@setu-ts/common`.

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

### Health status

Since M70c the indicator reports two signals: the provider's lifecycle (`isReady()`) and its
reachability (`isHealthy()`).

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `up`   | The provider is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The provider is not connected, or is connected but unreachable.                            |

`data` reports `{ provider, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the provider has no liveness check (e.g. the log provider always reports `true`).

## Notifications (`@setu-ts/notification-plugin`)

Provides multi-channel notifications.

### Registration

```typescript
import { NotificationPlugin } from '@setu-ts/notification-plugin';

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
- `INotifier`, `NotificationMessage` — re-exported from `@setu-ts/common`.

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

## Feature Flags (`@setu-ts/feature-flags-plugin`)

Provides feature flag capability.

### Registration

```typescript
import { FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';

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
import { createFlagGuard } from '@setu-ts/feature-flags-plugin';

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
| `FlagDefinition`               | interface        | `{ enabled, percentage?, users?, tenants? }`                                  |
| `IFlagStore`                   | interface        | Structural facade for `DatabaseProvider`                                      |
| `FeatureFlagsPluginOptions`    | type             | Discriminated union of the four provider option shapes                        |
| `ConfigProviderOptions`        | interface        | The `'config'` arm — requires `options.flags`                                 |
| `MemoryProviderOptions`        | interface        | The `'memory'` arm — `options.flags` optional                                 |
| `DatabaseProviderOptions`      | interface        | The `'database'` arm — requires `options.store`                               |
| `LaunchDarklyProviderOptions`  | interface        | The `'launchdarkly'` arm                                                      |
| `LaunchDarklyProviderConfig`   | interface        | That arm's configuration shape                                                |
| `CustomProviderOptions`        | interface        | The `'custom'` arm — requires `options.instance`                              |
| `FlagGuardOptions`             | interface        | `createFlagGuard` options (`fallback`, `statusCode`, `context`)               |
| `IFeatureFlags`, `FlagContext` | type (re-export) | From `@setu-ts/common`                                                        |

### Notes

- `IFeatureFlags.isEnabled` is **synchronous**; providers refresh their state out of band.
- **Tenant restriction.** `FlagDefinition.tenants` is a restriction, not an allowlist: when present
  and non-empty, the flag is `false` for any context whose `tenantId` is not in the list — including
  a context with no tenant — and it is evaluated **ahead of every other rule**, so it cannot be
  overridden by `users` or `enabled: true`. When absent, evaluation is unchanged.
  `FlagContext.tenantId` is optional, so existing callers and implementors are source-compatible; a
  context without a `tenantId` only matters against a flag that scopes itself. `createFlagGuard`
  derives `tenantId` from `ctx.request.tenant?.id` (omitting it when absent) unless
  `options.context` is supplied.
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

## Multi-Tenancy Plugin (`@setu-ts/multi-tenancy-plugin`)

Provides multi-tenancy support: tenant resolution, tenant context, tenant-scoped repositories,
cache-key isolation, and pluggable database-isolation strategies. The cache-key isolation is applied
by `cacheMiddleware` (from `@setu-ts/cache-plugin`) reading `ctx.request.tenant` and composing a
length-prefixed tenant segment into the cache key — not by the `cache.prefix` string stamped into
`ctx.state`, which no package reads.

### Registration

```typescript
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

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

**Non-HTTP work uses `getRepositoryFor(tenantId, entity)`** (since `0.4.0`) — the ctx-free entry
point, modelled on `prefixCacheKey`: a queue processor, scheduled job, or ingress behaviour holds no
`IRequestContext`, so the tenant id comes from the work item's own payload and the repository scopes
to the id GIVEN. The id is trusted input — nothing resolves it — so keep using
`getRepository(ctx, …)` on the HTTP path, where the middleware-resolved tenant is authoritative:

```typescript
// Inside an ingress behaviour (or any background work): no IRequestContext exists.
const payload = ctx.payload as { tenantId: string };
const repo = tenancy.getRepositoryFor<{ id: string }>(payload.tenantId, 'Order');
await repo.create({ id: 'ord-1' });
```

### Options

| Option                  | Type                                                                                              | Required | Description                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver`              | `'subdomain' \| 'header' \| 'path' \| 'jwt' \| ITenantResolver \| ITenantResolver[]`              | yes      | Discriminant for tenant resolution method, or a custom resolver / array of resolvers                                                                                                                                      |
| `subdomain.baseDomain?` | `string`                                                                                          | no       | Stripped from host to isolate tenant label; absent → first host label is tenant id                                                                                                                                        |
| `header.name?`          | `string`                                                                                          | no       | Header to read; default `'x-tenant-id'`                                                                                                                                                                                   |
| `path.segment?`         | `number`                                                                                          | no       | Path segment index to read; default `0`                                                                                                                                                                                   |
| `jwt.claim?`            | `string`                                                                                          | no       | JWT claim to read; default `'tenant_id'`                                                                                                                                                                                  |
| `jwt.headerName?`       | `string`                                                                                          | no       | Authorization header name; default `'authorization'`                                                                                                                                                                      |
| `jwt.decode?`           | `(token: string) => Record<string, unknown> \| null`                                              | no       | Custom decoder; falls back to `IJwtService.decode` from `CAPABILITIES.JWT` if absent                                                                                                                                      |
| `database`              | `'column-per-tenant' \| 'schema-per-tenant' \| 'database-per-tenant' \| ITenantIsolationStrategy` | no       | Isolation strategy the data store is expected to implement; default `'column-per-tenant'`                                                                                                                                 |
| `dataStore?`            | `ITenantDataStore`                                                                                | no       | Injected CRUD backend; default `MemoryTenantDataStore`                                                                                                                                                                    |
| `cache.prefix?`         | `boolean`                                                                                         | no       | When `true`, stamps resolved prefix into `ctx.state` via `getTenantCachePrefix()`                                                                                                                                         |
| `cache.separator?`      | `string`                                                                                          | no       | Default `':'` — used by `prefixCacheKey` and the `ctx.state` stamp                                                                                                                                                        |
| `required?`             | `boolean`                                                                                         | no       | When `true`, short-circuits unresolved requests at 400 without calling `next()`                                                                                                                                           |
| `rejectionStatus?`      | `number`                                                                                          | no       | Status code for required-tenant short-circuit; default `400`                                                                                                                                                              |
| `exclude?`              | `readonly (string \| RegExp)[]`                                                                   | no       | Paths that skip tenant resolution entirely (exact string or `RegExp.test`); default the six operational probes (`/live`, `/ready`, `/health`, `/metrics`, `/openapi.json`, `/docs`); `[]` restores the previous behaviour |
| `middlewarePriority?`   | `number`                                                                                          | no       | Priority for auto-added middleware; default `40`                                                                                                                                                                          |

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
| Re-exported from common: `IMultiTenancyService`, `ITenantRepository`, `ITenant`, `ITenantResolver`, `CAPABILITIES` | types/const | Convenience re-exports — canonical definitions stay in `@setu-ts/common`                   |

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
  (column-stamping; the schema/database labels as partition-map keys — no physical schema or
  database is created). A store that never receives `useIsolation` partitions by raw tenant id.
- **A strategy NAMES the isolation; a store delivers it.** No shipped database adapter is told the
  strategy and none creates schemas or databases. A `register()` warning fires when a non-`'column'`
  strategy is selected with no `dataStore` injected, and the `JwtResolver` arm of `resolver` warns
  that tenant identity comes from an UNVERIFIED claim.
- **Auto-added at priority 40.** Runs after observability (metrics 20 / telemetry 30), before auth
  (300). Exported for manual re-ordering.

## Health (`@setu-ts/health-plugin`)

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
```

Since **M70c** each indicator's result is **projected** to the declared {@linkcode
HealthCheckResult} shape — `status`, and `data` when present — before it enters the report. An
indicator that returns anything else (a typo'd `details` instead of `data`, or its own `latencyMs`)
has that field **dropped rather than published**: excess-property checking does not survive
`Promise.resolve({ ... })` at the generic call, so the mistyped field type-checks, and `/health` is
frequently the least protected endpoint in a deployment. The `latencyMs` in the report is always the
one the health service measured.

```typescript
interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly data?: Readonly<Record<string, unknown>>;
}

type HealthStatus = 'up' | 'down' | 'degraded';
```

### Registration

```typescript
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';

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
    // Or a factory that builds the indicator from the service registry:
    (services) => createDatabaseIndicator(services),
  ],
}));
```

`indicators` accepts an instance or a `RegistryFactory`
(`(services: IServiceRegistry) =>
IHealthIndicator`), the exported `HealthIndicatorEntry` union. A
factory is called at the `onInit` phase — the first phase at which the registry holds every
capability — and, because `HealthPlugin` registers at priority 100, before the database and every
other ordinary capability plugin, so a factory can resolve the capability it exists to probe and
build the indicator with it. Factories are registered at the head of the existing `onInit` hook,
before the `CAPABILITIES.HEALTH_INDICATOR` contribution drain. A factory that throws rejects
`start()`, naming the option and the entry. Instance indicators keep their `register()` timing
byte-identically.

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

## Metrics (`@setu-ts/metrics-plugin`)

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
`ctx.metrics.register(name, config)` and the plugin's `customMetrics` option. `NamedMetricConfig` is
that shape plus `name`, and is exported from `@setu-ts/metrics-plugin` — `customMetrics` is typed as
an array of it, so without the export a caller could pass an inline literal but could not declare
its own array in a variable. A pre-registered metric appears in the scrape output as its `# HELP`
and `# TYPE` lines from startup, before anything records on it. The `GET /metrics` scrape endpoint
responds with `Content-Type: text/plain; version=0.0.4; charset=utf-8`.

### Registration

```typescript
import { MetricsPlugin } from '@setu-ts/metrics-plugin';

app.register(MetricsPlugin({
  endpoint: '/metrics',
  defaultMetrics: true,
  httpMetrics: true,
  // Replaces the default ['/health', '/live', '/ready'] exclusion set; the
  // plugin's own endpoint is always excluded either way.
  excludePaths: ['/health', '/live', '/ready'],
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

## Telemetry (`@setu-ts/telemetry-plugin`)

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

| Option                  | Type                                                       | Required        | Description                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`           | `string`                                                   | Yes (real mode) | Service name reported to the exporter                                                                                                                                                                   |
| `serviceVersion`        | `string`                                                   | No              | Service version (default: `'1.0.0'`)                                                                                                                                                                    |
| `exporter`              | `'otlp' \| 'console'`                                      | No              | Exporter kind; absent = noop mode                                                                                                                                                                       |
| `endpoint`              | `string`                                                   | Yes (otlp)      | OTLP HTTP endpoint URL                                                                                                                                                                                  |
| `headers`               | `Record<string, string>`                                   | No              | Optional OTLP HTTP headers                                                                                                                                                                              |
| `sampling`              | `{ type: 'traceidratio'; ratio: number }`                  | No              | Sampling config (default ratio: 1.0)                                                                                                                                                                    |
| `tracerProviderFactory` | `() => Promise<TracerHost>`                                | No              | Injectable factory to bypass lazy import                                                                                                                                                                |
| `middleware`            | `boolean`                                                  | No              | Register request-span middleware (default: `true`)                                                                                                                                                      |
| `spanProcessor`         | `'simple' \| 'batch'`                                      | No              | Span processor (`'simple'` by default)                                                                                                                                                                  |
| `instrumentations`      | `InstrumentationsConfig`                                   | No              | Auto-instrumentation config (runtime-gated no-op)                                                                                                                                                       |
| `contextPropagation`    | `boolean`                                                  | No              | Activate real OTel spans (default: `true`)                                                                                                                                                              |
| `contextManagerFactory` | `() => Promise<{ enable(): unknown; disable(): unknown }>` | No              | Injectable context-manager **factory** — it returns a promise of a manager, not a manager. The return type is structural, so it can resolve to an OTel context manager with no import from this package |

### Span nesting and broker propagation

In real OTel mode, `withSpan` activates the span while its callback runs, so nested work inherits
the active parent. Implicit inheritance holds only when the plugin is in real OTel mode,
`contextPropagation` is not `false`, and the async-local context manager registered successfully;
noop mode, fallback mode, `contextPropagation: false`, and a failed registration — the optional
package not loading, or the registration call throwing — all leave spans flat. A host that already
owns a context manager is NOT a failure: the plugin adopts it and nesting still works. A failed
registration is logged, never thrown. Where the parent relationship must hold regardless of
activation, pass `parentContext` explicitly. When `MessagingPlugin` finds telemetry, it creates
`publish <topic>` producer spans and `receive <topic>` consumer spans, writes W3C `traceparent` on
the transport, and parents delivery from the header. Set `tracing: false` to opt out. All
first-party brokers expose the read transport headers through `MessageMetadata.headers`, using `{}`
when the channel is empty.

### Auto-instrumentation

Milestone 24b adds the `instrumentations` option — a per-kind map of `true | InstrumentationConfig`
keys: `http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`. Each key enables one auto-instrumentation.
On non-Node runtimes (Deno, Bun, Cloudflare Workers) all instrumentations degrade to a **documented
no-op** — they never throw. When `tracerProviderFactory` returns a host with a truthy
`otelProvider`, the registry calls `setTracerProvider` + `enable()` on each loaded instrumentation
instance; when `otelProvider` is absent, the registry returns a no-op handle immediately.

Each instrumentation uses the **inject-or-lazy seam**: when `InstrumentationConfig.instrumentation`
is set, the instance is used directly (inject path); otherwise the registry lazy-loads the OTel
package via a literal `npm:` dynamic import (lazy path). Any loader failure is caught and recorded
as a failure outcome — the plugin **never throws** from instrumentation setup.

Every outcome is reported through the plugin's logger (`ctx.logger`, read at call time): an enabled
instrumentation logs one line at `debug`, a failure one line at `warn` carrying `kind` and `reason`.
The plugin declares the logger capability in `optionalDependencies`, so the kernel orders a
plugin-provided logger (e.g. `LoggerPlugin`) before it — the standard configuration
(`RuntimePlugin` + `LoggerPlugin` + `TelemetryPlugin`) reports every outcome. A failure therefore
remains a no-op rather than a throw, but is no longer silent — without a logger registered, the
outcomes are still recorded on the registry handle and nothing is emitted.

### Span Processor

The `spanProcessor` option selects between `'simple'` (default) and `'batch'` span processing. Both
are exported from the pinned `@opentelemetry/sdk-trace-base@^2.9.0`.

### Registration

```typescript
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';

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
import { CAPABILITIES } from '@setu-ts/common';
import type { ITelemetryService } from '@setu-ts/common';

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
3. Stores the span on `ctx.state` under `TELEMETRY_SPAN_KEY` (`'telemetry-plugin:span'`)
4. Sets HTTP attributes (`http.method`, `http.route`, `http.status_code`)
5. Injects `traceparent` into the response headers

Downstream handlers can read the active span via:

```typescript
import { TELEMETRY_SPAN_KEY } from '@setu-ts/telemetry-plugin';
import type { ISpan } from '@setu-ts/common';

const activeSpan = ctx.state.get(TELEMETRY_SPAN_KEY) as ISpan | undefined;
```

### Contract Types

The telemetry contract is framework-owned and exported from `@setu-ts/common` (zero dependencies —
importable without the OTel SDK installed). The telemetry-plugin translates these to OTel types at
its implementation seam.

| Export                     | Kind            | Shape / description                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITelemetryService`        | interface       | `withSpan<T>(name: string, fn: (span: ISpan) => Promise<T>, options?: SpanOptions): Promise<T>` — the only manual span-creation API; ends the span exactly once, even if `fn` throws. Resolved under `CAPABILITIES.TELEMETRY`.                                                            |
| `ISpan`                    | interface       | `setAttribute(key, value): this`, `setAttributes(attrs): this`, `setStatus(status): void`, `recordException(error): void`, `end(): void`, `spanContext(): SpanContext`.                                                                                                                   |
| `SpanContext`              | interface       | `{ readonly traceId: string; readonly spanId: string; readonly traceFlags: string }` — all lowercase hex (32/16/2 chars). Returned by `ISpan.spanContext()`.                                                                                                                              |
| `SpanStatus`               | union           | `'ok' \| 'error' \| 'unset'` — argument to `ISpan.setStatus`.                                                                                                                                                                                                                             |
| `SpanKind`                 | union           | `'internal' \| 'server' \| 'client' \| 'producer' \| 'consumer'` — `SpanOptions.kind` (default `'internal'`).                                                                                                                                                                             |
| `SpanAttributeValue`       | union           | `string \| number \| boolean \| ReadonlyArray<string \| number \| boolean>`.                                                                                                                                                                                                              |
| `SpanOptions`              | interface       | `{ readonly kind?: SpanKind; readonly attributes?: Readonly<Record<string, SpanAttributeValue>>; readonly parentContext?: TelemetryContext }` — 3rd arg to `withSpan`. Pass `parentContext` to parent a span explicitly; implicit linking depends on context activation — see note below. |
| `TelemetryContext`         | interface       | Opaque parent-context handle carrying the extracted W3C fields (`_opaque`, optional `traceId`/`spanId`/`traceFlags`/`tracestate`). Consumers must not inspect it beyond passing it back via `SpanOptions.parentContext`.                                                                  |
| `TELEMETRY_CONTEXT_OPAQUE` | `unique symbol` | Brand for `TelemetryContext._opaque` (`Symbol.for('he.telemetry.context')`); prevents structural mixups.                                                                                                                                                                                  |

> **Implicit parent/child linking is conditional.** Since M75 the plugin DOES register an OTel
> `ContextManager` — the `AsyncLocalStorageContextManager` from the optional
> `@opentelemetry/context-async-hooks` — so in real OTel mode a `withSpan` nested inside another
> auto-parents. That holds only while a context manager is active: the plugin either registers its
> own or adopts one the host already owns, and both nest. It does NOT hold in noop or fallback mode,
> under `contextPropagation: false`, or when the optional package cannot be loaded and registration
> therefore fails — there, spans are recorded but unparented.
>
> Pass `parentContext` (or the extracted context) on `SpanOptions` wherever the relationship must
> hold regardless of activation. The request-span middleware always passes the incoming
> `traceparent` as the parent explicitly, so cross-process propagation (incoming header → server
> span) works out of the box in every mode.

---

## OpenAPI (`@setu-ts/openapi-plugin`)

Provides automatic OpenAPI documentation.

### Registration

```typescript
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

app.register(OpenApiPlugin({
  // OpenAPI spec metadata
  title: 'My API',
  version: '1.0.0',
  description: 'A sample API built with Setu-TS',
  servers: [
    { url: 'https://api.myapp.com', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  },
  // Document-level requirement, inherited by every operation that does not
  // declare its own. Omit it and no operation is marked as protected.
  security: [{ bearerAuth: [] }],
  // Or derive each operation's requirement from the guards on its route, so
  // the document tracks what actually enforces instead of a second
  // declaration that can drift from it.
  deriveSecurity: { scheme: 'bearerAuth' },
  // Router paths to leave out of the document. Matched exactly against the
  // fully-resolved router pattern: router-style (`/todos/:id`, not the
  // template `/todos/{id}`) and including any `router.group()` prefix.
  exclude: ['/internal/debug'],
  // Plugin names whose routes are left out, matched against `RouteInfo.owner`.
  // Defaults to ['health-plugin', 'metrics-plugin']; pass [] to document them.
  excludeOwners: ['health-plugin', 'metrics-plugin'],
  // Fill requestBody and parameters from the validation middleware guarding
  // each route. On by default; pass false for the pre-0.3.0 document.
  deriveRequestSchemas: true,
  // Endpoint configuration
  endpoint: '/docs', // Path for Swagger UI HTML (default: '/docs')
  specEndpoint: '/openapi.json', // Path for OpenAPI JSON spec (default: '/openapi.json')
  swagger: true, // Whether to serve Swagger UI (default: true)
}));
```

### Documenting Authentication

Declaring `securitySchemes` is what gives Swagger UI its **Authorize** button; without it a
protected route cannot be exercised from the page at all. Pair it with `security` to state that
operations require authentication by default, and let an individual route opt out:

```typescript
app.router.post('/login', {
  // An EMPTY array marks the operation public, overriding the document-level
  // requirement. Omitting `security` entirely would leave `/login` documented
  // as needing the token it issues.
  schema: { security: [] },
  handler: async (ctx) => {/* ... */},
});

app.router.delete('/todos/:id', {
  middleware: [requireAuth()],
  // Narrower than the document default — this operation needs a scope.
  schema: { security: [{ oauth2: ['write:todos'] }] },
  handler: async (ctx) => {/* ... */},
});
```

`RouteSchema.security` enforces nothing. Authentication is enforced by `authMiddleware` and the
`requireXxx` guards; this describes the route for readers and for generated clients.

### Deriving Request Schemas From Validation Middleware

A route carrying `validateBody(schema)` already states its request shape, from a first-party plugin,
on the route. `deriveRequestSchemas` (default `true`) reads that schema and fills the operation's
`requestBody` and `parameters`, so the shape is not written twice:

```typescript
app.router.post('/orders', {
  middleware: [validateBody(PlaceOrderSchema), validateQuery(ListQuerySchema)],
  handler,
});
// -> requestBody from PlaceOrderSchema, query parameters from ListQuerySchema,
//    and a documented 400 (which is what the middleware answers).
```

Every helper `@setu-ts/validation-plugin` ships brands the middleware it returns with
`RouteValidationMetadata` (`@setu-ts/common`), and so does `IValidationService.middleware(...)` —
both entry points, identically. No plugin imports another; the `Symbol.for`-keyed brand in `common`
is the whole channel, exactly as `RouteSecurityMetadata` is for guards.

Rules and limits, stated rather than left to discovery:

- **A declared `schema` field always wins, per field.** Declaring `schema.body` and carrying
  `validateQuery(...)` gives the declared body and the derived query.
- **The LAST brand for a target wins** when a route carries two, because that is the value the
  handler receives: each validation middleware writes `validated:<target>` as it passes, so the
  final writer's parsed value is the one in `ctx.state` by the time the handler runs. The request
  must still satisfy EVERY brand, since any of them can short-circuit with a `400`; the document
  shows the shape the handler sees, not that conjunction.
- **`cookies` derives nothing.** `RouteSchema` has no `cookies` field, so there is no declared
  counterpart — and `@setu-ts/sdk`'s client generator refuses an `in: 'cookie'` parameter outright,
  so emitting one would turn a working document into a hard codegen failure for its consumers.
- **A derived route gains `400: { description: 'Bad request' }`** unless it declares its own. The
  status is real; no body schema is emitted, because the shape depends on the plugin's configured
  `errorFormat`, which the generator cannot see.
- **`deriveRequestSchemas: false`** disables derivation only. Owner exclusion, the `operationId`
  format and schema deduplication are unconditional, so this does not restore the whole pre-0.3.0
  document; pass `excludeOwners: []` to document the operational routes again.

Unlike `deriveSecurity` this is ON by default, because nothing has to be configured for it: a
security requirement names a scheme that cannot be inferred from a guard, while the schema on the
route IS the schema the document wants.

### Excluding Operational Routes

`excludeOwners` (default `['health-plugin', 'metrics-plugin']`) drops routes by the plugin that
registered them, read from `RouteInfo.owner`. Without it, `/health`, `/live`, `/ready` and
`/metrics` are documented and flow into every generated client as `getHealth`, `getLive`, `getReady`
and `getMetrics` alongside the real API.

Owners rather than paths, because those endpoints are configuration: `HealthPlugin({ endpoints })`
and `MetricsPlugin({ endpoint })` both accept a path, so a static path list silently stops excluding
a renamed one. Pass `excludeOwners: []` to document them again.

### Deriving Authentication From Guards

Declaring `security` per route makes the document a second source of truth that can drift from the
guards. `deriveSecurity` closes that: every guard `@setu-ts/auth-plugin` ships is branded with
`RouteSecurityMetadata`, and the generator reads the brand off the route's middleware.

```typescript
app.register(OpenApiPlugin({
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  deriveSecurity: { scheme: 'bearerAuth' },
}));

// Documented as requiring bearerAuth — no `schema.security` needed.
app.router.get('/todos/:id', { middleware: [requireAuth()], handler });

// Documented as public.
app.router.post('/login', { middleware: [publicRoute()], handler });
```

Rules, in precedence order: a requirement declared on `schema.security` always wins; otherwise a
route carrying at least one branded guard is derived (`authenticated: true` beats `false`, matching
what the middleware chain does); otherwise the operation carries no key and inherits the
document-level `security`.

Three limits, stated rather than left to discovery:

- **Only route-level middleware is inspected.** Middleware added with `app.middleware.add()` is not
  on the route and is not consulted — correct for `authMiddleware()`, which populates the principal
  and never rejects.
- **Roles and permissions are not expressible.** An OpenAPI requirement names a scheme, and no
  declared scheme can be inferred from `'admin'`, so `requireRole('admin')` documents only that
  authentication is required. A 403 remains a surprise the document cannot warn about.
- **The scheme name is configured, never inferred.** A guard cannot know whether the document calls
  its scheme `bearerAuth` or `jwt`. An undeclared name is refused at `register()`.

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

### Zod Version Support

Both **zod v3 and zod v4** are supported, detected per schema by duck typing — `toJSONSchema`
presence marks a v4 schema; the plugin imports neither major.

- **Zod v4** is converted through `schema.toJSONSchema()` and adapted from JSON Schema draft 2020-12
  to OpenAPI 3.1: the dialect `$schema` key is dropped, formats and constraints pass through
  verbatim (`format`, `pattern`, `contentEncoding`, …), reused schemas are hoisted into
  `components/schemas` with their pointers rewritten, and a recursive schema's root-cycle pointer
  forces that schema into `components` so no bare `#` ref survives in the document.
- **Unrepresentable nodes degrade, never throw.** A type zod cannot represent in JSON Schema
  (`z.date()`, `z.bigint()`) still becomes an empty schema, but the operation owning it now carries
  a machine-readable vendor extension:

  ```json
  {
    "x-setu-unrepresentable": [
      { "at": "post-events", "reason": "zod v4 type 'date' has no JSON Schema representation" }
    ]
  }
  ```

  `at` names the operationId, so the affected route is identifiable without diffing documents. The
  extension is absent when every schema is representable.
- **Zod v3 output is unchanged** — the same schemas produce byte-identical documents as before this
  support existed.

#### Request and response are documented from different sides

A zod schema has two shapes: what a client may SEND, and what the server holds after parsing. They
differ for anything carrying a `.default()`, a `.transform()`, a `.coerce`, or the ordinary
key-stripping of `z.object`. Every request-side position — `body`, `params`, `query`, `headers` — is
documented from the **input** side; `response` is documented from the **output** side.

This is what stops a document contradicting the server it describes. A field with `.default('free')`
is optional for a client (that is what a default is for) and always present in a response, so it is
absent from the request body's `required` and present in the response's. A `.transform()` field
documents its SOURCE type on a request rather than the unrepresentable `{}` its result produces. And
on the three object modes, measured against zod 4.4:

| schema           | unknown key at runtime | request body documents       | response documents           |
| ---------------- | ---------------------- | ---------------------------- | ---------------------------- |
| `z.object`       | accepted, stripped     | (no `additionalProperties`)  | `additionalProperties:false` |
| `z.strictObject` | rejected               | `additionalProperties:false` | `additionalProperties:false` |
| `z.looseObject`  | accepted, kept         | `additionalProperties:{}`    | `additionalProperties:{}`    |

`ZodToOpenApi.transform(schema, io?)` takes the side as an optional second argument, defaulting to
`'output'`, so a direct call is unchanged. Only the zod v4 path reads it: the v3 path has no `io`
concept and already emits the input view, which is why v3 documents are byte-identical and why the
two majors now agree on a request body.

**Deduplication follows the side.** A schema whose two views are identical — every zod v3 schema,
and any v4 schema with no default, transform, coercion or object-mode difference — is hoisted into
ONE component shared by every site, exactly as before. A schema whose views differ and that is used
on both sides yields one component per side, because the two sites do not describe the same shape. A
schema registered through `addSchema('Name', …)` keeps that name for the output side and gains a
`NameInput` twin when a request site reaches it, so the contributor's chosen name still appears on
both sides. The twin is identified by SCHEMA, never by name alone — registering both `Address` and
an unrelated `AddressInput` is legal, and the twin then takes the next free suffixed name rather
than adopting the unrelated component. It belongs to the document that needed it: a later
`generate()` with no request site for that schema drops it, exactly as it drops every other
per-document component.

### Notes

- Every `RouteSchema` position the generator reads becomes part of the operation: `body` becomes the
  `application/json` request body, `response` becomes the responses map, `tags`/`summary` become the
  operation metadata, and `params`, `query`, and `headers` become `parameters` with `in: 'path'`,
  `in: 'query'`, and `in: 'header'` respectively. Path parameters are always `required: true` (they
  come from the path template); query and header parameters take their `required` flag from the
  schema. Header parameters are emitted verbatim — per OpenAPI 3.1, tooling ignores definitions
  named `Accept`, `Content-Type`, and `Authorization`, so the generator does not filter them out.
- A path parameter the `params` schema does not describe is emitted as `{ type: 'string' }` rather
  than the empty schema, which OpenAPI reads as "any type". Every path segment arrives as a string,
  so the empty form made Swagger UI render an untyped box and client generators emit `unknown`. A
  declared `params` entry always wins, per parameter.
- The plugin's own `specEndpoint` and `endpoint` are never documented as operations — a spec that
  lists `/openapi.json` and `/docs` describes its own delivery mechanism, and those entries flow
  into every generated client. The routes are still served; only the document entries are omitted.
  Custom endpoint paths are honored. Anything else the document should omit goes in `exclude`, which
  matches the fully-resolved router pattern — a route registered inside
  `router.group('/internal', …)` is matched by its prefixed path, and an entry matching no route is
  silently ignored.
- A `security` requirement naming a scheme absent from `securitySchemes` is refused at `register()`.
  Emitting it would produce a document that is invalid per the specification — Swagger UI renders a
  lock on every operation with no Authorize button — and nothing downstream can detect it, since the
  spec endpoint still answers `200`.
- An unrestricted decorated route marked `@Public` is documented with an empty `security` array, so
  it opts out of a document-level requirement. `@Public` never exempts a route from an enforced
  `@Roles`/`@Permissions` declaration; when one is present, the public marker is omitted and the
  middleware's derived requirement documents the protection truthfully.

### Accessing the Spec

```typescript
// The spec is available at /openapi.json
// The Swagger UI is available at /docs

// Programmatic access
const openapi = ctx.services.get<IOpenApiService>('openapi');
const spec = openapi.getSpec();
```

---

## CLI (`@setu-ts/cli`)

`@setu-ts/cli` ships the `setu` executable: project scaffolding and plugin-aware code generation.
Install it with an explicit binary name, because Deno's default inference would name it after the
package (`cli`):

```bash
deno install -g -A --min-dep-age 0 -n setu jsr:@setu-ts/cli@^0.3.0/main
```

`--min-dep-age 0` because Deno refuses a dependency published within the last 24 hours, and the CLI
pins projects to its own version — so on release day the install fails without it.

### Commands

```bash
# Scaffold a project (creates ./my-app)
setu new my-app
setu new my-app --runtime node                 # deno | node | bun | cloudflare-workers
setu new my-app --template rest                # rest | microservice | class-based | full-stack
setu new my-app --template microservice --runtime bun
setu new my-app --template class-based          # decorators and DI together
setu new my-app --template rest --env-file config/.env.local

# Scaffold a monorepo (creates ./acme, no member yet)
setu new acme --workspace
setu new acme --workspace --port 4100          # base port for its members
setu new acme --workspace --transport redis    # http | grpc | memory | redis | rabbitmq | nats | kafka
setu generate app orders --template microservice
setu generate app billing --template microservice
setu generate app shipping --template microservice --depends-on orders --depends-on billing
setu workspace ports --reallocate

# Install a framework package into this project
setu add auth                                  # short name
setu add auth-plugin                           # bare package name
setu add @setu-ts/auth-plugin                  # full specifier — all three are the same command
setu add cache --dir ./services/orders
setu add cache --dry-run                       # report the manifest edits, write nothing

# Commands this application's plugins provide
setu commands
setu db:migrate up 3                           # runs a plugin-registered command

# Generate code
setu generate module orders                    # functional by default; class output with decorator-plugin
setu generate plugin my-plugin
setu generate controller user-profile
setu generate service user-profile
setu generate route users
setu generate middleware rate-limit
setu generate guard admin-only                 # requires @setu-ts/auth-plugin
setu generate health-indicator external-api    # requires @setu-ts/health-plugin
setu generate metric orders-placed             # requires @setu-ts/metrics-plugin
setu generate command-handler create-user      # requires @setu-ts/cqrs-plugin
setu generate query-handler get-user           # requires @setu-ts/cqrs-plugin
setu generate event-handler user-created       # requires @setu-ts/events-plugin
setu generate job send-welcome-email
setu generate migration add-users-table        # requires @setu-ts/database-plugin

# Custom schematics, loaded from .setu-ts/schematics/<schematic>.ts
setu generate custom my-schematic order-item

# Aliases
setu n my-app
setu g service user-profile

# Print the plan, write nothing
setu g controller user-profile --dry-run
```

Any casing of the name produces identical output: `setu g controller user-profile` and
`setu g controller UserProfile` emit the same file.

### Options

| Option                                          | Commands                                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--runtime deno\|node\|bun\|cloudflare-workers` | `new`, `generate`                          | On `new`, selects the entry shape and manifest. On `generate`, passed to the schematic as `SchematicOptions.runtime` (read by custom schematics). Defaults to `deno`; an unknown value is a usage error (`2`) on both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--workspace`                                   | `new`                                      | Creates a monorepo root instead of a project: a root manifest whose member globs are `apps/*` and `libs/*` (a `deno.json` `workspace` array, or a `package.json` `workspaces` one under `--runtime node\|bun`), plus a `setu.workspace.json`, with no member. Both globs are written once, so neither a service nor a library ever rewrites the root. Refuses `--template`, and `--runtime cloudflare-workers` — each Worker is its own deploy unit — rather than ignoring them.                                                                                                                                                                                                                                                                                                                        |
| `--port <n>`                                    | `new --workspace`, `generate app`, `adopt` | On `new --workspace`, the base port: the first member binds it and each later one takes the next free number above the highest in use. On `generate app`, the port THIS member binds instead of the allocated one — refused when another member already holds it. Defaults to `3000`. A usage error on a standalone `new`, or when it is not an integer 1–65535.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--env-file <path>`                             | `new`, `generate app`                      | ConfigPlugin-backed Deno, Node, and Bun templates emit that gitignored dotenv file plus a tracked `<path>.example`, and use it as `ConfigPlugin({ envFilePath, envFileOptional: true })`. The file is optional because it is gitignored: the project still starts on a fresh clone, in CI, and in a container, reading configuration from the environment. A template that needs a value names it in both files — `full-stack` emits `SESSION_SECRET`, with a development value in the ignored file and an empty one in the committed example. Refused by minimal templates, workspace roots, and Cloudflare Workers, which read request bindings rather than a filesystem. Plugin construction precedes ConfigPlugin registration, so construction-time values must come from this environment source. |
| `--depends-on <member>`                         | `generate app`                             | Repeat for each existing prerequisite. The member records the names in `setu.workspace.json`; the root dev runner starts prerequisites first and waits for `/ready`. Duplicate or missing names are usage errors, as is using it anywhere but `generate app`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--transport <name>`                            | `new --workspace`                          | How the workspace's services talk to each other: `http` (default), `grpc`, `memory`, `redis`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`. Recorded in `setu.workspace.json`; every member added later inherits it. A usage error on a standalone project, on `generate app`, or for an unknown value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--transport-url <url>`                         | `new --workspace`                          | Replaces the baked local fallback for the endpoint-shaped broker transports. A usage error for `http`, `grpc` and `memory`, which have no broker to address, and for `pubsub` and `service-bus`, whose connection value is a project id or a secret read from the environment — that refusal names the variable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--broker <name>`                               | `new` (standalone)                         | The project's own message broker: `memory` (default), `redis`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`. Rewrites the template's `MessagingPlugin` wiring to that arm, adds the arm's connection variable to the generated dotenv pair, and emits `docker/compose.yaml` starting the broker so the scaffold can complete `app.start()`. Refused — each with its own reason, never silently ignored — on Cloudflare Workers (the runtime swap removes both wirings), starter-composed templates (`full-stack`; a factory-rendered plugin list would drop the rewrite), templates registering no messaging (`rest`, `class-based`, no template), unknown names, and `--workspace`/`generate app` (a workspace's transport is chosen once with `--transport`).                                 |
| `--queue <name>`                                | `new` (standalone)                         | The job queue backend: `memory` (default), `redis`, `rabbitmq`. Same overlay as `--broker`, applied to the `QueuePlugin` wiring, sharing the connection variable and Compose service when both flags name the same arm. Refused for the brokers the queue does not support (`nats`, `kafka`, `pubsub`, `service-bus`) and everywhere `--broker` is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--yes`, `-y`                                   | `new`                                      | Take every default and ask nothing. A no-op when no prompter is present, never an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--scope <scope>`                               | `generate library`                         | The import scope a shared library is named under, without the leading `@`. Defaults to the workspace directory name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--name <member>`                               | `adopt`                                    | The member name the converted project takes. Defaults to the project directory name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--dir <path>`                                  | `new`, `generate`, `add`                   | Operate on this directory instead of the working directory. A relative path is resolved against the working directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--dry-run`                                     | `new`, `generate`, `add`                   | Prints `would create <path>` per file and performs zero writes and zero directory creations. On `add`, prints `would update <manifest>` instead, since it edits files rather than creating them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--help`, `-h`                                  | both                                       | Prints usage and exits `0`. `setu generate --help` lists only the schematics available here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--version`, `-v`                               | —                                          | Prints the version read from the package's own `deno.json` and exits `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### `setu add <plugin>`

Adds a framework package to the project's manifest, pinned to the version of the CLI that added it —
the same rule `setu new` follows, so a project's framework packages stay on one version instead of
drifting per install.

The name resolves three ways, all equivalent: a short name (`auth`), the bare package name
(`auth-plugin`), or the full specifier (`@setu-ts/auth-plugin`). It is an explicit allow-list rather
than "anything under `@setu-ts/`", because the range written is the CLI's OWN version, which is only
correct for packages released as one version with it — so a typo is refused, naming what is
accepted, rather than pinned to a version that does not exist.

When a project carries both `deno.json` and `package.json` — a Workers or Node target does, one for
its build and one for `setu generate`'s plugin gating — **both** are updated, so the gate and the
build cannot disagree about what is installed. `deno.json` gets a `jsr:` specifier under `imports`;
`package.json` gets the npm-compat `npm:@jsr/setu-ts__<name>` form under `dependencies`. Re-adding a
package already present at the same version reports that and writes nothing.

It writes the manifest and **reports** the install command rather than running it:

```
Next:
  deno install --min-dep-age 0
```

That is deliberate. On the day of a release the pin is younger than Deno's 24-hour
minimum-dependency-age policy, so the flags need to be visible rather than buried in a failing
subprocess — and it keeps the command free of the `run` permission.

Exit codes follow the table below: `0` on success, `1` when the directory holds no manifest or a
manifest cannot be parsed, `2` for an unknown package name or a missing argument.

### Exit codes

| Code | Meaning                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success (including `--help` and `--version`).                                                                                                                                                                     |
| `1`  | Runtime error: a gated schematic's plugin is absent, a target file exists, a write failed, the application failed to load or start, a command handler threw, or a command name is registered twice.               |
| `2`  | Usage error: unknown command or schematic, missing argument, unknown `--runtime`, an unusable `--broker`/`--queue` value, or a name that cannot form an identifier (empty after normalization, or digit-leading). |

### Interactive scaffolding

At an interactive terminal, `setu new` asks for the choices it already accepts as flags — on a
standalone project: runtime, template, broker, queue; on a workspace: runtime and transport.
Questions are asked only for absent flags, only when `--yes` is absent, and only when a prompter was
supplied at all; the broker and queue questions fire only when the answers already collected make
the flag legal under the same predicate the command refuses on. Every prompted value is expressible
as a flag, so prompts are never a second configuration surface, and `--dry-run` stays exact.

Non-interactive by construction in three layers, all failing closed to the documented defaults:
`CliDependencies.ask` is OPTIONAL and no programmatic caller passes it; `src/main.ts` supplies the
terminal implementation only behind `Deno.stdin.isTerminal()`; and Deno's own `prompt()` returns
`null` on a non-terminal.

The two exported types:

| Export         | Kind      | Members                                                                                                         |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `Prompter`     | interface | `select(question, choices): Promise<string \| undefined>` — undefined means "no answer could be taken".         |
| `PromptChoice` | interface | `{ value, label }` — the value written into the flag record, and one descriptive line shown above the question. |

`createTerminalPrompter` is deliberately NOT exported: its only consumer is the executable entry
point, which imports it directly.

### Decorators and DI are optional

AI_GUIDELINES states that decorators are optional, dependency injection is optional, and that
**everything has a programmatic API — no feature requires decorators or reflection.** The CLI has
two coherent compositions: functional is the default; `--template class-based` opts into both
decorators and dependency injection.

| You want    | Scaffold with                         | You get                                                                                                          |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Neither     | `setu new app`                        | The runtime plugin alone. `g route`, `g middleware`, `g plugin`, `g service`, `g job` all work and are wired.    |
| Functional  | `setu new app --template rest`        | Router functions and explicit request context; `g module` creates a registered route with GET and POST handlers. |
| Class-based | `setu new app --template class-based` | `DecoratorPlugin` + `DiPlugin`, plus decorated controllers, injectable services, and class module registration.  |

The independent `--di` flag is no longer supported. It is refused with guidance to use
`--template class-based`, which always installs the decorator and DI pair together, and
`--template nest` is refused with a message naming `class-based` as its new name.
`--template
full-stack` therefore has no DI opt-in from the CLI; an application composing the
starter directly still has `FullStackStarterOptions.di`.

The style is read from the target project's manifest on every `setu generate`, so it PERSISTS: a
project holding `decorator-plugin` keeps producing decorated classes — including one that holds it
without `di-plugin`, which only a project predating `--template class-based` can — and a project
without it keeps producing functional output. One consequence is worth stating plainly:
`setu generate service` has **no registration site in a functional project**. A plain exported
function has none to have — no plugin option takes a list of functions — so nothing wires it for
you. It still emits a managed `src/services/index.ts`, but that barrel is a convenience re-export
rather than a registration: `setu.config.ts` does not import it, and you import from it where the
function is needed. In a class-based project the same path holds the `APP_SERVICES` array of
`@Injectable` classes, which the scaffolded config does pass to `DecoratorPlugin`.

> **The Node target runs TypeScript through `tsx`, not through type stripping.** Node's built-in
> support (`--experimental-strip-types`) ERASES types without transforming code, so it cannot run a
> decorator — V8 has not shipped them, so even a TC39 **standard** decorator is a bare
> `SyntaxError: Invalid or unexpected token` there — or the constructor parameter property
> `setu generate module` emits (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). A generated Node project
> therefore declares `tsx` in `devDependencies` and starts with `tsx main.ts`, which transforms
> both; its `tsconfig.json` sets no decorator option, because standard decorators need none. Bun
> compiles TypeScript outright and Deno and Workers never invoke it, so no other target carries the
> dependency.

> **The Workers target carries an npm manifest as well as `deno.json`.** `wrangler` bundles
> `src/index.ts` with esbuild, which resolves neither `jsr:` specifiers nor a Deno import map, so a
> scaffolded Workers project emits `package.json` (npm-compat `@jsr/…` dependencies, `wrangler`
> pinned in `devDependencies`, and `dev`/`deploy` scripts) plus `.npmrc`, and
> `npm install && npx wrangler dev` works as printed. The Deno target does NOT get one: it resolves
> through the import map, and a `package.json` switches Deno to node_modules resolution.

**The decorator-free way to serve HTTP is `setu generate route`.** It emits
`register<Name>Routes(router: IRouterApi)` and is ungated, so it works in a project with no plugins
at all — and it is wired on every host, including the no-template one. `g controller` and `g module`
stay gated on `@setu-ts/decorator-plugin` (they emit `@Controller`, so an ungated project would get
source whose own import cannot resolve), and their refusal names `g route` as the alternative:

```
The "controller" schematic requires @setu-ts/decorator-plugin, which is not installed in /path/to/app.
Install it, then run this command again.
Or run `setu generate route user-profile` — it registers handlers on the router API, so it needs no decorators.
```

### Monorepo workspaces

A Setu workspace is one repository holding several deployable services, each its own scaffolded
project under `apps/`. The root is a **Deno workspace** by default and an **npm workspace** under
`--runtime node|bun`; see [Node and Bun workspaces](#node-and-bun-workspaces) for what that changes.

```bash
setu new acme --workspace                                  # the root: deno.json + setu.workspace.json
cd acme
setu generate app orders --template microservice           # apps/orders, port 3000
setu generate app billing --template microservice          # apps/billing, port 3001
deno task dev                                              # dependency-aware startup, gated by /ready
```

The root manifest declares members by **glob** — `"workspace": ["./apps/*"]` in `deno.json`, or
`"workspaces": ["apps/*"]` in `package.json` on the npm arm — so adding one creates a directory and
rewrites nothing. Framework packages are pinned in each MEMBER's own manifest, never at the root:
`setu generate` detects installed plugins by reading one directory's manifest and never walks up, so
root-only pins would make every gated schematic refuse inside a member. Members' dependencies
resolve independently, so two members may install different plugin sets.

**Adding a service registers it with its callers.** Every member carries a CLI-owned
`src/discovery/services.ts` that is regenerated for all members on each `setu generate app`:

```typescript
/** The port this workspace member binds. */
export const SERVICE_PORT = 3000;

/** Every OTHER member of this workspace, by service name. */
export const SERVICE_ENDPOINTS = {
  'billing': [{
    host: Deno.env.get('BILLING_HOST') ?? '127.0.0.1',
    port: 3001,
  }],
};
```

The member's `main.ts` binds `SERVICE_PORT` and — when its template installs
`@setu-ts/service-discovery-plugin` — its `setu.config.ts` passes `SERVICE_ENDPOINTS` to
`ServiceDiscoveryPlugin({ provider: 'static', services: SERVICE_ENDPOINTS })`; the full-stack
factory passes the same typed option through its starter composition. So the port a member binds and
the port its siblings dial are the same datum, and `discovery.resolveUrl('billing')` works from any
sibling with no configuration. A member without that plugin is still listed in every other member's
map; being reachable and consuming the map are separate properties.

That module is `managed`: the CLI rewrites it and a hand edit is lost. The data it is rendered from
is `setu.workspace.json` at the root, which records each member's name, port, and optional
`dependsOn` list — edit a port there and the next `setu generate app` rewrites every module from it.
`setu workspace ports --reallocate` instead assigns currently bindable ports and rewrites all
managed maps and deployment artifacts in one operation.

`deno task dev` (or the Node/Bun equivalent) reads that dependency metadata at runtime. It starts a
prerequisite first, waits until `http://127.0.0.1:<port>/ready` succeeds, then starts each
dependent; it names a cycle or readiness timeout and terminates children on failure or shutdown. A
discovery map does not imply a startup dependency, so only services declared with `--depends-on` are
gated.

> **Each sibling's host is overridable** — `<MEMBER>_HOST` — and the fallback is the local address.
> Both halves matter: `deno task dev` on one machine needs loopback, and inside a container loopback
> is the container ITSELF, so a fixed value would have every member dial itself on its sibling's
> port. The generated Compose stack and Kubernetes objects set those variables to the service names.
>
> **It is still only a LOCAL topology.** A deployed one comes from a real discovery backend
> (`provider: 'consul'`, `'kubernetes'`, `'dns'`), not from this file.

#### Container and Kubernetes artifacts

`generate app` also writes, and regenerates for the whole workspace on every member:

| Path                  | What it is                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/Dockerfile`   | One parameterized image for every member: `docker build -f docker/Dockerfile --build-arg MEMBER=orders -t orders:dev .` The context is the workspace root, and every `libs/` member is copied in — a service that imports a shared library cannot otherwise resolve it. |
| `.dockerignore`       | At the workspace ROOT, which is where Docker reads it — one under `docker/` is read by nothing. Keeps `.git` and every `node_modules` out of the context, so the host's copy is never laid over the one the image installed.                                            |
| `docker/compose.yaml` | Every member plus the transport's backing service, with each member's allocated port published and its siblings' hosts set to their service names.                                                                                                                      |
| `k8s/members.yaml`    | A Deployment and a Service per member. `${NAMESPACE}` and `${WORKSPACE}` are placeholders — pipe it through `envsubst`.                                                                                                                                                 |

All are `managed`, for the same reason the discovery modules are: a stack that names two of three
members is worse than none. M39 owns this repository's OWN deployment objects; these are the
generated project's.

The images and objects carry M39's cluster findings rather than defaults — a numeric `runAsUser`
(`runAsNonRoot` refuses a named one, and only under Kubernetes), `/tmp` as the only mount (an
emptyDir over the module cache masks the cache baked in at build time), a pinned namespace, and a
`terminationGracePeriodSeconds` that is real only because the generated entry installs a SIGTERM
handler. Probes are `tcpSocket`, because `/live` and `/ready` exist only when a member registers
`HealthPlugin`. No Ingress is generated: which controller, host and issuer are cluster decisions,
and a guessed Ingress routes nothing.

| Refusal                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generate app` outside a workspace                  | No `setu.workspace.json` in the target directory. Exits `1` naming `setu new <name> --workspace`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A member name already in use                        | Exits `1` naming the directory it already has. The `managed` exemption covers regenerated modules only, never a member's own source.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--runtime cloudflare-workers`                      | `deno`, `node` and `bun` all host a workspace; Workers does not, and that is a topology difference rather than a missing profile — each Worker is its own deploy unit with its own `wrangler.toml`, so several in one repository are several deployments, not members sharing a root manifest and a lockfile. Exits `2` naming `setu new <name> --runtime <target>` for a standalone project.                                                                                                                                                                                  |
| `--template full-stack` on a broker transport       | That template composes its curated plugin set through a starter factory, so a broker's `MessagingPlugin` rewrite cannot be applied without silently leaving the starter default in place. The command refuses it rather than scaffolding a member that reaches nobody. `grpc` is supported: its `GrpcPlugin({ basePath: '/grpc' })` contribution is registered after the starter factory returns, and the generated form-CSRF policy exempts that RPC prefix only. `http`, `grpc`, and `memory` are allowed; the root gains `nodeModulesDir` when the frontend member arrives. |
| `generate app --port` on a taken port               | Two members on one port cannot both bind, while every sibling's map names both — so one name would resolve to the other service. Exits `1` naming the member that holds it. A free port is honoured, and allocation still derives from the highest in use, so a hand-picked port moves the ceiling rather than being reused.                                                                                                                                                                                                                                                   |
| `new --workspace --di`                              | The independent DI switch is retired. Exits `2` directing the caller to `--template class-based`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A port in `setu.workspace.json` outside `1`–`65535` | Refused on read, naming the value and the field. Every port there is written into a member's entry point AND into every sibling's map, so one bad number breaks the workspace: `app.start()` throws `Invalid port (out of range)`, and `0` is worse still — it binds an arbitrary free port, so the member looks healthy while every sibling is refused. Exits `1`.                                                                                                                                                                                                            |
| A workspace with no port left                       | `basePort` and its members reach `65535`. Exits `1` rather than allocating `65536`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

#### Inter-service transport

The workspace decides how its services reach each other, because members can only meet on a bus they
share — a per-member choice would make a workspace whose services silently cannot talk expressible
in one flag. `generate app` therefore refuses `--transport` and names the workspace flag.

| `--transport`                 | What every member gets                                                                                                                                                                                            | Proven by                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `http` (default)              | Nothing extra. Members call each other at `discovery.resolveUrl(name)`.                                                                                                                                           | Three members, one calling both peers, asserting `200` and the body.                                                       |
| `grpc`                        | `GrpcPlugin({ basePath: '/grpc' })`, co-serving Connect/gRPC on the member's own port alongside HTTP. The full-stack template exempts this protocol prefix from form CSRF, leaving its own form routes protected. | Three members, one calling both peers at `/grpc/grpc.health.v1.Health/Check`, asserting the decoded `SERVING`.             |
| `memory`                      | The messaging plugin's own in-process default, named rather than implied. **Messages never leave the process.**                                                                                                   | —                                                                                                                          |
| `redis`                       | `MessagingPlugin({ broker: 'redis-streams', url })`                                                                                                                                                               | A real Redis: one service publishes, another receives the payload. Swapping to `memory` makes that test fail.              |
| `rabbitmq` / `nats` / `kafka` | The matching `MessagingPlugin` arm.                                                                                                                                                                               | Type-checked in the generated project against the plugin's discriminated union; not run in CI, which holds no such broker. |
| `pubsub`                      | `MessagingPlugin({ broker: 'pubsub', projectId })`, the project id read from `PUBSUB_PROJECT_ID`.                                                                                                                 | Two generated members over the real Pub/Sub emulator: one publishes, the other receives the payload.                       |
| `service-bus`                 | `MessagingPlugin({ broker: 'service-bus', connectionString })`, read from `SERVICE_BUS_CONNECTION_STRING`.                                                                                                        | Two generated members over Microsoft's emulator, started from the generated compose file and its generated entity config.  |

> **There is no raw-TCP transport, and `--transport tcp` says so** rather than quietly handing back
> HTTP under another name. Every inter-service path here is HTTP over TCP or a broker client over
> TCP.

**Every transport with a connection value reads it from the environment**, with the local address as
the baked fallback: `Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379'`. One mechanism, because
a literal endpoint is unreachable from inside a container — the Compose stack and the Kubernetes
objects override the variable with the broker's service name.

`--transport-url` replaces that fallback for the endpoint-shaped arms. It is **refused** for
`pubsub` and `service-bus`, naming the variable instead: a GCP project id is not a URL, and an Azure
connection string carries a shared-access key, which is not something to write into a file you
commit. Their fallbacks are the vendors' own local-emulator settings, which is what lets an emulator
workspace run with no configuration at all. Two operational facts they carry, because a developer
cannot guess either: Pub/Sub does **not** create topics (`publish` posts to an existing one), and
the Service Bus emulator creates **no entities at run time** — every topic must be declared in the
generated `docker/servicebus-config.json` with a `messaging-consumers` subscription before it
starts.

**Serving your own gRPC services needs descriptors, and the toolchain to build them ships.**
`--transport grpc` makes every member a Connect server immediately, which is why the health service
answers with no configuration. A service of your own needs a Protobuf-ES descriptor, which only a
compiler can produce — so each member gets an example `proto/`, both `buf` manifests, and:

```bash
deno task proto:gen      # descriptors land in src/gen/
```

Nothing needs `buf` or `protoc` on your PATH: both the compiler and the codegen plugin run through
Deno's npm compatibility, and the member's import map carries `@bufbuild/protobuf` so the generated
file compiles. Hand the descriptor to `grpc.addService(definition, implementation)`.

#### Node and Bun workspaces

A workspace targets the toolchain you name, because the framework's own claim is runtime
independence and only the MONOREPO was Deno-only:

```bash
setu new acme --workspace --runtime node    # or bun, or deno (the default)
```

The runtime is recorded in `setu.workspace.json` and every later command reads it back. It is a
WORKSPACE-wide choice, like the transport and for a stronger reason: members share one root manifest
and one lockfile, so `generate app --runtime` is refused when it disagrees with the workspace — a
Node member inside a Deno workspace is not a member at all. An absent field means `deno`, so every
workspace created before this keeps its shape.

|                                      | `deno`                  | `node`                      | `bun`           |
| ------------------------------------ | ----------------------- | --------------------------- | --------------- |
| Root manifest                        | `deno.json` `workspace` | `package.json` `workspaces` | same as `node`  |
| Install                              | `deno install`          | `npm install`               | `bun install`   |
| Run every member                     | `deno task dev`         | `npm run dev`               | `npm run dev`   |
| Environment read in generated source | `Deno.env.get(x)`       | `process.env.X`             | `process.env.X` |
| Library test runner                  | `@std/testing`          | `node:test`                 | `bun test`      |
| Image                                | `denoland/deno`         | `node:24-alpine`            | `oven/bun`      |

Three facts were measured, and each shaped the result. **Bun needs no root shape of its own** — it
reads npm `workspaces` — but it installs into each MEMBER's `node_modules` as well as the root, so
the generated ignore file and image account for both. **A workspace-root `.npmrc` maps the `@jsr`
scope** for every member, and without it not one framework package resolves. And **a sibling library
resolves by its package name** under npm exactly as it does under Deno, so libraries needed no
per-runtime design beyond their manifest.

**Cloudflare Workers is refused as a workspace target**, with the reason: each Worker is its own
deploy unit with its own `wrangler.toml`, so several in one repository are several deployments
rather than members of one.

#### Shared libraries

Code two services both need is a workspace member of its own:

```bash
setu generate library shared          # libs/shared, importable as @acme/shared
```

It needs **no wiring at all**, and that is a property of the workspace rather than a convenience: a
member declaring `name` and `exports` is importable by every sibling under exactly that name, with
no import-map entry anywhere. It holds on both arms, which is why libraries need no per-runtime
design — under Deno the workspace resolves the member directly, and under npm the symlinks the
install creates in the root `node_modules` do the same.

```typescript
import { shared } from '@acme/shared';
```

The scope defaults to the workspace directory name and `--scope` overrides it. Nothing is recorded
in `setu.workspace.json`: a library has no port and is not a service, so it must never appear in a
discovery map or in the Compose stack, and the directory plus the root's `./libs/*` glob already are
the record. A workspace created before libraries existed has that glob added to its root; anything
else about the root is left alone.

#### Converting an existing project

```bash
cd my-service
setu adopt --port 4000     # my-service becomes a workspace holding apps/my-service
```

It moves **only files this CLI emits**, from the renderer's own list rather than a directory walk.
That is a correctness property: a workspace has one lockfile and one history, both at the top, so
`.git`, CI configuration, `deno.lock` and `node_modules` stay at the root. Anything else you added
there stays too.

Because `IFileSystem` has no rename, each move is **copy → verify → delete**, in that order: a
failure part-way leaves the file in both places, which is recoverable and reported, rather than in
neither. The member's entry is rewritten to bind its allocated port; if it no longer carries the
literal this replaces, the two lines to change are printed instead of guessed at.

| Refusal                                   | Why                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| A directory that is already a workspace   | `setu.workspace.json` exists. Exits `1` naming `generate app`.                               |
| A directory with no `setu.config.ts`      | Not a Setu project: there is no application factory to become the member's. Exits `1`.       |
| A `--name` that cannot form an identifier | Exits `2`. The default comes from the directory name, so this is reachable without the flag. |

### Plugin gating

`setu generate` reads the target project's `deno.json` `imports` (falling back to `package.json`
`dependencies` + `devDependencies`) to learn which `@setu-ts` packages are installed. It never
imports or boots the project. A schematic whose backing plugin is absent is refused with exit code
`1`, naming the package to install, and `setu generate --help` marks it unavailable.

### Overwrite protection

A generate that would overwrite any existing file writes NOTHING at all — every planned path is
checked before the first write, so a multi-file schematic can never leave a half-written tree.

The one exception is a **managed file**: a path the CLI generated itself and regenerates, declared
by the schematic as `GeneratedFile.managed`. Managed paths are exempt from the check and rewritten
in place; every other path keeps the refusal above, including within the same command. The exemption
is per file rather than a `--force` flag, so a mistyped `setu g service user` can never clobber
hand-written work.

The managed files are the CLI-owned **seam barrels** — one `index.ts` per generated family
(`src/modules/`, `src/controllers/`, `src/services/`, `src/middleware/`, `src/plugins/`,
`src/health/`, `src/metrics/`, `src/cqrs/`, `src/events/`). Nothing else is managed, and no flag can
make it so.

### Generated code is wired

Every artifact below reaches its registration site with **no edit to a file you own**. A wired
schematic emits its artifact plus its family's seam barrel; the barrel is regenerated from a scan of
its directory, and the scaffolded `setu.config.ts` already imports it. Three artifacts have no
registration site, and the reason is recorded rather than left to discovery.

| Schematic          | Emitted at                                                                                                                          | Registration site                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `module`           | `src/modules/<name>/`                                                                                                               | `DecoratorPlugin({ controllers, services })` via `MODULE_*`          |
| `controller`       | `src/controllers/<name>.controller.ts`                                                                                              | `DecoratorPlugin({ controllers })` via `APP_CONTROLLERS`             |
| `service`          | `src/services/<name>.service.ts`                                                                                                    | `DecoratorPlugin({ services })` via `APP_SERVICES` — see below       |
| `route`            | `src/controllers/<name>.routes.ts`                                                                                                  | `registerGeneratedRoutes(app.router, app.services)` in `createApp()` |
| `sse`              | `src/controllers/<name>.controller.ts`, plus `src/hooks/use-<name>.ts` ONLY when `react-router-plugin` and `sdk` are both installed | HTTP registrar; the hook, when emitted, remains application-local    |
| `ws-route`         | `src/plugins/<name>.plugin.ts`                                                                                                      | `...GENERATED_PLUGINS` in `createApplication({ plugins })`           |
| `middleware`       | `src/middleware/<name>.middleware.ts`                                                                                               | `app.middleware.add(...)` over `GENERATED_MIDDLEWARE`                |
| `plugin`           | `src/plugins/<name>.plugin.ts`                                                                                                      | `...GENERATED_PLUGINS` in `createApplication({ plugins })`           |
| `health-indicator` | `src/health/<name>.indicator.ts`                                                                                                    | `HealthPlugin({ indicators: [...HEALTH_INDICATORS] })`               |
| `metric`           | `src/metrics/<name>.metric.ts`                                                                                                      | `MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })`              |
| `command-handler`  | `src/cqrs/<name>.command-handler.ts`                                                                                                | `CqrsPlugin({ commandHandlers: COMMAND_HANDLERS })`                  |
| `query-handler`    | `src/cqrs/<name>.query-handler.ts`                                                                                                  | `CqrsPlugin({ queryHandlers: QUERY_HANDLERS })`                      |
| `event-handler`    | `src/events/<name>.event-handler.ts`                                                                                                | `EventsPlugin({ handlers: EVENT_HANDLERS })`                         |
| `guard`            | `src/guards/<name>.guard.ts`                                                                                                        | **None** — per route, by design (see below)                          |
| `job`              | `src/jobs/<name>.job.ts`                                                                                                            | **None** — the transport is your choice (see below)                  |
| `migration`        | `src/migrations/<stamp>-<name>.ts`                                                                                                  | **None** — the framework ships no migration runner                   |

Notes on the three that are not wired, and one that is conditional:

- **`guard` is applied per route**, with
  `app.router.get(path, { handler, middleware: [requireX()] })` or `@UseGuards(requireX())` on a
  controller or handler. `auth-plugin` publishes no guard list, and the only barrel-shaped
  alternative — the global pipeline — would answer `401` for `/health`, `/metrics` and every public
  route, because the emitted guard rejects a request with no `ctx.request.user`. A wiring that must
  not be applied is not a wiring.
- **`job` is transport-agnostic on purpose.** Registering it as a queue processor would start a
  worker loop polling for a job name nothing enqueues; scheduling it needs a cron expression the
  artifact does not carry. `QueuePluginOptions.processors` can express a chosen queue registration,
  but cannot infer which transport or scheduling details this artifact needs. The emitted JSDoc
  shows both calls; pick one.
- **`migration` has no consumer.** No plugin registers a CLI command, so there is no
  `setu db:migrate` and nothing reads migration files. Apply them from your own script or your ORM's
  tooling.
- **`service` is shaped on the detected plugin set.** With `@setu-ts/decorator-plugin` installed it
  emits `@Injectable({ token: '<name>-service' })` plus the barrel entry, so the class resolves from
  `services.get('<name>-service')` (or the DI container, when `DiPlugin` is registered). Without
  that package it emits a plain class and no barrel — the schematic stays **ungated**, so it keeps
  working in a project with no plugins at all.

Two artifacts cannot share a name, and `generate` refuses (exit `1`) rather than producing something
broken:

- **`route`, `controller` and `module`** all mount `/<name>`. The kernel's router keys routes by
  method and path, so a duplicate silently overwrites and one artifact becomes unreachable.
- **`service` and `module`** both register `@Injectable({ token: '<name>-service' })`. The decorator
  plugin keeps the first class registered under a token, so the wrong service would be injected.

Both checks apply only when `decorator-plugin` is installed, since neither collision can exist
without it. A repeat generate of the _same_ schematic is the ordinary overwrite refusal instead.

A project scaffolded before a seam existed has no import of its barrel. Each barrel's header states
the exact lines to add to `setu.config.ts`; add them once and every later generate is wired. The
`rest`, `microservice` and `class-based` templates emit every applicable seam from scaffold time, so
a new project is wired before anything is generated — and so does the **no-template path**, for the
three seams that need no plugin (`route`, `middleware`, `plugin`). `--template full-stack` is
deliberately not a host: its layering is `routes → features → services`, it composes through a
starter factory, and its `createApp` has no plugin array to spread into.

**Artifacts generated before their family gained a second export are skipped, and reported.** A
barrel imports specific symbols from each artifact, and two families gained one in this release:
`middleware` now exports a `<SCREAMING>_MIDDLEWARE_PRIORITY` constant and `metric` a
`<SCREAMING>_METRIC` declaration. An artifact generated earlier has the right filename and lacks
that export, so listing it would put an unresolvable import in the barrel. The scan admits a file
only when it exports everything the barrel will name, and prints what it left out:

```
Skipped src/middleware/audit-log.middleware.ts: it does not export
  AUDIT_LOG_MIDDLEWARE_PRIORITY, so it cannot be listed in the generated barrel.
  Regenerate it to bring it up to date.
```

Delete and regenerate the artifact to bring it back in. The same rule keeps a hand-written module in
a scanned directory out of the barrel — the flat-family form of the precondition that admits a
`src/modules/` directory only when it holds both canonical files. Export detection reads the source
text rather than parsing it (this package has no TypeScript parser), so a declaration
(`export const X`) and a named re-export (`export { y as X }`) are recognized while an aliased
default export is not; an undetected export means the artifact is skipped and reported, never that a
broken barrel is written.

Which seams a host carries depends on which plugins it registers: the no-template path carries the
three that need none (`src/controllers/`, `src/middleware/`, `src/plugins/`), the functional
templates carry only the seams their plugins consume, and `class-based` additionally carries
controller, service and module barrels. `microservice` additionally carries `src/cqrs/` and
`src/events/`, because it is the only template registering `CqrsPlugin` and `EventsPlugin`.

### Domain modules

`setu generate module <name>` is the aggregate schematic, and it is **ungated** — it runs in every
project shape, including one scaffolded with no template. Which of two file sets it emits is decided
by whether `@setu-ts/decorator-plugin` is installed.

Functional (the default composition):

```
src/modules/<name>/<name>.service.ts        export function list<Name>()
src/modules/<name>/<name>.service.test.ts   describe/it + expect (runnable — see below)
src/modules/<name>/index.ts                 the module's own re-exports
src/controllers/<name>.routes.ts            register<Name>Routes — GET / and POST / (201)
src/controllers/index.ts                    the HTTP barrel       (managed — regenerated)
```

The route module registers through the same seam `setu generate route` uses, so the module answers
`GET /<name>` and `POST /<name>` with no edit to `setu.config.ts`. Because both write
`src/controllers/<name>.routes.ts`, a `route` and a `module` sharing one name is refused by the
ordinary overwrite check.

Class-based (`--template class-based`, or any project holding `decorator-plugin`):

```
src/modules/<name>/<name>.service.ts        @Injectable, token '<name>-service'
src/modules/<name>/<name>.controller.ts     @Controller('/<name>'), class-level @Inject, @Params(…, Ctx())
src/modules/<name>/<name>.service.test.ts   describe/it + expect (runnable — see below)
src/modules/<name>/index.ts                 the module's own re-exports
src/modules/index.ts                        the aggregate barrel  (managed — regenerated)
```

The aggregate barrel exports `MODULE_CONTROLLERS` and `MODULE_SERVICES`, and the `class-based`
template scaffolds a `setu.config.ts` that already imports both and passes them to
`DecoratorPlugin`:

```typescript
import { MODULE_CONTROLLERS, MODULE_SERVICES } from './src/modules/index.ts';

DecoratorPlugin({ controllers: [...MODULE_CONTROLLERS], services: [...MODULE_SERVICES] });
```

So generating a module changes only files the CLI owns. Regenerating over an existing module still
refuses on that module's own files; the barrel is rewritten either way and lists each module once.

A project scaffolded before this schematic existed has no barrel import — add the two lines above to
its `setu.config.ts` once, and every later `setu g module` is wired automatically.
`--template
full-stack` is deliberately not a host: its layering is `routes → features → services`
and it has no `src/modules/` concept.

A host template declares `@std/testing` and `@std/expect` so the emitted test runs with no further
setup — as a `deno.json` import on Deno and Cloudflare Workers, and as an `npm:@jsr/std__*` alias in
`devDependencies` on Node and Bun, which get a `package.json` and no `deno.json`. Only a directory
holding both `<name>.controller.ts` and `<name>.service.ts` is treated as a module, so unrelated
folders under `src/modules/` (a shared-helpers directory, say) are left out of the barrel rather
than breaking it.

The emitted controller's handlers take **only the arguments their `@Params(...)` names** and return
plain values, which the plugin serializes as JSON. That is a constraint of `DecoratorPlugin`, not a
style choice: it builds a handler's argument list from that declaration alone and never passes the
request context positionally, so an undeclared `ctx: IRequestContext` parameter arrives `undefined`
and the first `ctx.response` throws — a 500 on every request. A handler that needs the context (to
set a status code, or to stream) declares `Ctx()` among its sources, which is how the generated
`create` answers `201`.

The service's `@Injectable` token is explicit (`'<name>-service'`) and the controller's `@Inject`
names that exact string, because `emitDecoratorMetadata` is unavailable under Deno, so a parameter's
type cannot be read. The module works with and without `DiPlugin`: with a container the service is
constructed through it, without one it resolves from the kernel's service registry.

### Project templates

`setu new` always emits a `setu.config.ts` exporting `createApp()` — one place the project's plugin
list lives. `main.ts` imports it to start the server, and `setu` imports it to discover plugin
commands, so the two can never disagree. The factory deliberately does NOT start the application.

```typescript
// setu.config.ts (--template rest)
import { createApplication } from '@setu-ts/kernel';
import type { IApplication } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
// … logging, validation, security, health, metrics, OpenAPI, decorators
import { errorHandler } from '@setu-ts/exceptions';

export function createApp(): IApplication {
  const app = createApplication({
    plugins: [RuntimePlugin(), ConfigPlugin({ envFilePath: '.env', envFileOptional: true })],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }));
  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));
  return app;
}
```

| Template       | Plugin set                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| _(none)_       | `RuntimePlugin` only.                                                                                      |
| `rest`         | Runtime, Config, Logger, Validation, HttpSecurity, Health, Metrics, OpenApi + RFC 9457 `errorHandler()`.   |
| `microservice` | `rest` plus Messaging, Queue, Resilience, Telemetry, ServiceDiscovery (`'static'` arm), Cqrs, Events.      |
| `class-based`  | `rest` plus `DecoratorPlugin` and `DiPlugin`, an `@Injectable` service, and a `@Controller`.               |
| `full-stack`   | A React Router 8 SSR app: the full plugin set via `createFullStackAppFromConfig`, plus an `app/` skeleton. |

Three of the four templates emit **inline wiring**, not imports of the `@setu-ts/*-starter`
packages, so a scaffolded project owns an explicit, editable plugin list. `full-stack` is the
exception, with cause: its composition is twenty-two plugins, and a generated file a human is meant
to open and edit should not begin with twenty-two imports they did not choose. A general `--starter`
flag for the other three is still deferred (see "Not in this release").

### `--template full-stack`

```typescript
// setu.config.ts (--template full-stack)
import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';
import type { IApplication } from '@setu-ts/common';
import { getCsrfToken, getSession } from '@setu-ts/session-plugin';
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

- **The generated factory is `async`.** `setu` awaits it during command discovery, and `main.ts`
  awaits it too, so nothing else changes.
- **No hello-world route.** An exact `/` handler takes precedence over the SSR catch-all under the
  M70g specificity rule (a wildcard ranks below any route naming its path, in either registration
  order), so it would shadow the application's own index route.
- **Every runtime target is supported.** Cloudflare Workers omits `assetsDir` and `envFilePath`:
  with no filesystem the asset handler would answer 404 for every asset, and a dotenv path would
  make ConfigPlugin throw. Static assets come from the platform binding and configuration from the
  request `env` binding.
- **The frontend build runs on npm even when the server runs on Deno** — the one documented
  exception to the Deno-only toolchain. Deno and Workers targets get a standalone `package.json` for
  Vite and React Router; Node and Bun targets get those dev dependencies merged into the
  `package.json` they already have. The Deno `start` task additionally carries `--allow-read`, which
  the SSR plugin needs to import its own server build and read client assets.
- **React Router is pinned to v8**, matching the `npm:react-router@8` the SSR plugin imports.

The `class-based` template additionally emits `src/greeting-service.ts` and
`src/greeting-controller.ts`, and its `setu.config.ts` imports both to pass them to
`DecoratorPlugin({ controllers, services })`. It supports every runtime target. On Cloudflare
Workers, the microservice template swaps its socket-bound messaging and queue plugins for the
platform implementation.

### Plugin-contributed commands

A plugin publishes commands with `ctx.cli.register(name, handler)`; the CLI discovers them by
loading `setu.config.ts` and starting the application with **no port**, so registration happens
without binding a socket. The application is always stopped afterwards, including when a handler
throws.

```bash
setu commands          # list what this application's plugins provide
setu db:migrate up 3   # positionals after the name reach the handler
```

Handlers receive positionals only. `setu` consumes its own flags, so pass a plugin command's flags
after `--`:

```bash
setu db:migrate -- --verbose --dry
```

Built-in verbs (`new`, `n`, `generate`, `g`, `commands`, `help`) are matched **first** and always
win, so a plugin cannot shadow them — and those paths never import your project. Only an unmatched
first positional triggers a boot.

Two plugins registering the same command name is an error (`1`) that runs neither: which
registration wins would otherwise depend on plugin load order.

### Generated plugin example

```bash
setu g plugin my-plugin
```

Generates `src/plugins/my-plugin.plugin.ts` plus the managed `src/plugins/index.ts` barrel that
registers it. The `.plugin.ts` suffix is what lets the barrel be regenerated from a directory scan
without admitting a module you hand-wrote in the same folder:

```typescript
import { createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';

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

`setu generate custom <schematic> <name>` resolves `.setu-ts/schematics/<schematic>.ts` and loads it
with a real dynamic `import()`. The module must export a `schematic` function (or a default export
that is a function):

```typescript
// .setu-ts/schematics/readme.ts
import type { DerivedNames, GeneratedFile, SchematicOptions } from '@setu-ts/cli';

export function schematic(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  return [{ path: `docs/${names.kebab}.md`, contents: `# ${names.pascal}\n` }];
}
```

`DerivedNames` carries `raw`, `kebab`, `camel`, `pascal`, and `screaming`. `SchematicOptions`
carries the target `runtime`, the detected `plugins` set, `now()` — an injected clock, so
timestamped output stays deterministic — and `modules?`, the domain modules already present under
`src/modules/`. Schematics perform no I/O; the command layer gathers the project state they need and
writes what they return, which is what makes `--dry-run` exact.

`modules` is optional so that a harness written before it existed still compiles; `setu generate`
always supplies it. `GeneratedFile` carries an optional `managed` flag — see "Overwrite protection".

### Programmatic API

| Export             | Kind     | Purpose                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `runCli`           | function | Runs the CLI and RETURNS an exit code; never calls `Deno.exit`.                 |
| `CliDependencies`  | type     | The `fs` / `cwd` / `now` / `log` / `error` bundle `runCli` requires.            |
| `deriveNames`      | function | Produces the five naming forms every schematic uses.                            |
| `DerivedNames`     | type     | The result of `deriveNames`.                                                    |
| `GeneratedFile`    | type     | `{ path, contents, managed? }` — one file a schematic asks to create.           |
| `Schematic`        | type     | `(names, options) => readonly GeneratedFile[]`.                                 |
| `SchematicOptions` | type     | The second parameter of every schematic (`runtime`/`plugins`/`now`/`modules?`). |
| `PROGRAM_NAME`     | const    | `'setu'` — interpolated into every usage string.                                |
| `TemplateName`     | type     | The `--template` value union, for callers building argv programmatically.       |
| `ModuleLoader`     | type     | The seam a custom schematic module is loaded through.                           |
| `AppLoader`        | type     | The seam `setu.config.ts` is loaded through (`CliDependencies.loadApp`).        |
| `detectPlugins`    | function | Reads a project manifest and returns the installed `@setu-ts` names.            |

`CliDependencies` has no default: `src/main.ts` owns the process boundary (`Deno.args`,
`Deno.cwd()`, `console`, the real filesystem, and the single `Deno.exit`), so every other path is
testable without terminating the runner.

### Not in this release

- **Starter-backed scaffolding.** `--template` emits inline wiring. A `setu new --starter` path that
  scaffolds a project importing `createRestApp` and friends is deferred — the starters themselves
  shipped in Milestone 36 and can be depended on directly.
- **Flags for plugin commands.** `CliCommandHandler` receives positionals only; giving handlers a
  parsed flag record would widen a committed `common` contract. Forward flags with `--` instead.
- **Plugin installation.** `setu` generates and dispatches; it does not edit your manifest.

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
import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';

const app = await createFullStackAppFromConfig((config) => ({
  // A Prisma v7 client is generated and constructed by the application; the
  // adapter never builds one, so `url` is not a database option.
  database: { type: 'prisma', options: { prismaClient } },
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
`setu new --template full-stack` wires this for you on all four targets.

This is why **no plugin option carries a config-key shorthand** (`urlFromConfig`,
`endpointFromConfig`): such a field would need its value at the same impossible moment.
`secretFromConfig` is further out of reach — secrets are served by `secrets-plugin` under
`CAPABILITIES.SECRETS`, which exists only after registration, so a plugin needing one resolves it
lazily at use time.

A complete REST API using the REST starter:

```typescript
import { createRestApp } from '@setu-ts/rest-starter';
import { validatedStateKey } from '@setu-ts/common';
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
    // The v7 client is generated and constructed by the application and
    // carries its own connection configuration.
    type: 'prisma',
    options: { prismaClient },
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
  // `schema.body` DOCUMENTS the route; `validateBody` is what enforces it and
  // writes validatedStateKey('body'). Declaring the schema alone leaves that key unset.
  middleware: [app.services.auth.requireAuth(), validateBody(CreateUserSchema)],
  schema: {
    body: CreateUserSchema,
    response: { 201: UserSchema, 400: z.object({ error: z.string() }) },
    tags: ['Users'],
    summary: 'Create a user',
    security: [{ bearerAuth: [] }],
  },
  handler: async (ctx) => {
    const db = ctx.services.get('database');
    const user = await db.getRepository('User').create(ctx.state.get(validatedStateKey('body')));
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
import { createMicroserviceApp } from '@setu-ts/microservice-starter';

const app = createMicroserviceApp({
  database: {
    // The v7 client is generated and constructed by the application and
    // carries its own connection configuration.
    type: 'prisma',
    options: { prismaClient },
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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { EventsPlugin } from '@setu-ts/events-plugin';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    LoggerPlugin({ level: 'info' }),
    ConfigPlugin({ validationSchema: AppConfigSchema }),
    // A Prisma v7 client is application-generated, so the adapter is handed one
    // rather than reading a connection URL of its own.
    DatabasePlugin({ type: 'prisma', options: { prismaClient } }),
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
import type { IPlugin, IPluginContext } from '@setu-ts/common';

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
import {
  ApiOperation,
  ApiTags,
  Body,
  Controller,
  CurrentUser,
  Get,
  Param,
  Params,
  Post,
  UseGuards,
} from '@setu-ts/decorator-plugin';

@Controller('/users')
@ApiTags('Users')
class UserController {
  constructor(private userService: UserService) {}

  @Get('/')
  @ApiOperation({ summary: 'List all users' })
  async list() {
    return this.userService.findAll();
  }

  @Get('/:id')
  @Params(Param('id'))
  async getById(id: string) {
    return this.userService.findById(id);
  }

  @Post('/')
  @UseGuards(requireAuth())
  @Params(Body(), CurrentUser())
  async create(body: CreateUserDto, user: User) {
    return this.userService.create(body, user.id);
  }
}
```

### Defining Custom Decorators

```typescript
import { Controller, createDecorator, Custom, Get, Params } from '@setu-ts/decorator-plugin';

// Method decorator
export const Cacheable = (ttl: number) => createDecorator('cacheable', { ttl });

// Parameter source, declared inside @Params(...)
export const CurrentTenant = () => Custom<string>('current-tenant');

// Usage
@Controller('/api')
class ApiController {
  @Get('/data')
  @Cacheable(3600)
  @Params(CurrentTenant())
  async getData(tenantId: string) {
    return this.service.getDataForTenant(tenantId);
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

## Service Discovery (`@setu-ts/service-discovery-plugin`)

Turns a logical service name into a reachable address, balances across the instances behind it, and
takes them out of rotation when callers report failures. Registers an `IServiceDiscovery` under
`CAPABILITIES.SERVICE_DISCOVERY` (`'service-discovery'`). Zero npm dependencies — the HTTP providers
run on web-standard `fetch` and the DNS provider on the optional `IRuntimeServices.dns`.

### Registration

```typescript
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

app.register(ServiceDiscoveryPlugin({
  provider: 'consul',
  address: 'http://127.0.0.1:8500',
  strategy: 'round-robin',
}));
```

### Usage

```typescript
import { CAPABILITIES, type IServiceDiscovery } from '@setu-ts/common';

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

### Health status

Since M70c the indicator composes three facts. `everResolved` is `false` until the first successful
provider read, so a backend that was never reached is `down`, not `up` (the X10-3 fix). `degraded`
means a stale cache is being served. `isHealthy()` is the live reachability probe (Consul
`/v1/status/leader`, Kubernetes a `limit=1` EndpointSlice LIST).

| Status     | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `up`       | The provider has resolved at least once and is reachable.            |
| `degraded` | A stale cache is being served, or the backend just went unreachable. |
| `down`     | The provider has never resolved and is unreachable.                  |

`data` reports
`{ provider, cachedServices, watchedServices, ejectedInstances, degraded, reachable, everResolved }`.

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
    const user = await userService.create(ctx.state.get(validatedStateKey('body')));
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
  @Params(Body())
  async create(body: CreateUserDto) {
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

Standardized error responses across the framework. `errorHandler` defaults to `format: 'default'`;
configure `format: 'rfc9457'` for the Problem Details body below.

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "User with id 123 not found",
  "instance": "/users/123"
}
```

See [API Reference: @setu-ts/exceptions](#api-reference-setu-tsexceptions) for when `type` is
`about:blank` versus a concrete problem type URI.

### IDE Support

- Full TypeScript intellisense
- JSDoc on all public APIs
- Type inference for services, config, and routes
- Auto-completion for plugin options

### Hot Reload

Setu-TS does not include a built-in dev server. Use `deno run --watch` directly:

```bash
deno run --watch main.ts
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
import { createTestApp } from '@setu-ts/testing';

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
import { createMockPlugin, createTestApp } from '@setu-ts/testing';

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

// Add database (memory adapter, zero configuration)
app.register(DatabasePlugin());

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

## API Reference: @setu-ts/common

The contract layer every other package builds on. Implemented in **Milestone 1**; this section is
the authoritative export list (AI_GUIDELINES §10.5). All exports carry full JSDoc.

### Values (runtime exports)

| Export                                 | Kind     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAPABILITIES`                         | const    | Standard capability tokens — the single source of truth. Includes `SSE: 'sse'` (SSE hub), `SSR: 'ssr'` (SSR framework), `WORKER_POOL: 'worker-pool'` (worker thread pool), `REALTIME_BACKPLANE: 'realtime-backplane'` (cross-replica fan-out), `SESSION: 'session'` (cookie sessions)                                                                                                                                                                                                                                          |
| `createCapabilityToken(name)`          | function | Validates and creates a custom (optionally dot-namespaced) token; throws `TypeError` on invalid names                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `encodeFrameData(data)`                | function | Encodes a WebSocket payload for a realtime backplane; binary becomes base64                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `decodeFrameData(payload)`             | function | Decodes a backplane payload back to `string` or `Uint8Array`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `createCachedProbe(options)`           | function | Builds a cached, coalesced, time-bounded reachability probe from `{ probe, hrtime, ttlMs?, timeoutMs?, setTimer?, clearTimer? }`. `hrtime` and the timer seam come from `IRuntimeServices` so a custom runtime's clock and timers are honoured; the timers fall back to the ambient ones. Every plugin's `isHealthy()` is built through it so a `/health` scrape cannot become load against the backend; a probe that rejects or exceeds `timeoutMs` resolves `false`                                                          |
| `parseCookie(header)`                  | function | Parses a `Cookie` header into a name→value record; percent-decodes, strips RFC 6265 quoting, first occurrence wins. Here because the session plugin and the decorator plugin's `Cookie()` source both need it and no plugin may import another                                                                                                                                                                                                                                                                                 |
| `serializeCookie(n, v, a?)`            | function | Serializes a `Set-Cookie` value; percent-encodes so a payload cannot inject attributes, and forces `Secure` alongside `SameSite=None`. Throws `TypeError` on an invalid name or a non-integer `maxAge`                                                                                                                                                                                                                                                                                                                         |
| `isWorkerReadySignal(m)`               | function | Guard: narrows a worker message to a `WorkerReadySignal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isWorkerTaskRequest(m)`               | function | Guard: narrows a worker message to a `WorkerTaskRequest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isWorkerTaskReply(m)`                 | function | Guard: narrows a worker message to a `WorkerTaskReply`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PLUGIN_PRIORITY`                      | const    | Well-known plugin priority bands (`HIGHEST`…`LOWEST`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ok(value)` / `err(error)`             | function | `Result` constructors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isOk(r)` / `isErr(r)`                 | function | `Result` type guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unwrap(r)`                            | function | Returns the `Ok` value or throws the `Err` error                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `some(value)` / `none()`               | function | `Option` constructors (`none()` returns a frozen singleton)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `isSome(o)` / `isNone(o)`              | function | `Option` type guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fromNullable(v)`                      | function | Converts `T \| null \| undefined` to `Option<T>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `serializeError(value)`                | function | Serializes any thrown value into a plain `SerializedError` (`{ name, message, stack?, cause? }`) with the `cause` chain followed to a bounded depth; a non-`Error` value yields `{ name: 'Error', message: String(value) }`. Pure — no runtime-specific APIs. Here so the logger plugin (metadata normalization), the kernel (fallback-500 logging), `exceptions`, `grpc-plugin`, and `notification-plugin` can all serialize without importing one another.                                                                   |
| `respondWithError(ctx, init)`          | function | Writes an error response through the request's published `IErrorResponder` (the application's configured format), falling back to `{ error, detail? }` when `errorHandler` has not published one. The seam that lets a package that produces error responses but may not import `@setu-ts/exceptions` answer in the configured format (M70f).                                                                                                                                                                                  |
| `ERROR_RESPONDER_STATE_KEY`            | const    | `exceptions:error-responder`, the `ctx.state` key under which `errorHandler` publishes its `IErrorResponder`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `brandErrorResponder(fn, r)`           | function | Attaches `errorHandler`'s resolved `IErrorResponder` to its middleware function under `ERROR_RESPONDER_BRAND`, so the kernel — which runs the drain `503`, the malformed-request `400`, and the request hooks BEFORE the pipeline — can read the same responder at startup (M70f re-review)                                                                                                                                                                                                                                    |
| `errorResponderOf(fn)`                 | function | Reads the brand off a middleware function, returning the attached `IErrorResponder` (or `undefined`). The kernel's only route to the resolved formatter for the pre-pipeline sites                                                                                                                                                                                                                                                                                                                                             |
| `ERROR_RESPONDER_BRAND`                | const    | A `Symbol.for` brand pairing with the two functions above; `Symbol.for` (not `Symbol()`) so two copies of the package in one process resolve the same key                                                                                                                                                                                                                                                                                                                                                                      |
| `withHttpStatusHint(error, hint)`      | function | Brands an `Error` with the status, title and caller-safe `detail` it should be answered with, and returns the same reference. `status` must be an integer in `400`–`599`; throws `TypeError` if the error is not extensible. The channel by which a package that may not import `@setu-ts/exceptions` (§2.2) states how its own error maps to a response — `@setu-ts/database-plugin` brands its three query-shape refusals `501` — where `respondWithError` cannot help because the thrower holds no `IRequestContext` (M89b) |
| `httpStatusHintOf(error)`              | function | Reads the hint back from a thrown value, or `undefined` when it carries none. Accepts `unknown`, because a `catch` binds one. `errorHandler` calls it before wrapping a non-`HttpError` into a `500`; a foreign or malformed value under the same global symbol reads as absent rather than being trusted — including a `status` that is not an integer in `400`–`599`                                                                                                                                                         |
| `HTTP_STATUS_HINT`                     | const    | `Symbol.for('setu.http.status-hint')`, the key the two functions above use. `Symbol.for` (not `Symbol()`) so two copies of the package in one process resolve the same key                                                                                                                                                                                                                                                                                                                                                     |
| `validatedStateKey(target)`            | function | Returns `` `validation-plugin:validated-${target}` `` — the `ctx.state` key under which `validation-plugin`'s middleware writes a validated value and `decorator-plugin`'s `Body()`/`Query()`/`Param()` sources read it back. Exported so two packages agree on the wire format byte-for-byte instead of each hardcoding the literal (the M47 frame-codec precedent)                                                                                                                                                           |
| `CLIENT_IP_STATE_KEY`                  | const    | `http-security-plugin:client-ip`, the cross-package key `ipSecurityMiddleware` writes and `rateLimitMiddleware` reads                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sealRequestIdentity(request)`         | function | Installs the one-implicit-write request identity guard for `user` and `tenant`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `replacePrincipal(request, principal)` | function | Deliberately replaces `request.user` after it has been guarded                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `replaceTenant(request, tenant)`       | function | Deliberately replaces `request.tenant` after it has been guarded                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `isPromiseLike(value)`                 | function | Duck-typed thenable test (M87) — see the note below the Types table                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Types

| Group               | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens              | `CapabilityToken`, `StandardCapability`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Shared types        | `HttpMethod`, `RuntimePlatform`, `LogLevel`, `LifecyclePhase`, `HealthStatus`, `MetricType`, `PluginPriority`, `JsonValue` — the recursive JSON-safe value type (M74); `SseMessage.data` is typed with it, and its object arm admits `undefined` because `JSON.stringify` drops such a key                                                                                                                                                                                                                                                                                                                                            |
| Utilities           | `Result<T, E>`, `Ok<T>`, `Err<E>`, `Option<T>`, `Some<T>`, `None`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plugin contract     | `IPlugin`, `IPluginContext`, `IApplication`, `StartOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Plugin context APIs | `IMiddlewareApi`, `MiddlewareOptions`, `IRouterApi`, `IEnvironmentApi`, `EnvVarSpec`, `IHealthApi`, `IMetricsApi`, `IOpenApiApi`, `IDecoratorApi`, `DecoratorHandler`, `ICliApi`, `CliCommandHandler`, `ILifecycleApi`, `IMetadataStore`                                                                                                                                                                                                                                                                                                                                                                                              |
| Service registry    | `IServiceRegistry`, `RegisterOptions`, `ServiceFactory<T>`, `RegistryFactory<T>`, `resolveRegistryEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| HTTP                | `IRequest`, `IResponse`, `IRequestContext`, `IMiddleware`, `MiddlewareFunction`, `NextFunction`, `RouteHandler`, `RouteDefinition`, `RouteSchema`, `SecurityRequirement`, `SECURITY_METADATA`, `RouteSecurityMetadata`, `withSecurityMetadata`, `securityMetadataOf`, `VALIDATION_METADATA`, `RouteValidationMetadata`, `withValidationMetadata`, `validationMetadataOf`, `HandlerResult`, `ResponseSnapshot`, `ResponseSnapshotInit`, `UPGRADE_INTENT`, `WebSocketUpgradeIntent`, `setUpgradeIntent`, `upgradeIntentOf`, `isWebSocketUpgradeRequest`, `HTTP_STATUS_HINT`, `HttpStatusHint`, `withHttpStatusHint`, `httpStatusHintOf` |
| Runtime             | `IRuntimeServices`, `IFileSystem`, `IHttpAdapter`, `IWorkerHost`, `IWorkerHandle`, `TimerHandle`, `ServerHandle`, `StatResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DI (optional)       | `IContainer`, `Constructor<T>`, `ServiceScope`, `Provider<T>`, `ClassProvider<T>`, `FactoryProvider<T>`, `ValueProvider<T>`, `ProviderOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Logging             | `ILogger`, `LogMetadata`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Config              | `IConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Validation          | `IValidationService`, `ValidationTarget`, `ValidationIssue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Health              | `IHealthIndicator`, `HealthIndicatorFn`, `HealthCheckResult`, `IHealthService`, `HealthReport`, `HealthStatus`, `CachedProbeOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Metrics             | `IMetric`, `MetricConfig`, `IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, `MetricOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Auth                | `IPrincipal`, `IJwtService`, `JwtSignOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Database            | `IOrmAdapter`, `ITransaction`, `IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`, `NormalizedQuery`, `OrderDirection` — the data-access port, promoted from `database-plugin` in M52c so a backend can live in another package (`cloudflare-plugin`'s `D1Adapter` is the first)                                                                                                                                                                                                                                                                                                                                                |
| Cache               | `ICacheStore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Events              | `IEventBus`, `IDomainEvent<T>`, `EventHandler<T>`, `Unsubscribe`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Messaging           | `IMessageBroker`, `ISubscription`, `MessageHandler<T>`, `MessageMetadata`, `SubscribeOptions`, `RequestOptions`, `RequestHandler<TReq, TRes>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ingress             | `IngressKind`, `IngressContext<TPayload>`, `BehaviorLike<TWork, TResult>`, `IIngressBehavior`, `composeBehaviorChain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Queue               | `IQueue`, `IJob<T>`, `JobProcessor<T>`, `AddJobOptions`, `ProcessOptions`, `RecurringOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Scheduler           | `IScheduler`, `ScheduledJob<T>`, `SchedulerJobHandler<T>`, `ScheduleOptions<T>`, `RetryOptions`, `SchedulerBackoff`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Secrets             | `ISecretManager`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Audit               | `IAuditLogger`, `AuditEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resilience          | `ICircuitBreaker`, `CircuitState`, `IResilienceService`, `WrapOptions`, `CircuitBreakerPolicy`, `RetryPolicy`, `BulkheadPolicy`, `BackoffStrategy`, `ResilientCall`, `HardenedCall`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Storage             | `IStorage`, `SignedUrlOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Mail                | `IMailer`, `MailMessage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Notifications       | `INotifier` (with optional `sendSettled?`), `NotificationMessage`, `ChannelSendResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Errors              | `IErrorResponder`, `ErrorResponseInit`, `ErrorResponderTarget`, `SerializedError` — the request-scoped error responder seam and the pure error serializer (M70f)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Feature flags       | `IFeatureFlags`, `FlagContext`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Multi-tenancy       | `IMultiTenancyService`, `ITenantRepository`, `ITenantResolver`, `ITenant`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SSR                 | `ISsrService`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SSE                 | `ISseService`, `ISseConnection`, `SseChannel`, `SseMessage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Realtime backplane  | `IRealtimeBackplane`, `RealtimeFrame`, `RealtimeFrameHandler`, `RealtimeFrameKind`, `EncodedPayload`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| WebSocket           | `IWebSocketService`, `IWebSocketConnection`, `IWebSocketTransport`, `WebSocketRoom`, `RoomBroadcastOptions`, `WebSocketHandlers`, `WebSocketRouteOptions`, `WebSocketConnectionContext`, `WebSocketCloseEvent`, `WebSocketReadyState`, `WebSocketEventSink`, `WebSocketUpgradeDecision`, `WebSocketUpgradeRouter`, `WebSocketUpgradeGuard`, `WebSocketGuardDecision`                                                                                                                                                                                                                                                                  |
| Worker pool         | `IWorkerPool`, `WorkerRunOptions`, `TaskPoolStats`, `WorkerReadySignal`, `WorkerTaskRequest`, `WorkerTaskReply`, `WorkerErrorShape`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Session             | `ISessionService`, `ISession`, `ISessionStore`, `SessionData`, `SessionView`, `CookieAttributes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Service discovery   | `IServiceDiscovery`, `ServiceInstance`, `PickOptions`, `LoadBalanceStrategy`, `ServiceOutcome`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DNS                 | `IDnsResolver`, `SrvRecord`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| gRPC                | `IGrpcService`, `GrpcServiceDefinition`, `GrpcServingStatus`, `RpcFetchHandler`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cloudflare          | `splitWorkerEnv`, `SplitWorkerEnv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**`isPromiseLike(value)`** (M87) — reports whether a value is thenable, by the duck-typed test
(`typeof value.then === 'function'`) rather than `instanceof Promise`. `@setu-ts/kernel` and
`@setu-ts/runtime` both use it on the request path to decide whether a handler result needed
awaiting. `instanceof` answers `false` for a promise from another realm and for userland promise
libraries — all of which satisfy `RouteHandler`'s declared `Promise<HandlerResult>` structurally —
and treating one as already-settled sends the response while the handler is still running. Pair it
with `Promise.resolve`, which returns a native promise unchanged and adopts a foreign thenable.

**`ResponseSnapshot.responseInit`** (M88, `@internal`) — an optional snapshot-local
`ResponseSnapshotInit` header input used only by the kernel-to-runtime response conversion. The
runtime consumes it before it reads `snapshot.headers`, allowing normal terminal responses to avoid
materializing the framework's native `Headers` object; native servers may derive headers such as
`Content-Length` from that input. Middleware and application code must continue to use the
documented live `snapshot.headers` view; snapshots with explicitly mutated or repeated headers use
that existing path unchanged.

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
- `RouteSchema.security` is documentation only — it describes an operation for the OpenAPI document
  and for client generation, and enforces nothing. Authentication is enforced by middleware and
  guards. An **empty array** declares the operation public and is not the same as omitting the
  field, which leaves it inheriting the document-level requirement.
- Declaring is not the only way a document learns about authentication. `withSecurityMetadata`
  brands a `MiddlewareFunction` with a `RouteSecurityMetadata` (`{ authenticated: boolean }`), and
  `securityMetadataOf` reads it back — the channel by which `@setu-ts/openapi-plugin` derives an
  operation's requirement from the guards `@setu-ts/auth-plugin` produced, without either package
  importing the other. `SECURITY_METADATA` is created with `Symbol.for`, so two copies of `common`
  in one process resolve the same key. The brand is symbol-keyed and non-enumerable: the
  middleware's identity and behaviour are unchanged. It carries authentication PRESENCE only — a
  role is not a security scheme, so `requireRole('admin')` brands `{ authenticated: true }` and
  nothing more.
- `withHttpStatusHint` brands an **`Error`** rather than a middleware function, and the reason it
  exists is that `respondWithError` cannot reach every site: a data source throwing from deep inside
  an adapter holds no `IRequestContext`, so its error arrives at `errorHandler` as a plain `Error`,
  is normalized to a `500`, and is masked. That is right for a driver fault and wrong for a refusal
  the caller caused. `HttpStatusHint` is an `ErrorResponseInit` whose `detail` is **required**, and
  `errorHandler` builds the response from the hint's own `status`/`title`/`detail` — never from the
  error's `message`, which is the operator-facing diagnostic and stays log-only. Both entry points
  construct the response through one implementation, so a hinted throw and a `respondWithError` call
  carrying the same values answer byte-identically under every configured format. A hinted error is
  exempt from `maskInternalErrors`, and the exemption is narrow by construction rather than by
  trust: what it serves is a fixed sentence the brand site wrote, so there is no driver diagnostic
  in the body for masking to remove. A brand on a deliberately thrown `HttpError` is ignored — that
  error already states its own status.

  `status` must be an **integer in `400`–`599`**, and a hint outside that range is treated as ABSENT
  so the error takes the ordinary masked-`500` path. Two reasons, and the second is why the floor is
  `400` rather than `200`: the web `Response` constructor throws `RangeError` outside `[200, 599]`,
  so an unserveable status would make the error handler itself the fault — a throw escaping the one
  `catch` that exists to contain throws — and a hint says how an ERROR is answered, which is never a
  success or a redirect. This is deliberately stricter than the `ErrorResponseInit` it extends:
  `respondWithError` takes its status from a literal at the call site, visible in review, while a
  brand travels from another package inside an error.
- `withValidationMetadata` brands a `MiddlewareFunction` with a `RouteValidationMetadata`
  (`{ target: ValidationTarget; schema: unknown }`), and `validationMetadataOf` reads it back — the
  same mechanism, for the same reason, applied to request shape rather than authentication. Every
  helper `@setu-ts/validation-plugin` ships carries it, as does
  `IValidationService.middleware(schema, target)`, and `@setu-ts/openapi-plugin` reads it to fill an
  operation's `requestBody` and `parameters`. `VALIDATION_METADATA` is created with `Symbol.for` for
  the same cross-copy reason, the brand is symbol-keyed and non-enumerable, and the `schema` travels
  by REFERENCE — a reader transforms it with whatever schema support it has, and identity is what
  the OpenAPI generator's deduplication keys on. A foreign value under the same global symbol reads
  as absent rather than being trusted.
- `IRequest.raw?: Request` and `IRequestContext.raw?: Request` carry the **undisturbed** web
  `Request` the HTTP adapter received, alongside the mapped framework request whose body has already
  been buffered. The kernel terminal handler reads it to decide a WebSocket upgrade (which needs the
  native request) and to reconstruct a gRPC request. **Optional**, on the M42 `signal?` / M44 `fs?`
  precedent: a custom adapter may omit it, and the terminal handler then treats the request as
  neither an upgrade nor RPC and falls through to the `404` — it never throws. `inject()` populates
  it, so an injected request can exercise both paths. Added in Milestone 70a.
- `setUpgradeIntent(request, intent)` brands an `IRequest` with a `WebSocketUpgradeIntent`
  (`{ sink, protocol? }`) and `upgradeIntentOf(request)` reads it back, under the `UPGRADE_INTENT`
  symbol. This is how the kernel tells the HTTP adapter "the pipeline ran, nothing short-circuited,
  perform the handshake". The `IRequest` is the channel rather than `IRequestContext.state` because
  the adapter holds the former and **never sees the context** — the kernel builds and discards it
  internally, so nothing written to `ctx.state` could reach the adapter. `UPGRADE_INTENT` uses
  `Symbol.for`, so two copies of `common` in one process agree. Added in Milestone 70a.
- `isWebSocketUpgradeRequest(headers)` is the shared RFC 6455 §4.2.1 predicate: `Upgrade` must equal
  `websocket` case-insensitively **and** `Connection` must contain the `upgrade` **token**, matched
  after splitting on commas — a substring test would also claim `Connection: no-upgrade`. It lives
  in `common` because the kernel decides whether a request is an upgrade and does not depend on
  `@setu-ts/runtime`, which re-exports this same function rather than keeping a copy. Added in
  Milestone 70a.
- `HandlerResult` is an opaque brand only the kernel constructs; handlers obtain it from `IResponse`
  terminal methods (`json`, `text`, `send`, `redirect`, `stream`).
- `IResponse` has two header setters with distinct semantics: `header(name, value)` **replaces** any
  existing value for `name` (`Headers.set`), while `appendHeader(name, value)` **adds** a value
  without removing existing ones (`Headers.append`). `appendHeader` is the correct way to emit
  multiple headers of the same name — most notably several `Set-Cookie` headers (e.g. access +
  refresh cookies). Both chain (`return this`).
- `IResponse.html(body: string): HandlerResult` — sends an HTML response with
  `content-type: text/html; charset=utf-8`. The charset is not optional: a bare `text/html` lets a
  browser sniff the encoding. Added because every CSRF-protected form example was setting the header
  by hand. **Breaking for out-of-repo `IResponse` implementors** (both in-repo implementors — the
  kernel's `ResponseBuilder` and `testing`'s `MockResponse` — implement it).
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
- `IRequest.user` and `IRequest.tenant` each allow one implicit assignment per request; a later
  assignment throws. `replacePrincipal` and `replaceTenant` are the explicit escapes for an
  intentional replacement. This catches late accidental overwrites, not authorization bypasses: a
  write before authentication is still the permitted first write.
- The application service registry seals after `runBootstrap()`. Its `register`, `registerFactory`,
  and `unregister` methods then throw; request-scoped child registries remain mutable. Startup-time
  `override: true` mutations log at `info`, and successful unregisters log at `warn` through the
  logger capability.
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
  routes through the kernel terminal handler. The deprecated optional `IHttpAdapter.setRpcHandler?`
  seam is no longer consulted. Added in Milestone 49.
- `CAPABILITIES.CLOUDFLARE` (`'cloudflare'`) — the capability token under which `CloudflarePlugin`
  registers `ICloudflareBindings`: typed access to a Worker's KV, R2, D1, Queues, service and
  Durable Object bindings, its string variables, and `waitUntil`. Added in Milestone 52.
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

### Ingress behaviours

`IngressKind` is `'queue' | 'scheduler' | 'messaging' | 'websocket'`. `IngressContext<TPayload>` is
the immutable work envelope supplied to an ingress behaviour:
`{ kind, name, payload, attempt?, headers? }`. Queue and scheduler populate the 1-based `attempt`;
messaging supplies transport headers when available and WebSocket frames supply neither optional
field.

`IIngressBehavior.handle(context, next)` is the void-result contract for non-HTTP work.
`BehaviorLike<TWork, TResult>` is the structural shape shared with CQRS, and `composeBehaviorChain`
runs behaviours in declared order. A behaviour that does not call `next()` short-circuits the
terminal handler; a thrown error follows that ingress's existing error path. The common composer is
also consumed internally by CQRS; it adds no CQRS surface.

`WebSocketUpgradeGuard` is a route guard that receives a `WebSocketConnectionContext` and returns
either `true` or a `{ status }` refusal (`WebSocketGuardDecision`). `WebSocketRouteOptions.guards`
is an optional readonly array of those guards; the matched route runs them in declared order before
its handshake and the first refusal wins.

---

## API Reference: @setu-ts/kernel

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
- The kernel's own error responses (malformed request URL or malformed percent-escape in the path →
  `400`; unmatched path → `404`; unhandled error → `500`; a request arriving while `stop()` is
  draining → `503`) are written through the **error responder seam** (`respondWithError` in
  `@setu-ts/common`). With `errorHandler` registered they answer in the application's configured
  format; with **no** `errorHandler` registered they fall back to the no-handler shape
  `{ error, detail? }` — which is **not** the same as the `default` formatter's
  `{ statusCode, message, details? }` body (see the exceptions contract notes). Error **formatting**
  belongs to the exceptions package, not the kernel; the kernel only supplies the status and
  message. The unhandled-error `500` additionally logs the error through `CAPABILITIES.LOGGER` when
  a logger is registered.
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

## API Reference: @setu-ts/runtime

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, Bun, and
Cloudflare Workers.

> **M23 replaced the old HTTP server adapters with the new `IHttpAdapter` contract
> (`setHandler`/`fetch`/`listen`/`close`)** and added the Cloudflare Workers adapter.

> **M87 widened two of those members to accept and return sync-or-async** — `setHandler` now takes
> `(request: IRequest) => IResponse | Promise<IResponse>` and `fetch` returns
> `Response | Promise<Response>`. This is **breaking for an out-of-repo adapter**: the handler's
> return type sits in a contravariant position, so an implementation declaring the narrower
> `Promise`-only shape is no longer a faithful implementor (TypeScript's bivariant method parameters
> mean it still compiles — the break surfaces when a handler that answers synchronously reaches it).
> Callers are unaffected, since `await` works on both.
>
> The widening exists because a request the kernel can answer without awaiting must not be wrapped
> back into a promise: `@hono/node-server` serves a response through its synchronous fast path only
> when the handler returns a non-promise, so a single eagerly-async link foreclosed that path for
> every request. An adapter implementing this contract should branch on promise-ness rather than
> awaiting:
>
> ```typescript
> const result = this.handler(frameworkRequest);
> return isPromiseLike(result) ? Promise.resolve(result).then(finish) : finish(result);
> ```

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
| `defineWorkerTask`                | function | **`@setu-ts/runtime/worker` subpath.** Registers a worker module's task handler            |
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
| `RuntimeOptions`                    | type | Options for `RuntimePlugin` (`platform`, `env`)                                |
| `CreateRuntimeServicesOptions`      | type | Options for `createRuntimeServices` (`platform`, `adapters`, `env`)            |
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
  import { createRuntimeServices } from '@setu-ts/runtime';
  import { loadConfig } from '@setu-ts/config-plugin';

  const config = await loadConfig(createRuntimeServices());
  ```

  Building a second instance alongside the application's own is safe: the adapters are stateless
  facades over platform globals, holding no connection, cache, or handle registry, and nothing
  compares them by identity. One caveat — `env` is a **snapshot taken at construction**, not a live
  view, so a variable set between two constructions is visible only to the later instance.

- **`env` on Cloudflare Workers.** There is no ambient environment on the edge: bindings and
  variables arrive as the `env` argument of the `fetch` handler. Both `RuntimePlugin` and
  `createRuntimeServices` therefore take an `env` option, and without it `runtime.env` is empty on
  Workers, so `ConfigPlugin` and the secrets `EnvProvider` read nothing. Pass what the platform
  provides:

  ```typescript
  import { env } from 'cloudflare:workers';

  const app = createApplication({ plugins: [RuntimePlugin({ env })] });
  ```

  Only the record's **string** entries populate `runtime.env`, which is contracted as
  `Readonly<Record<string, string | undefined>>`; object bindings are filtered out by the pure
  `splitWorkerEnv` in `common` and reached through `CAPABILITIES.CLOUDFLARE` instead. Passing them
  through unfiltered would hand `ConfigPlugin` a `[object Object]` for every KV namespace. The
  option is ignored on Deno, Node, and Bun, which read their own ambient environment.

---

## API Reference: @setu-ts/exceptions

Exception factory functions, `HttpError`, error formatters, and the global error handler middleware.
This is a **plain package** (not a plugin) — it depends on `@setu-ts/common` only. Register the
middleware via the application's pipeline.

### Values (exceptions exports)

| Export                | Kind     | Purpose                                                             |
| --------------------- | -------- | ------------------------------------------------------------------- |
| `HttpError`           | class    | The single HTTP error type (`extends Error`, carries `statusCode`)  |
| `badRequest`          | function | Factory → `400` `HttpError`                                         |
| `unauthorized`        | function | Factory → `401` `HttpError`                                         |
| `forbidden`           | function | Factory → `403` `HttpError`                                         |
| `notFound`            | function | Factory → `404` `HttpError`                                         |
| `conflict`            | function | Factory → `409` `HttpError`                                         |
| `validationError`     | function | Factory → `422` `HttpError` wrapping `ValidationError[]`            |
| `tooManyRequests`     | function | Factory → `429` `HttpError`                                         |
| `internalServerError` | function | Factory → `500` `HttpError` (accepts `cause` for error chaining)    |
| `notImplemented`      | function | Factory → `501` `HttpError`                                         |
| `serviceUnavailable`  | function | Factory → `503` `HttpError`                                         |
| `statusTitle`         | function | Resolves a status code to a human-readable title                    |
| `STATUS_TITLES`       | const    | Readonly record of well-known status-code → title mappings          |
| `errorHandler`        | function | Creates the global error-handler `MiddlewareFunction`               |
| `defaultFormatter`    | const    | Framework-standard error body formatter (`{ statusCode, message }`) |
| `rfc9457Formatter`    | const    | RFC 9457 Problem Details formatter                                  |
| `rfc7807Formatter`    | const    | **Deprecated.** RFC 7807 Problem Details formatter                  |
| `selectFormatter`     | function | Resolves an `ErrorFormat` or custom function to a formatter         |
| `ERROR_TYPE_BASE`     | const    | Base URI for framework problem types (`https://setu-ts.dev/errors`) |

### Types

| Export                  | Kind | Purpose                                                                                           |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `ValidationError`       | type | A single validation failure (`{ field, message, code? }`)                                         |
| `HttpErrorInit`         | type | Options object for `HttpError.from()`                                                             |
| `ErrorHandlerOptions`   | type | Options for `errorHandler()` (`{ format?, includeStackTrace?, logErrors?, maskInternalErrors? }`) |
| `ErrorHandlerFormatter` | type | `(error: Error, ctx?) => Record<string, unknown>`                                                 |
| `ErrorFormat`           | type | `'default' \| 'rfc9457' \| 'rfc7807'` (this package's union, no `'nestjs'`)                       |
| `DefaultErrorBody`      | type | Framework-standard error body shape                                                               |
| `ProblemDetails`        | type | RFC 9457 Problem Details body shape                                                               |

Contract notes:

- **Composition over inheritance**: there is exactly one `HttpError` class. Every factory function
  returns an `HttpError` with a pre-set `statusCode` — no `BadRequestError extends HttpError`
  hierarchy.
- **`cause` chaining**: `internalServerError(message, cause)` forwards `cause` to the ES2022 `Error`
  cause chain. The error handler logs it when a logger is registered (the logged `cause` is
  serialized through `serializeError`, so a nested `Error` never renders as `{}`).
- **Error format is the framework's error-body contract**: `errorHandler` is the single place an
  application configures how **every** error body is written. It publishes a request-scoped
  `IErrorResponder` (via `respondWithError` in `@setu-ts/common`) before `next()`, and every
  short-circuiting site — the kernel's own 404/400/500/503 terminals, the storage, multi-tenancy,
  session, auth, http-security, and feature-flags middleware — answers through it. So with
  `errorHandler({ format: 'rfc9457' })` registered, every error those sites produce is RFC 9457.
  **`validation-plugin` is the deliberate exception**: it formats validation failures itself and
  takes its own `errorFormat` option, so an application configures the two to agree — the CLI
  templates and `rest-starter` pair `ValidationPlugin({ errorFormat: 'rfc9457' })` with the handler
  for exactly that reason. With **no** `errorHandler` registered, every responder site falls back to
  the no-handler shape `{ error, detail? }` — a site cannot answer in its own ad-hoc shape. That
  fallback is a **different** body from the `default` formatter's
  `{ statusCode, message, details? }`: it is the framework's pre-formatter shape, written directly
  by `respondWithError`, and it is what an application without `errorHandler` keeps receiving
  byte-for-byte.
- **RFC 9457 compliance**: when `format: 'rfc9457'`, the response body carries `type`, `title`,
  `status`, `detail` (and `instance` from the request path) with
  `Content-Type: application/problem+json`. The `message` field is **absent** in this mode (Problem
  Details uses `detail`). The media type follows the RESOLVED formatter, so passing the exported
  `rfc9457Formatter` function as `format` produces the same body **and** the same content type as
  the `'rfc9457'` alias.
- **`type` is `about:blank` for status-only problems.** RFC 9457 §4.2 registers `about:blank` for a
  problem carrying "no semantics beyond the HTTP status code", which is every error this package
  produces except the one from `validationError()`. That one defines an `errors` extension member,
  so it is a distinct problem type identified by `https://setu-ts.dev/errors/validation` — the same
  URI `@setu-ts/validation-plugin` emits for it. Clients that need to distinguish errors should read
  `status`, which is what it is for.

  ```json
  {
    "type": "about:blank",
    "title": "Not Found",
    "status": 404,
    "detail": "User 42 does not exist",
    "instance": "/users/42"
  }
  ```

- **`'rfc7807'` is deprecated but unchanged.** RFC 7807 was obsoleted by RFC 9457 in July 2023. The
  `'rfc7807'` alias and the `rfc7807Formatter` export are retained through a deprecation period
  (AI_GUIDELINES §9.2) and still emit the status-derived `type` (`https://setu-ts.dev/errors/404`)
  they always did — a deprecated symbol must not silently change behavior (§9.4). Both spellings
  carry `application/problem+json`. Removal is scheduled for v1.0.0.
- **Logger is optional**: `errorHandler` logs via `ILogger` resolved from
  `ctx.services.get(CAPABILITIES.LOGGER)` only when a logger is registered; otherwise logging is
  silently skipped.
- **`maskInternalErrors` (default `true`)**: an unhandled error that is **not** an `HttpError` and
  resolves to status ≥ 500 is masked to a generic `detail` before the response is built, so the
  failing SQL and its bound parameter values never reach the client. The real error is still written
  to the logger first. An `HttpError` (a message the developer chose for the caller) and every 4xx
  pass through unmasked, and `maskInternalErrors: false` restores the previous body verbatim. This
  is a behaviour change from the previous release — see the CHANGELOG.
- **`includeStackTrace` is config-supplied**: pass `config.get('NODE_ENV') ===
  'development'` —
  never read `process.env` directly. The stack trace is secondary to the message, which is what
  carries the failing statement and its bound parameters; `maskInternalErrors` (default `true`) is
  what guards that message, not `includeStackTrace`. **Masking wins over this option**: a masked
  error carries no `stack` in the body even when this is `true`, because a stack begins with the
  very message that was masked. Set `maskInternalErrors: false` to see an internal error's stack.
- **Short-circuit**: when `next()` throws, `errorHandler` produces a response (`HandlerResult`)
  without re-invoking `next()`.

---

## API Reference: @setu-ts/di-plugin

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
  `@setu-ts/common`.
- **Three lifecycle scopes**: `singleton` (one instance, shared across child scopes), `scoped` (one
  instance per `createScope()` scope), `transient` (new instance every resolve). Default is
  `singleton`. The framework creates no scope per request, so a `scoped` service is not re-created
  on every HTTP request.
- **Circular dependency detection**: an instance-level resolution stack catches cycles that cross
  public `resolve()` boundaries (including factory providers calling back into the container).
  Throws `Error` with a readable `A → B → A` chain.
- **Hierarchical containers**: `createScope()` returns a child container that shares singletons with
  the parent but has its own scoped-instance cache. A scope is created and disposed explicitly by
  the application; the framework creates no scope per request.
- **Auto-registration** (`autoRegister: true`): resolving a token not in the container falls back to
  the kernel's `ServiceRegistry`. The first successful fallback is cached as a singleton; explicit
  DI registrations always take precedence. `ClassProvider.inject` dependencies also use this
  two-tier resolution, so framework capability tokens (`CAPABILITIES.LOGGER`, etc.) work as
  constructor dependencies without pre-registration.
- **No runtime-specific APIs**: the container uses no `Date.now()`, `crypto.*`, or `process.*` — it
  is pure TypeScript and runtime-independent.

---

## API Reference: @setu-ts/decorator-plugin

Optional decorator and metadata system plugin. Provides NestJS-style decorators as syntactic sugar
over the kernel's programmatic API. Decorators capture metadata in a plain `MetadataStore` (no
`reflect-metadata`); the `DecoratorPlugin` reads that store at registration and registers routes,
services, and middleware with the kernel. The store is published under `CAPABILITIES.METADATA_STORE`
so `ctx.metadata` resolves to it. Decorators are inert unless the `DecoratorPlugin` is registered —
they write to the shared singleton regardless, but only the plugin reads it. Implemented in
**Milestone 9**; this section is the authoritative export list (AI_GUIDELINES §10.5). All exports
carry full JSDoc.

> **TC39 standard decorators — no compiler option required.** The surface needs no
> `experimentalDecorators`, no `emitDecoratorMetadata`, and no `compilerOptions` entry of any kind:
> Deno and Bun parse standard decorators unconfigured, and declaring an option would replace Deno's
> default set. Node needs a transform (`tsx`) because V8 has not shipped decorators.
>
> The standard proposal has **no parameter position**, so handler arguments are declared at the
> method level with `@Params(...)` and constructor dependencies at the class level with
> `@Inject(...)`; both are positional, the Nth entry binding the Nth argument. `@Params` is checked
> against the handler's own signature, which the legacy parameter decorators never were.

### Values (decorator-plugin exports)

| Export                                                       | Kind     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPlugin`                                            | function | Plugin factory — registers `MetadataStore`, routes/services, and explicitly activated `@Module` trees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MetadataStore`                                              | class    | `IMetadataStore` implementation (the concrete store)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `metadataStore`                                              | value    | The process-wide singleton decorators write to and the plugin reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Controller`                                                 | function | Class decorator — base path prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Version`                                                    | function | Class decorator — API version prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Get`/`Post`/`Put`/`Patch`/`Delete`/`Head`/`Options`         | function | HTTP method decorators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Params`                                                     | function | Method decorator binding handler arguments to sources, positionally; type-checked against the handler's signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Injectable`                                                 | function | Class decorator — marks a class for DI registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Inject`                                                     | function | Class decorator declaring constructor injection tokens, one per argument in argument order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Optional`                                                   | function | Wraps a token inside `@Inject(...)`; that argument receives `undefined` when the token has no provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Roles`/`Permissions`                                        | function | Class/method decorator — authorization requirements. ENFORCED when `enforceRoles` is not `false`: each decorated route gets middleware resolving `CAPABILITIES.AUTHORIZATION` per request, answering `401` without a principal and `403` on a failed check with the same bodies the equivalent `@UseGuards(requireRole(...))` spelling produces. With no authorization provider the route FAILS CLOSED — `501`, never served unguarded — and `DecoratorPlugin` warns once per route. Method-level declarations override class-level; a route carrying both `@Roles` and `@Permissions` requires (any role) AND (any permission) |
| `Public`                                                     | function | Method decorator — contributes `security: []` only for a route without an enforced `@Roles`/`@Permissions` restriction. It does NOT exempt a route from a guard or from enforcement; a restricted route keeps its derived OpenAPI security requirement                                                                                                                                                                                                                                                                                                                                                                          |
| `UseGuards`/`UseInterceptors`/`UseFilters`                   | function | Class/method pipeline decorators                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ValidateBody`/`ValidateQuery`/`ValidateParams`              | function | Method decorators — attach validation schemas. ENFORCED when a `CAPABILITIES.VALIDATION` provider is registered and `enforceSchemas` is not `false`: the capability's middleware is appended LAST in the route's chain (after guards), answering `400` before the handler while preserving guard `401`/`403` precedence. Without such a provider the schemas stay description-only and `DecoratorPlugin` logs one warning per affected route                                                                                                                                                                                    |
| `ApiTags`                                                    | function | Class decorator — OpenAPI tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ApiOperation`/`ApiResponse`                                 | function | Method decorators — OpenAPI operation metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Module`                                                     | function | Class decorator grouping controllers, providers, and imported modules for `DecoratorPlugin({ modules })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `createDecorator`                                            | function | Custom class/method decorator factory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Body`/`Query`/`Param`/`Header`/`Cookie`/`CurrentUser`/`Ctx` | function | Built-in parameter SOURCES, declared inside `@Params(...)`; `Ctx` yields the active `IRequestContext` without reserving the application custom type name `context`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Custom`                                                     | function | Declares a parameter source resolved by a resolver registered under the same name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resolveParameters`                                          | function | Resolves an ordered argument array from parameter metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `resolveParameter`                                           | function | Resolves a single parameter value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `registerParameterResolver`                                  | function | Registers a resolver for a custom parameter type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `getParameterResolver`                                       | function | Looks up a custom parameter resolver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `clearParameterResolvers`                                    | function | Clears the custom resolver registry (tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `parseCookies`                                               | function | Parses a `Cookie` header into a name→value record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `discoverControllers`                                        | function | Auto-discovers decorated classes from a directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Types

| Export                       | Kind | Purpose                                                                                                                                            |
| ---------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPluginOptions`     | type | Options for `DecoratorPlugin()` (`autoDiscover?`, `controllersPath?`, `controllers?`, `services?`, `modules?`, `enforceSchemas?`, `enforceRoles?`) |
| `InjectableOptions`          | type | Options for `@Injectable()` (`scope?`, `token?`)                                                                                                   |
| `ModuleOptions`              | type | Options for `@Module()` (`controllers?`, `providers?`, `imports?`; no `exports`)                                                                   |
| `ApiOperationConfig`         | type | Config for `@ApiOperation()` (`operationId?`, `summary?`, `description?`)                                                                          |
| `ApiResponseConfig`          | type | Config for `@ApiResponse()` (`status`, `description?`, `schema?`)                                                                                  |
| `HttpMethodDecorator`        | type | `(path?: string) => SetuMethodDecorator`                                                                                                           |
| `ParamSource`                | type | One entry in a `@Params(...)` declaration; carries the resolved value type                                                                         |
| `SourceValues`               | type | Maps a source tuple onto the handler parameter tuple it binds                                                                                      |
| `InjectToken`                | type | `string \| OptionalToken` — one entry in an `@Inject(...)` list                                                                                    |
| `OptionalToken`              | type | A token wrapped by `Optional(...)`, marking that argument absent-tolerant                                                                          |
| `SetuClassDecorator`         | type | A standard class decorator that records metadata and leaves the class unchanged                                                                    |
| `SetuMethodDecorator`        | type | A standard method decorator that records metadata and leaves the method unchanged                                                                  |
| `SetuClassOrMethodDecorator` | type | A standard decorator valid in either position, discriminating on `context.kind`                                                                    |
| `MiddlewareLike`             | type | `MiddlewareFunction \| (new () => IMiddleware)` — accepted by pipeline decorators                                                                  |
| `CustomParameterResolver`    | type | `(ctx, metadata?) => unknown \| Promise<unknown>`                                                                                                  |
| `ParameterMetadata`          | type | Parameter metadata captured by a `@Params(...)` source                                                                                             |
| `ParameterType`              | type | `'body' \| 'query' \| 'param' \| 'header' \| 'cookie' \| 'custom'`                                                                                 |
| `DiscoveryOptions`           | type | Config for `discoverControllers()` (`path`, `extensions?`, `exclude?`)                                                                             |
| `DiscoveryResult`            | type | Result of discovery (`controllers`, `services`, `errors`)                                                                                          |
| `ModuleImporter`             | type | `(specifier: string) => Promise<unknown>` — injectable module loader                                                                               |

Contract notes:

- **Inert without the plugin**: decorators write to the `metadataStore` singleton at
  class-definition time regardless of whether the plugin is registered. Only
  `DecoratorPlugin.register()` reads the store and calls the kernel APIs; without it, no
  routes/services/middleware are registered.
- **Modules are activation groups, not DI boundaries**: `DecoratorPlugin({ modules })` flattens
  `imports` depth-first, registers imported providers before the importing module's controllers, and
  deduplicates classes by identity. A class passed as a module without `@Module` metadata logs a
  warning and contributes nothing. There is no `exports` option because application service
  visibility is not module-scoped.
- **Validation schemas are enforced, not just described** (`enforceSchemas`, default `true`): for
  each of `schema.body`/`query`/`params` present on a route, `registerController` resolves
  `CAPABILITIES.VALIDATION` and appends that capability's middleware LAST in the route's chain —
  innermost, after guards, so an unauthenticated request is refused by its guard rather than told
  `400` with a body that names the schema's field paths. With no validation provider registered, a
  decorated schema stays description-only (OpenAPI) and ONE warning per route names the controller,
  handler, affected targets and `ValidationPlugin`; nothing throws. `enforceSchemas: false` keeps
  schemas description-only and silences the warning.
- **`@Roles`/`@Permissions` are enforced, not just described** (`enforceRoles`, default `true`):
  `registerController` appends one middleware per present restriction — roles first, so a route
  carrying both kinds is refused by the one that failed — after guards and BEFORE interceptors,
  ordinary middleware, filters, and validation, so no later stage can short-circuit a declared
  restriction. The middleware resolves `CAPABILITIES.AUTHORIZATION` PER REQUEST, so a provider
  registered after `register()` is honoured; with none, the route answers
  `501 Not Implemented / "Authorization is
  not configured"` and `register()` warns once per
  affected route naming the controller, handler, restriction and both remedies (register a provider,
  or `enforceRoles: false`). `enforceRoles:
  false` keeps the metadata description-only and
  silences the warning — the pre-M89a behaviour. The appended middleware is M57-branded, so
  `deriveSecurity` documents decorated routes.
- **`Body()`/`Query()`/`Param()` read the VALIDATED value when one exists.** Each checks `ctx.state`
  under `validatedStateKey(target)` first — presence-tested with `has`, so a validated `null` or `0`
  is honoured — and falls back to the raw source when absent. A Zod `transform` or `default`
  therefore reaches the handler instead of being discarded. `Header()` and `Cookie()` deliberately
  read their raw sources: headers resolve case-insensitively through `headers.get(name)`, which the
  validated record would break, and no schema key exists for cookies.
- **No reflection**: metadata is stored in plain `Map`s keyed by class reference, not via
  `Reflect.getMetadata()`. No `reflect-metadata` dependency.
- **Decorator composition**: cross-cutting decorators (`@Params`, `@ValidateBody`, `@Roles`, …) run
  before the HTTP-verb decorator; the store accumulates per-method and derives one `RouteMetadata`
  per (method, HTTP verb) at read time, so metadata is correct regardless of application order.
  Class-level guards/interceptors/middleware run before method-level; method-level
  `@Roles`/`@Permissions` override class-level; `@Public` sets the `isPublic` flag (OpenAPI
  `security: []` only for unrestricted routes — no guard bypass).
- **Handler return values**: a controller method either returns a value (serialized as JSON by the
  plugin's handler wrapper) or returns a `HandlerResult` from `ctx.response.*`.
- **Discovery**: `discoverControllers` walks via `IRuntimeServices.fs` (absent on edge platforms →
  empty result with a warning) and loads modules with `await import()` (no `require`/`eval`).
  Snapshot-diff against the store attributes newly-decorated classes to each file. Discovery
  failures never crash the application.
- **`Ctx()` response control**: `Ctx` resolves the live `IRequestContext`, so a decorated handler
  can configure `ctx.response` (status, headers, or a stream) and return its `HandlerResult`; it is
  a built-in custom parameter type and needs no resolver registration. It is recognised by a marker
  registered with `Symbol.for`, so it keeps working if two copies of the package share a process,
  and an application's own `Custom('context')` still reaches its own resolver.
- **Startup diagnostics**: when a logger is registered, `DecoratorPlugin.register()` warns (never
  throws) about two silent misconfigurations. A class passed in `controllers` that carries no
  `@Controller` metadata registers no routes — the usual cause is two copies of the package, where
  decorators populate one copy's metadata store while the plugin reads the other's, so every route
  404s. And a custom parameter with no matching resolver reaches the handler as `undefined`; the
  warning names the controller, handler, and parameter index. The parameter check reflects the
  resolvers registered when the plugin registers, so call `registerParameterResolver` before
  `app.start()`.
- **Custom decorators**: `createDecorator` records class/method metadata replayed against
  `DecoratorHandler`s registered via `ctx.decorators.register()` (collected under
  `CAPABILITIES.DECORATOR_HANDLER`). `Custom(name, metadata?)` declares a parameter source resolved
  by `resolveParameters` via `registerParameterResolver`; the `context` and `current-user` built-ins
  resolve directly to `ctx` and `ctx.request.user`, respectively.
- **`@Inject` is a class decorator, and a token is always required.** The list is positional: the
  Nth entry names the Nth constructor argument. The TC39 proposal has no parameter position, so
  there is nowhere else to put it.

  ```typescript
  @Injectable({ token: 'user-repository' })
  @Inject(CAPABILITIES.DATABASE, CAPABILITIES.LOGGER)
  class UserRepository {
    constructor(private db: IDatabase, private logger: ILogger) {}
  }
  ```

  Wrap an entry in `Optional(...)` to let that argument receive `undefined` when the token has no
  provider. `Optional` means the dependency is **absent**, not that construction may fail: an error
  raised while building a token that IS provided propagates rather than being swallowed.

  ```typescript
  @Injectable()
  @Inject(CAPABILITIES.DATABASE, Optional(CAPABILITIES.CACHE))
  class ReportService {
    constructor(private db: IDatabase, private cache?: ICacheStore) {}
  }
  ```

  A token cannot be inferred from the parameter's type: that needs `emitDecoratorMetadata`, which
  Deno does not support, and no source in this repo reads `design:paramtypes`. A list shorter than
  the constructor leaves the trailing arguments `undefined` — a positional list cannot have gaps, so
  the legacy "parameter N has no `@Inject` token" and "declares both `@Inject` forms" refusals no
  longer have any reachable input and are gone. Method parameters bind with `@Params(...)`.

  The list is read in declaration order and reaches the constructor in that order. The legacy
  index-keyed assembly is gone with the parameter form it existed for: parameter decorators
  evaluated in REVERSE argument order, so tokens had to be stored by index and re-sorted.
- **The container is preferred whenever the class is registered in it**, with or without
  `@Injectable`. A `@Controller` carries no `@Injectable`, so a constructor-injected controller in a
  `DiPlugin` application resolves through the container — where its dependencies live.
- **`Optional(token)` marks an injected dependency absent-tolerant, not construction fallible.** It
  wraps an entry inside the class-level `@Inject(...)` list, in the position of the argument it
  describes, and never replaces the token — one is still required, for the same
  `emitDecoratorMetadata` reason above:

  ```typescript
  @Injectable({ token: 'report-service' })
  @Inject(CAPABILITIES.DATABASE, Optional(CAPABILITIES.CACHE))
  class ReportService {
    constructor(private db: IDatabase, private cache?: ICacheService) {}
  }
  ```

  When the token has no provider the argument receives `undefined`; when it HAS one it is resolved
  normally, so an error raised while building it — a circular dependency, a throwing factory —
  propagates rather than being masked as absence. `Optional` cannot be misplaced any more — it is an
  argument to `@Inject(...)` rather than a decorator, so the three legacy refusals it needed have no
  reachable input and are gone. One throw remains, for a caller writing to the store directly: an
  optional index that the `@Inject(...)` list names no token for is refused at `register()`, since
  it would otherwise pass `undefined` for an argument nothing declares.

  Both construction paths honor it identically — the DI container when one is registered, the
  kernel's service registry otherwise. One consequence is worth knowing on the container path: a
  class carrying `@Optional` registers as a `useFactory` provider rather than a `useClass` one,
  because `ClassProvider.inject` is a bare token list with nowhere to record optionality. The
  class's own `scope` is still honored, but since `FactoryProvider.useFactory` takes no arguments,
  that factory resolves its dependencies from the container the class was registered on rather than
  from the resolving scope. Classes without `@Optional` are unaffected and still register as
  `useClass`.
- **No runtime-specific APIs**: the package uses no `Date.now()`, `Deno`, `process`, or `fs` — all
  file/time operations go through `IRuntimeServices`.

---

## Testing Package (`@setu-ts/testing`)

First-party testing utilities for the Setu-TS framework: a test application factory, mock plugin
builder, request injector, mock request context, service registry double, fixture manager, and
streaming-response reader.

### Exports

| Export                | File                               | Description                        |
| --------------------- | ---------------------------------- | ---------------------------------- |
| `createTestApp`       | `src/test-app.ts`                  | Test application factory           |
| `TestAppOptions`      | `src/test-app.ts`                  | Factory options                    |
| `createMockPlugin`    | `src/mock-plugin.ts`               | Mock plugin builder                |
| `MockPluginOptions`   | `src/mock-plugin.ts`               | Builder options                    |
| `collectStream`       | `src/inject.ts`                    | Collect streaming response body    |
| `inject`              | `src/inject.ts`                    | Inject HTTP requests into test app |
| `StreamingBody`       | `src/inject.ts`                    | Stream collector result shape      |
| `createTestContext`   | `src/mock-context.ts`              | Create a mock `IRequestContext`    |
| `TestContextOptions`  | `src/mock-context.ts`              | Context builder options            |
| `MockResponse`        | `src/mock-context.ts`              | Fake `IResponse` double            |
| `MockServiceRegistry` | `src/mock-registry.ts`             | Fake `IServiceRegistry` double     |
| `FixtureManager`      | `src/fixtures/fixture-manager.ts`  | Assemble mock plugins per-test     |
| `IKernelApplication`  | (re-export from `@setu-ts/kernel`) | Kernel application interface       |
| `InjectRequest`       | (re-export from `@setu-ts/kernel`) | Shape for `inject()` request       |
| `InjectResponse`      | (re-export from `@setu-ts/kernel`) | Shape for `inject()` response      |

### Registration

```typescript
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DatabasePlugin } from '@setu-ts/database-plugin';

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
import { collectStream, createMockPlugin, createTestContext, inject } from '@setu-ts/testing';
import { FixtureManager, MockServiceRegistry } from '@setu-ts/testing';

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

## SDK — Client SDK (`@setu-ts/sdk`)

Portable, zero-npm-dependency client SDK for consuming Setu-TS APIs from browsers and servers. Does
not register a plugin or resolve capability tokens — it is an external-consumer library.

### Installation

```bash
deno add jsr:@setu-ts/sdk@^0.3.0
```

### createClient()

Factory that returns an `IHttpClient`. Requires a base URL; accepts default headers, an injectable
`fetch` seam, a timing seam, resilience policies, rate-limit policy, and interceptor arrays.

`ClientRequest.path` must be **relative** — no leading slash, no absolute URL. A leading-slash path
would discard `baseUrl`'s own path prefix, and an absolute URL would leave `baseUrl`'s origin
entirely, which is what makes the per-origin breaker and rate limiter meaningful. A path that
violates the rule throws `ClientRequest.path must be relative (no leading slash).` at request time.

```typescript
import { createClient } from '@setu-ts/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  headers: { 'X-Trace-Id': 'abc' },
});

const res = await client.request<User>({
  method: 'GET',
  path: 'users/123',
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

`RetryPolicy`, `CircuitBreakerPolicy`, and `BackoffStrategy` are re-exported from `@setu-ts/common`
so consumers can name their types without adding `common` to their own manifest.

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
import { generateOpenApiClient } from '@setu-ts/sdk';

const source = generateOpenApiClient(document, {
  sdkImport: '@setu-ts/sdk',
  factoryName: 'createApi',
});
```

### OpenApiCodegenOptions

```typescript
interface OpenApiCodegenOptions {
  sdkImport?: string;
  factoryName?: string;
  apiTypeName?: string;
}
```

| Option        | Default          | Description                                        |
| ------------- | ---------------- | -------------------------------------------------- |
| `sdkImport`   | `'@setu-ts/sdk'` | Generated type-import specifier                    |
| `factoryName` | `'createApi'`    | Exported generated factory name                    |
| `apiTypeName` | `'Api'`          | Exported interface the factory returns (see below) |

#### Generated naming contract

| Emitted symbol           | Derivation                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Operation method         | lower-camelCase from `operationId`, split on non-alphanumeric runs, **interior casing preserved** (`listUsers` → `listUsers`)               |
| Component type           | PascalCase from the component name (`User` → `export type User`)                                                                            |
| Argument interface       | PascalCase from `operationId` plus `Args` (`listUsers` → `ListUsersArgs`)                                                                   |
| Client interface         | `apiTypeName`, PascalCase-sanitized (default `Api`); the factory's written-out return type                                                  |
| Error union              | PascalCase from `operationId` plus `Error`, with guard `is<Operation>Error` — emitted only for a declared non-2xx response                  |
| Error body alias         | PascalCase from `operationId` plus `Error<status>Body`, emitted only when the rendered body spans lines                                     |
| Request body alias       | PascalCase from `operationId` plus `Body`, emitted only when the body schema is inline and spans lines                                      |
| Response alias           | PascalCase from `operationId` plus `Response<status>`, emitted only when a 2xx schema is inline and spans lines                             |
| Parameter alias          | PascalCase from `operationId` plus the parameter name plus `Param`, emitted only when the parameter schema is inline and spans lines        |
| Leading digit / reserved | digit run prefixed `n`; reserved word prefixed `_`; a name that sanitizes to nothing becomes `operation`                                    |
| Duplicate derived name   | throws `OpenApiCodegenError` naming both originals — component schemas, `*Args`, `*Error*` and the client interface share ONE name registry |

**No multi-line type is written at a use site.** An inline (non-`$ref`) request body, parameter or
success response is hoisted into an exported alias, so every reference to it is a single-line name.
This is not cosmetic: a rendered type lands at several indentation levels, and a success type lands
at two of them at once — the client interface's signature and the `client.request<…>` type argument
— so no single indentation is correct for a multi-line object literal, and `deno fmt` reindents
whatever is emitted. Hoisting also makes the shape nameable by a consumer. A schema that
`@setu-ts/openapi-plugin` derived from validation middleware and used once is inline, so this is the
ordinary case rather than an exotic one.

**The factory has a written-out return type.** `createApi(client: IHttpClient): Api`, with
`export interface Api { … }` listing every operation's signature. An inferred return type is a JSR
_slow type_: it blocks automatic `.d.ts` generation, so a consumer could not publish a package
containing the generated file — while the file's own header tells them not to edit it. Naming the
interface is also the only way a consumer can name the client's type.

**Declared error responses are typed.** For each operation declaring a non-2xx response the
generator emits a union discriminated on the literal `status`, plus a narrowing guard:

```typescript
export type GetUserByIdError =
  | (HttpClientError<NotFound> & { readonly status: 404 })
  | (HttpClientError<GetUserByIdError409Body> & { readonly status: 409 });
export function isGetUserByIdError(e: unknown): e is GetUserByIdError { … }
```

`HttpClientError` is generic in its body (`HttpClientError<TBody = unknown>`), so the bare name
keeps meaning exactly what it did. The union must be discriminated on `status` to be usable —
`HttpClientError<A> | HttpClientError<B>` is not, because `status` is `number` on both arms. A
`default` response and range codes such as `4XX` are skipped: they name no single status.

**Generated output is `deno fmt`- and `deno lint`-clean.** Two-space indentation, nested inline
object types indented, no lint pragma (`{}` is emitted as `Record<PropertyKey, never>`, which is
both what the schema means and what `ban-types` accepts), signatures wrapped one parameter per line
past 100 columns, and a path template too long for one line emitted as an equivalent `[…].join('')`.
The two committed fixtures under `packages/sdk/test/fixtures/` are real generator output and are
covered by the repository's own `fmt` and `lint` gates — they carry no exclusion.

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
operations deriving onto one name; two emitted TYPE names colliding — component schemas, `*Args`
interfaces, `*Error` unions, `*Error<status>Body` aliases and the client interface all draw from ONE
registry, so a component named `ListUsersArgs` beside an operation `listUsers` is refused rather
than emitting two declarations of one name; a `cookie` parameter; a path placeholder with no
matching `in: 'path'` parameter; an `in: 'path'` parameter absent from the template; two
placeholders deriving onto one argument name; and a malformed local `$ref`.

### SdkOpenApi\* types

`SdkOpenApiDocument`, `SdkOpenApiPathItem`, `SdkOpenApiOperation`, `SdkOpenApiParameter`,
`SdkOpenApiRequestBody`, `SdkOpenApiResponse`, and `SdkOpenApiSchema` are the structural OpenAPI 3.1
subset accepted by the generator. They are intentionally different from the openapi-plugin types
(which have different shapes) and take the `SdkOpenApi*` prefix to avoid a barrel collision.

---

## API Reference: @setu-ts/grpc-plugin

gRPC/Connect co-serving on the same port as ordinary Hono routes. Registered under
`CAPABILITIES.GRPC`. Added in Milestone 49.

> `createApplication()` returns an application descriptor; there is no `new Application()` /
> `app.use()` API. Plugins register during `app.start()`, so **do not resolve `CAPABILITIES.GRPC`
> before `start()` resolves** — the capability does not exist yet and the lookup throws. Pass
> services through the `services` option (below) or call `addService` after `start()`.

### Registration

```typescript
import { GrpcPlugin } from '@setu-ts/grpc-plugin';

GrpcPlugin({
  basePath: '/', // default — the root
  reflection: true, // default — grpc.reflection.v1.ServerReflection
  health: true, // default — grpc.health.v1.Health (bridged to M20)
  services: [], // initial service definitions
  connectModule: undefined, // inject for testing; otherwise lazy-loaded
  interceptors: [], // default — application Connect interceptors
});
```

### Usage

Pass services through the plugin's `services` option at construction:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import { MyServiceDefinition, myServiceImpl } from './my-service.ts';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GrpcPlugin({
      services: [{ definition: MyServiceDefinition, implementation: myServiceImpl }],
    }),
  ],
});

await app.start({ port: 3000 });

// AFTER start(): late registration through the resolved capability.
const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
grpc.addService(AnotherDefinition, anotherImpl);
```

### Options

| Option          | Type                                     | Default | Description                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`      | `string`                                 | `/`     | URL prefix that marks a request as RPC. Defaults to the root so clients reach procedures without a path prefix; detection stays segment-aware, so prefix-adjacent routes (`/grpcfoo`) are untouched. Requests outside this prefix fall through to Hono.                      |
| `reflection`    | `boolean`                                | `true`  | Register `grpc.reflection.v1.ServerReflection`. Bidi streaming — requires HTTP/2 or in-process fetch.                                                                                                                                                                        |
| `health`        | `boolean`                                | `true`  | Register `grpc.health.v1.Health` (`Check` only), bridged to the M20 health plugin.                                                                                                                                                                                           |
| `services`      | `Array<{ definition, implementation? }>` | `[]`    | Initial services to register at startup. The recommended registration path: the capability does not exist before `start()`.                                                                                                                                                  |
| `connectModule` | `ConnectRuntime`                         | omitted | Injected Connect runtime for tests; omitted triggers lazy `import()` of four npm specifiers.                                                                                                                                                                                 |
| `interceptors`  | `readonly unknown[]`                     | `[]`    | Application Connect interceptors, forwarded to Connect router construction (`createConnectRouter({ interceptors })`). Composed after the built-in handler-error logging, so a handler throw is logged before an application interceptor observes it. Absent: none installed. |

> Native gRPC-binary requests (`application/grpc`, `+proto`, `+json`) are refused with a
> Trailers-Only `UNIMPLEMENTED` (`grpc-status: 12`). No runtime the plugin loads on exposes the
> HTTP/2 trailers the native protocol requires. Connect and gRPC-Web are fully supported.

### Exports

| Export                 | Kind     | Purpose                                                                                       |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GrpcPlugin`           | function | Plugin factory — registers `IGrpcService` under `CAPABILITIES.GRPC`                           |
| `GrpcService`          | class    | The `IGrpcService` implementation; exported so tests can compose it without subclassing       |
| `adaptConnectModule`   | function | Structural adaptation of raw Connect/Protobuf modules into the internal `ConnectRuntime` port |
| `GrpcUnavailableError` | class    | **Deprecated** — nothing throws it since M70a; `handleRequest` needs no adapter capability    |
| `GrpcRuntimeLoadError` | class    | Thrown by `loadConnectModule` when any of the four npm specifiers cannot be imported          |
| `GrpcDescriptorError`  | class    | Thrown when an embedded descriptor set cannot be decoded or lacks its expected service        |
| `GrpcPluginOptions`    | type     | The factory parameter shape                                                                   |
| `ConnectModuleLike`    | type     | The four-module bundle `adaptConnectModule` accepts                                           |

> `ConnectRuntime` and the structural Connect facades are **not** exported. They are an internal
> port; publishing them would commit the package to a shape that tracks Connect's own API.

### Notes

- **Co-serves with Hono.** gRPC requests are detected by path prefix only (`basePath`, which
  defaults to `/` — the root, so clients reach procedures at the bare method path). Content-type
  sniffing is deliberately not used because Connect's real unary content types include
  `application/json` and `application/proto`. A path outside `basePath` returns `null` and falls
  through to the Hono pipeline unchanged.
- **The middleware pipeline runs first.** Since M70a the kernel dispatches gRPC from its terminal
  handler, after the pipeline and **before** route matching — so auth, metrics, security headers and
  the shutdown drain apply to RPC exactly as to ordinary routes, a draining application answers
  `503`, and an application catch-all cannot shadow a claimed path. `GrpcPlugin` no longer calls
  `adapter.setRpcHandler`, which is deprecated and consulted by nothing.
- **`IGrpcService.claims(request)` is what keeps ordinary 404s intact.** `handleRequest` returns
  `Promise<Response>` and never `null`, so it answers `404` both for a path outside `basePath` and
  for a claimed path with no such procedure — the two are indistinguishable once dispatched. The
  kernel therefore asks `claims()` **before** dispatching. Without that guard, registering the
  plugin would change every unmatched route in the application from the kernel's
  `{"error":"Not Found"}` (`application/json`) to gRPC's `Not Found` (`text/plain`). `claims` is
  optional on the contract for source compatibility, and the kernel treats an implementor that lacks
  it as claiming nothing. A **root** `basePath` normalizes to `''`, which contains every path, so
  there `claims` reports only registered procedures rather than the whole application — otherwise a
  root-mounted service consulted before route matching would 404 every ordinary route.
- **`IGrpcService.available` is now always `true`.** It used to report whether the resolved HTTP
  adapter implemented `setRpcHandler`; dispatch no longer depends on any adapter capability.
- The request handed to `handleRequest` is **reconstructed** from the mapped `IRequest` (method,
  URL, headers, buffered body), because the framework mapping has already consumed the original
  body. Cloning every request before mapping would tax the whole application to serve the gRPC
  minority. Trailers do not survive the round trip — M49 already records that native gRPC-binary
  trailers work on no runtime this plugin runs on, so no working path regresses.
- **`inject()` CAN exercise RPC.** Since M70a the kernel dispatches gRPC from its terminal handler,
  and `inject()` attaches the undisturbed web `Request` as `IRequest.raw` before running the
  pipeline, so an injected request reaches RPC dispatch exactly as a socket request does — the
  integration suite drives gRPC through `inject()`. The retired adapter interceptor is not involved:
  no `setRpcHandler` seam is consulted on any path.
- **Bidi streaming requires HTTP/2.** `grpc.reflection.v1.ServerReflection` is bidi-only. Over a
  real HTTP/1.1 socket, bidi calls fail at the transport. Unary, server-streaming, and
  client-streaming work on every runtime.
- **Health bridge maps `degraded → NOT_SERVING`**. `'up' → SERVING (1)`, `'down' → NOT_SERVING (2)`,
  `'degraded' → NOT_SERVING (2)`. The health plugin already withdraws a degraded replica from its
  Service via `/ready` (503), so reporting `SERVING` here would leave the two health faces of one
  process disagreeing — gRPC clients would keep load-balancing onto a replica HTTP has taken out of
  rotation. Since M70c the bridge agrees with `/ready`; a client relying on `SERVING` while a
  process is degraded now sees `NOT_SERVING` (see the CHANGELOG).
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
- **No adapter seam.** Since M70a the kernel dispatches gRPC from its terminal handler after the
  middleware pipeline; dispatch depends on no adapter capability, so the plugin serves on every
  runtime and `IGrpcService.available` is always `true`. The retired `setRpcHandler?` member is
  consulted by nothing, and `GrpcUnavailableError` remains exported only as published surface —
  nothing throws it.
- **Native gRPC-binary is refused by design.** Native gRPC (`application/grpc`, `+proto`, `+json`)
  relies on HTTP/2 response trailers (specifically `grpc-status`) for proper status signaling, and
  no fetch-based server runtime exposes them to a `Response` — including Deno's `Deno.serve`,
  Node.js, and Bun. Every native request is therefore answered with a **Trailers-Only
  `UNIMPLEMENTED`** (`HTTP 200`, `content-type: application/grpc`, `grpc-status: 12`) instead of
  half-serving the protocol. This is a deliberate design decision, not a platform bug. Connect-JSON
  and gRPC-Web work completely on all runtimes; point native gRPC clients at a gRPC-Web-capable
  proxy or switch them to Connect (see the CHANGELOG migration notes).

---

## API Reference: @setu-ts/cloudflare-plugin

Cloudflare Workers platform bindings, published under `CAPABILITIES.CLOUDFLARE`, plus optional
KV-backed cache, R2-backed storage, and a Queues-backed `IQueue`. Zero npm dependencies. Added in
Milestone 52; Queues, Cron Triggers, and the Cache API response cache added in Milestone 52b.

### Registration

```typescript
import { env, waitUntil } from 'cloudflare:workers';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

app.register(CloudflarePlugin({
  env, // required — the Worker's bindings and variables
  waitUntil, // the platform background-work sink
  requireBindings: ['CACHE_KV'], // fail at register() rather than at first use
  cache: { binding: 'CACHE_KV', prefix: 'cache:', defaultTtlSeconds: 300 },
  storage: { binding: 'UPLOADS', prefix: 'user-uploads/' },
  queue: { binding: 'JOBS' },
}));
```

Consuming a queue and receiving Cron Triggers need **module-level handler exports** the platform
invokes directly — `fetch` is not involved — so the application assembles them beside it:

```typescript
import {
  createQueueHandler,
  createScheduledHandler,
  WorkersCron,
} from '@setu-ts/cloudflare-plugin';

await app.start();

const cron = new WorkersCron();
cron.on('0 3 * * *', () => rebuildReports(app)); // must match wrangler.toml [triggers] crons

export default {
  fetch: app.fetch,
  queue: createQueueHandler(app),
  scheduled: createScheduledHandler(cron),
};
```

Nothing in the package imports `cloudflare:workers`; the application passes `env` in. That specifier
is unresolvable outside a Worker toolchain, so importing it here would break `deno check` on every
other runtime — and injection is what the platform docs recommend for testability.

### Options

| Option                           | Type                  | Default      | Consumer / behavior                                                                                              |
| -------------------------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `env`                            | `CloudflareWorkerEnv` | required     | `BindingRegistry` — the record every accessor reads                                                              |
| `waitUntil`                      | `WaitUntilHost`       | —            | `resolveWaitUntil` — delegated to; omit off Workers                                                              |
| `requireBindings`                | `readonly string[]`   | `[]`         | `register()` — throws naming every absent entry                                                                  |
| `cache.binding`                  | `string`              | —            | `KvCacheStore` — the KV namespace serving `CAPABILITIES.CACHE`                                                   |
| `cache.name`                     | `string`              | `'default'`  | Plugin factory — derives `cache.<name>` when not `'default'`                                                     |
| `cache.prefix`                   | `string`              | —            | `KvCacheStore` — key prefix; **required to call `clear()`**                                                      |
| `cache.defaultTtlSeconds`        | `number`              | —            | `KvCacheStore.set` — applied when `ttlSeconds` is omitted                                                        |
| `storage.binding`                | `string`              | —            | `R2Storage` — the R2 bucket serving `CAPABILITIES.STORAGE`                                                       |
| `storage.name`                   | `string`              | `'default'`  | Plugin factory — derives `storage.<name>` when not `'default'`                                                   |
| `storage.prefix`                 | `string`              | —            | `R2Storage` — object-key prefix                                                                                  |
| `queue.binding`                  | `string`              | —            | `WorkersQueue` — the producer binding serving `CAPABILITIES.QUEUE`                                               |
| `queue.name`                     | `string`              | `'default'`  | Plugin factory — derives `queue.<name>` when not `'default'`                                                     |
| `queue.maxDelaySeconds`          | `number`              | `86400`      | `WorkersQueue.add` — a larger `delayMs` throws rather than being truncated                                       |
| `messaging.binding`              | `string`              | —            | `WorkersBroker` — the producer binding serving `CAPABILITIES.MESSAGING`; validated at `register()`               |
| `messaging.name`                 | `string`              | `'default'`  | Plugin factory — derives `messaging.<name>` when not `'default'`                                                 |
| `messaging.rpc.binding`          | `string`              | —            | `WorkersBroker` — the Durable Object namespace serving reply inboxes; absent, `request`/`respond` throw          |
| `messaging.rpc.defaultTimeoutMs` | `number`              | `5000`       | `RequestCorrelation` — reply budget when `RequestOptions.timeoutMs` is omitted                                   |
| `durableObject.binding`          | `string`              | —            | `DurableObjectBackplane` — the namespace serving `CAPABILITIES.REALTIME_BACKPLANE`; validated at `register()`    |
| `durableObject.name`             | `string`              | `'default'`  | Plugin factory — derives `realtime-backplane.<name>` when not `'default'`                                        |
| `durableObject.topic`            | `string`              | `'realtime'` | `DurableObjectBackplane` — the `idFromName` value every replica shares; two apps sharing a namespace must differ |

### Exports

| Export                                                                                                                                                                                                                                                                                                                                  | Kind          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `CloudflarePlugin`                                                                                                                                                                                                                                                                                                                      | factory       |
| `ICloudflareBindings`                                                                                                                                                                                                                                                                                                                   | interface     |
| `CloudflarePluginOptions`, `KvCacheOptions`, `R2StorageArm`, `WorkersQueueArm`, `WorkersMessagingArm`, `WorkersMessagingRpcArm`, `DurableObjectArm`                                                                                                                                                                                     | types         |
| `KvCacheStore`, `KvCacheStoreOptions`, `CacheClock`                                                                                                                                                                                                                                                                                     | class + types |
| `KvSessionStore`, `KvSessionStoreOptions`                                                                                                                                                                                                                                                                                               | class + types |
| `R2Storage`, `R2StorageOptions`                                                                                                                                                                                                                                                                                                         | class + types |
| `D1Adapter`, `D1AdapterOptions`, `D1EntityMapping`                                                                                                                                                                                                                                                                                      | class + types |
| `WaitUntilHost`, `LoggerSource`                                                                                                                                                                                                                                                                                                         | types         |
| `WorkersQueue`, `WorkersQueueOptions`, `JobIdSource`                                                                                                                                                                                                                                                                                    | class + types |
| `createQueueHandler`, `QueueHandler`, `QueueHandlerOptions`                                                                                                                                                                                                                                                                             | fn + types    |
| `WorkersBroker`, `WorkersBrokerOptions`, `ReplyInboxBinding`, `BrokerRuntime`                                                                                                                                                                                                                                                           | class + types |
| `createMessagingHandler`, `MessagingHandler`, `MessagingHandlerOptions`                                                                                                                                                                                                                                                                 | fn + types    |
| `ReplyInboxObjectCore`, `ReplyInboxObjectCoreOptions`                                                                                                                                                                                                                                                                                   | class + type  |
| `WorkersCron`, `WorkersCronOptions`, `CronHandler`                                                                                                                                                                                                                                                                                      | class + types |
| `createScheduledHandler`, `ScheduledHandler`                                                                                                                                                                                                                                                                                            | fn + type     |
| `cacheApiMiddleware`, `CacheApiMiddlewareOptions`, `ICacheApi`                                                                                                                                                                                                                                                                          | fn + types    |
| `assessCacheability`, `CacheabilityInput`, `CacheRefusal`                                                                                                                                                                                                                                                                               | fn + types    |
| `RealtimeBackplaneObjectCore`, `RealtimeBackplaneObjectCoreOptions`                                                                                                                                                                                                                                                                     | class + type  |
| `DistributedLockObjectCore`, `DistributedLockObjectCoreOptions`                                                                                                                                                                                                                                                                         | class + type  |
| `DurableObjectBackplane`, `DurableObjectBackplaneOptions`                                                                                                                                                                                                                                                                               | class + type  |
| `DurableObjectLock`, `DurableObjectLockOptions`                                                                                                                                                                                                                                                                                         | class + type  |
| `asUpgradeResponse`, `DurableObjectUpgradeResponse`                                                                                                                                                                                                                                                                                     | fn + type     |
| `createDefaultDurableObjectWebSocketHost`, `DurableObjectWebSocketHost`, `DurableObjectWebSocketPair`                                                                                                                                                                                                                                   | fn + types    |
| `IDurableObjectState`, `IDurableObjectStorage`, `IDurableObjectWebSocket`, `IDurableObjectClientSocket`, `DurableObjectMessageEvent`                                                                                                                                                                                                    | types         |
| `IKvNamespace`, `IR2Bucket`, `IR2Object`, `IR2ObjectBody`, `ID1Database`, `ID1PreparedStatement`, `D1Result`, `IQueueProducer`, `IQueueMessage`, `IQueueMessageBatch`, `IScheduledController`, `IServiceBinding`, `IDurableObjectNamespace`, `CloudflareWorkerEnv`, `KvPutOptions`, `KvListOptions`, `KvListResult`, `QueueSendOptions` | types         |
| `isKvNamespace`, `isR2Bucket`, `isD1Database`, `isQueueProducer`, `isDurableObjectNamespace`                                                                                                                                                                                                                                            | guards        |
| `CloudflareBindingMissingError`, `CloudflareUnsupportedError`, `CloudflareObjectNotFoundError`, `CloudflareRequestTimeoutError`, `CloudflareRemoteHandlerError`                                                                                                                                                                         | errors        |

### `D1Adapter` — D1 as a first-class database

Implements the committed `IDatabaseAdapter` (from `@setu-ts/common`), so a Worker serves
`CAPABILITIES.DATABASE` through the ordinary repository and Unit-of-Work surface. Constructed by the
application and handed to `DatabasePlugin`, matching `KvSessionStore`: those plugin options are read
when the plugin is **constructed**, before any application exists, so an adapter published in the
service registry could never reach it.

```typescript
import { env } from 'cloudflare:workers';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { D1Adapter, type ID1Database } from '@setu-ts/cloudflare-plugin';

app.register(DatabasePlugin({
  type: 'custom',
  adapter: new D1Adapter(env.DB as ID1Database, {
    tables: { User: { table: 'users', primaryKey: 'user_id' } },
  }),
}));
```

| Option                       | Default         | Behavior                                                          |
| ---------------------------- | --------------- | ----------------------------------------------------------------- |
| `tables`                     | `{}`            | Per-entity `{ table, primaryKey }` overrides                      |
| `D1EntityMapping.table`      | the entity name | Physical table name; validated as a SQL identifier before quoting |
| `D1EntityMapping.primaryKey` | `'id'`          | Key column used by `findById` / `update` / `delete`               |

**Transactions.** D1 has **no interactive transaction** — `BEGIN TRANSACTION` is rejected by the
platform — and `batch()` is its only unit of atomicity. `beginTransaction()` therefore **buffers**
every write and flushes the whole buffer as one `batch()` at `commit()`; `rollback()` discards the
buffer and sends nothing. Two consequences, both deliberate:

- **No read-your-own-writes inside a transaction.** Reads run immediately against committed state,
  so a row written earlier in the same transaction is not visible to a later read within it.
- **`create()` inside a transaction requires an explicit primary key**, and throws
  `CloudflareUnsupportedError` naming the constraint when one is absent — a deferred `INSERT` cannot
  report a generated key to a caller that awaits `create()` before the flush. Outside a transaction
  `create()` uses `RETURNING *` and returns the real persisted row, generated columns included.

**Identifiers and limits.** Values are always bound (`?N`); identifiers cannot be, so table and
column names are validated against `[A-Za-z_][A-Za-z0-9_]*` and double-quoted, throwing
`CloudflareUnsupportedError` otherwise. D1 binds at most **100 parameters per query**, and every
builder whose parameter count varies with the caller's query — select, insert, update, count —
refuses a statement that would exceed it rather than letting D1 fail with a message that points at
the SQL instead of the caller's query. (Find-by-id and delete bind exactly one value and so cannot.)

**The binding is validated where the adapter is built.** `new D1Adapter(env.DB)` throws
`CloudflareBindingMissingError` when the binding is absent or not D1-shaped, naming what arrived and
pointing at the `d1_databases` stanza. Without that check a mistyped binding name would register
cleanly, report `up` from the `database` health indicator, and fail every query with a bare
`TypeError`. The `isD1Database` guard is exported alongside `isKvNamespace` / `isR2Bucket`.

**Not verified against live D1.** CI holds no Cloudflare account. Every generated statement is
asserted verbatim, and the whole surface is driven against a real SQLite engine (the engine D1
runs), including batch rollback.

### Durable Objects — realtime backplane and distributed lock

Both need a Durable Object class the **application** exports plus a wrangler stanza; no plugin
option can export a class on an application's behalf. This package ships the behaviour as two plain
cores that the exported class delegates to. A mixin taking the base class would read better but
cannot be typed without `any` — the TypeScript mixin constructor constraint requires it, and the
`unknown[]` form rejects a class whose constructor takes `(ctx, env)` — so delegation is the design,
and it also keeps `cloudflare:workers` (unresolvable off a Worker toolchain) out of the package.

```typescript
import { DurableObject } from 'cloudflare:workers';
import { RealtimeBackplaneObjectCore } from '@setu-ts/cloudflare-plugin';

export class RealtimeBackplaneObject extends DurableObject {
  #core = new RealtimeBackplaneObjectCore(this.ctx);
  override fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#core.webSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#core.webSocketClose(ws, code, reason);
  }
  webSocketError(ws: WebSocket): void {
    this.#core.webSocketError(ws);
  }
}
```

```toml
[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeBackplaneObject"

[exports.RealtimeBackplaneObject]
type = "durable-object"
storage = "sqlite"
```

`storage = "sqlite"` is required on the Workers Free plan. The legacy `migrations` +
`new_sqlite_classes` flow still works, but a Worker may use only one of the two flows.

**Backplane.** The `durableObject` arm registers `DurableObjectBackplane` under
`CAPABILITIES.REALTIME_BACKPLANE` (or `realtime-backplane.<name>`), which `websocket-plugin` and
`sse-plugin` resolve on their own. Register this arm **or** `RealtimeBackplanePlugin`, never both —
the kernel rejects two providers of one token.

The Durable Object holds **zero in-memory state**. Sockets are accepted with `ctx.acceptWebSocket`,
the hibernation API, which lets the runtime evict the object and re-run its constructor while
connections stay open; `getWebSockets()` is the only membership that survives, so it is the only
membership used. The payload is re-broadcast verbatim and never parsed, which keeps the object
schema-ignorant — a future widening of `RealtimeFrame` needs no redeploy of the application's class.

**The subscription guarantee is narrower than "durable", deliberately.** A Worker isolate is evicted
at Cloudflare's discretion and its outbound WebSockets go with it. That is sound rather than lossy
because the members the subscription serves are client sockets held by the _same_ isolate, and an
HTTP-triggered Worker stays alive while its clients remain connected — so losing the isolate loses
the subscription and its members together. The socket opens lazily on first publish and reopens
after any failure.

**Lock.** `DurableObjectLock` structurally satisfies `scheduler-plugin`'s `IDistributedLock` without
importing it (a plugin may not import a plugin), and is app-constructed then handed over, matching
`KvSessionStore` and `D1Adapter`:

```typescript
const lock = new DurableObjectLock(env.LOCKS as IDurableObjectNamespace, { runtime });
// `enabled: true` is NOT required — resolveLock consults `lock` before `enabled`.
app.register(SchedulerPlugin({ distributedLock: { lock } }));
```

One object per lock key. Correctness comes from the platform: a Durable Object processes one event
at a time and holds back delivery while a storage operation runs, so the read-compare-write is
atomic with no transaction and no quorum. The holder is persisted in `ctx.storage`, never a field,
because an object is evicted after 70–140 seconds of inactivity and a lock TTL routinely outlives
that. A non-2xx from the object **throws** rather than reporting "not acquired": a 404 means the
binding names the wrong class, and folding that into contention would silently disable every
scheduled job.

**Verified against real workerd** (`wrangler dev`, 12/12 checks) — including a plain Durable Object
class without `extends DurableObject`, a real `stub.fetch` WebSocket upgrade, real
`state.acceptWebSocket` hibernation, and the real input gate serializing 8 concurrent lock
contenders down to one winner. **Not verified against a deployed Worker**: CI holds no Cloudflare
account.

### `ICloudflareBindings`

`has(name)`, `names()`, `vars()`, `get<T>(name)`, `kv(name)`, `r2(name)`, `d1(name)`, `queue(name)`,
`service(name)`, `durableObject(name)`, `waitUntil(promise)`.

Every accessor **throws** `CloudflareBindingMissingError` for an absent name — naming the binding
and listing the ones that are present — rather than returning `undefined`; a missing binding is a
deployment error, not an expected case. Use `has` when absence is expected. `kv`, `r2` and
`durableObject` additionally validate the binding's shape, so an R2 bucket wired into a KV option
fails at `register()` with a message rather than at first use with a `TypeError`. (`d1` is validated
by `D1Adapter`'s constructor instead, where the adapter is built.)

### Notes

- **Registration is opt-in and instance-named.** `CAPABILITIES.CLOUDFLARE` is always registered;
  `CAPABILITIES.CACHE` and `CAPABILITIES.STORAGE` only when their arm is configured. `name` derives
  `cache.<name>` / `storage.<name>` exactly as `CachePlugin` does, so a KV cache can sit beside a
  memory one. Registering an unnamed instance beside `CachePlugin()` is a startup error, because the
  kernel rejects two providers of one token.
- **KV's `expirationTtl` minimum is 60 seconds, and `ICacheStore.set` is unbounded.** Values carry a
  `{ v, e }` envelope whose logical deadline is checked against `runtime.now()` on every read, while
  the physical `expirationTtl` is floored at 60 so KV can still reclaim the key. A 5-second entry
  therefore expires in 5 seconds. The same envelope backs `KvSessionStore`.
- **`clear()` requires a prefix.** The binding has no bulk delete, so the sweep pages `list` (1000
  keys maximum) and deletes each key. Without a prefix it would delete keys the store does not own,
  so it throws `CloudflareUnsupportedError` instead.
- **A read never deletes a key the store does not own.** The envelope decoder reports three
  outcomes, not two — live, _this store's_ expired entry, and neither — and only the middle one is
  swept. That is what makes a shared namespace safe, and it is also why a deliberately cached `null`
  survives: `get` answers `null` for it (the contract has no other way to say so) while `has` and
  `delete` report it as present, and no path removes it.
- **KV is eventually consistent.** Suitable for read-heavy caching, not for coordination.
- **`R2Storage.getSignedUrl` throws.** The R2 Workers binding exposes no presign operation at all.
  `getStream` is implemented, so serving through a route is a zero-copy alternative.
- **`R2Storage.delete` heads first.** R2's `delete` returns void and reports nothing, so the
  committed `Promise<boolean>` costs one extra round trip rather than a constant `true`.
- **`KvSessionStore` is constructed by the application**, not registered by the plugin:
  `SessionPluginOptions.store` is read at plugin construction, before any application exists.
- **No binding I/O at registration.** Cloudflare prohibits I/O outside a request context, so the
  plugin only captures and shape-checks bindings at `register()`. The `cloudflare` health indicator
  performs no binding I/O either — a KV read per probe interval is billable. It reports `degraded`
  when `runtime.platform()` is not `cloudflare-workers`.
- **`waitUntil` reports its failures.** A rejection handler is attached whether or not a host was
  injected, so background work never fails silently. With no host the promise still runs: no runtime
  off Workers cuts work off at the response.
- **Compatibility date.** `import { waitUntil } from 'cloudflare:workers'` shipped 2025-08-08;
  `setu new --runtime cloudflare-workers` scaffolds a later date.
- **Unverified against a live Worker.** Every binding is exercised against a fake built from the
  documented signatures — including KV's 60-second floor and R2's void `delete` — but CI holds no
  Cloudflare account.
- **Queues: `addRecurring` throws.** Cloudflare Queues has no recurring message. The error names
  Cron Triggers and `WorkersCron` as the platform's own mechanism. `add` and `process` map directly:
  `AddJobOptions.delayMs` is converted to the platform's whole-second `delaySeconds` **rounded up**
  (so a job is never delivered early) and refused above `maxDelaySeconds`, while
  `ProcessOptions.concurrency` bounds how many of one batch's messages for that name run at a time —
  per name, so one processor's limit never throttles another's.
- **A job's id comes from this package, not the platform.** `producer.send()` resolves to `void`, so
  the id `add` returns is minted from `runtime.uuid()` and travels inside a `{ v, name, id, data }`
  envelope — which is also what carries the job **name**, since a Cloudflare message body is
  arbitrary JSON and `IQueue.process` dispatches by name. The id the caller receives is therefore
  the id the processor sees as `job.id`.
- **An unroutable message is RETRIED, never acked.** A body that is not a readable envelope, or a
  name with no registered processor, is returned for redelivery and reported through the logger —
  acking it would discard it permanently and silently, which is the failure a queue exists to
  prevent. A processor that throws is likewise retried, leaving the queue's own `max_retries` and
  dead-letter configuration to decide what happens next. `AddJobOptions.maxAttempts` is enforced at
  dispatch, because Cloudflare's `max_retries` is queue-wide configuration rather than per message.
- **`publish` reaches one consumer Worker, not every subscriber in the cluster.** Cloudflare allows
  **exactly one active consumer per queue**, so two Workers cannot both receive one published
  message; fan-out happens across the handlers registered inside that consumer. A topology needing
  cross-service fan-out binds one queue per consuming service. This is a platform property, not a
  limitation of the adapter, and it is the one place `WorkersBroker` cannot match a socket broker.
- **`subscribe` registers; it does not start receiving.** A Cloudflare queue consumer is a
  module-level export, so delivery happens only once the application exports
  `createMessagingHandler(app)` as `queue` AND declares the queue under `[[queues.consumers]]` — the
  same split `WorkersQueue` has between `process` and `dispatch`. Within one delivery the selection
  matches `InMemoryBroker`: every subscriber that named no `queue` is called, plus exactly one
  member of each named group, round-robin.
- **A publish nobody subscribed to is ACKED, not retried** — the one place this deliberately departs
  from `WorkersQueue`. A job name with no processor is a mistake, but publishing to a topic nobody
  listens on is ordinary pub/sub, and retrying would burn the queue's 100-retry budget and
  dead-letter every fire-and-forget message. A body that is not a readable envelope is still
  retried, and a subscriber that throws is retried.
- **`request`/`respond` need the `messaging.rpc` arm, and throw `CloudflareUnsupportedError` without
  it.** A queue reaches its one consumer Worker and never the caller waiting for a reply, so RPC
  needs a second addressable path: the caller holds a WebSocket to a Durable Object named after its
  own inbox, and the responder `POST`s the reply there. That costs a namespace binding and a DO
  class the application exports (delegating to `ReplyInboxObjectCore`), which is why it is opt-in
  rather than always on. A request whose topic has no responder is **answered with a failure**
  rather than left to time out, and a responder that throws is relayed to the caller and acked —
  never retried, since the caller has already been told and a redelivery would re-run side effects.
- **One `queue` export serves EVERY queue the Worker consumes.** Cloudflare distinguishes them only
  by `batch.queue` — the queue name from `wrangler.toml`, which no plugin option can see. A Worker
  consuming both a message queue and a job queue must route on it: feeding job batches to
  `createMessagingHandler` fails the envelope guard and retries them until the queue dead-letters
  them, and leaving a produced queue unconsumed discards every `IQueue.add()` silently.
  `setu new --template microservice --runtime cloudflare-workers` emits the routing and a consumer
  stanza for both queues.
- **A queue carrying RPC MUST set `max_batch_timeout = 0`.** The platform default is 5 seconds and
  `RequestOptions.timeoutMs` defaults to 5000, so on a default queue essentially every `request()`
  times out. `setu new --template microservice --runtime cloudflare-workers` emits the correct
  stanza.
- **The RPC errors are this package's own classes.** `CloudflareRequestTimeoutError` and
  `CloudflareRemoteHandlerError` mirror `messaging-plugin`'s `RequestTimeoutError` and
  `RemoteHandlerError` but are distinct identities, because AI_GUIDELINES §2.2 forbids a plugin
  importing another plugin and `common` carries no error class to promote them into. Which one an
  application catches is never ambiguous: both providers claim `CAPABILITIES.MESSAGING`, so the
  kernel's duplicate-provider check guarantees exactly one is registered.
- **Cron Triggers do NOT register `CAPABILITIES.SCHEDULER`, deliberately.** Of `IScheduler`'s eight
  methods only `cron` is expressible on Workers: `every` and `delay` arm a timer and the isolate is
  evicted between invocations (the same reason `scheduler-plugin` cannot run on Workers);
  `pause`/`resume`/`remove` need state that does not survive between invocations; and `getNextRun`
  is owned by the `wrangler.toml` `[triggers]` block. An `IScheduler` where six of eight methods
  throw would violate Liskov substitution, so `WorkersCron` is a purpose-built registry reached
  directly instead — which is why `createScheduledHandler` takes it while `createQueueHandler` takes
  the application.
- **A `WorkersCron` expression must match `wrangler.toml` exactly.** Nothing in the process can read
  that file, so an expression registered here but absent from `[triggers] crons` never fires, and a
  configured trigger with nothing registered here is reported on every occurrence. `expressions()`
  exists so an application can assert its own coverage. Matching is exact — whitespace is not
  normalized.
- **`cacheApiMiddleware` is a different layer from `cache-plugin`'s `cacheMiddleware`**, and the two
  compose: this one serves from the datacenter the request landed in with no round trip, while
  `cacheMiddleware` reads an `ICacheStore` every colo shares. It therefore reports under
  **`X-Cache-Api`** (`HIT`/`MISS`/`BYPASS`), never `X-Cache`, so an operator can tell which layer
  answered. `caches.default` is **per-datacenter**: a hit rate measured in one location says nothing
  about another, and a `delete` does not evict globally.
- **The platform's cache refusals are checked before the write, not discovered by it.**
  `caches.default.put` throws for a non-GET request, status 206, `Vary: *`, and an uncleared
  `Set-Cookie`; `assessCacheability` reports each as a `CacheRefusal` and the middleware skips the
  write. The 206 and `Vary: *` checks are unconditional — an operator may legitimately configure
  `cacheableStatuses: [200, 206]`, at which point only the explicit rule stops the platform
  throwing. `Cache-Control: private=Set-Cookie` is the platform's documented opt-in and clears the
  `set-cookie` refusal.
- **Only GET requests touch the edge cache — on the read as well as the write.** The cache key is a
  URL string, which the Cache API resolves as a GET request, so consulting it for a `POST` would
  serve the cached GET body and skip the handler entirely: a mutation silently discarded behind a
  200. Any non-GET request passes straight through with `X-Cache-Api: BYPASS`, which matters most
  when the middleware sits on the global pipeline rather than a single GET route.
- **A failed cache write never fails the request.** `Cache.put` rejects for an oversized response or
  a quota error, and by then the response already exists — so both write paths report and continue
  rather than turning a 200 into a 500. With the plugin registered `waitUntil` carries that
  reporting; without it the middleware logs through `CAPABILITIES.LOGGER` when one is present.
- **A cache HIT is replayed as a stream**, so a cached response of any size reaches the client
  without being buffered — which means `app.inject()` cannot read its body. Drive a cached route
  with `app.fetch` and a web `Request`, the entry point a Worker invokes anyway. A **streaming**
  response is never cached: teeing it would double the memory the stream exists to avoid.
- **The cache write rides `waitUntil` when the plugin is registered**, so it never delays the
  response; with `CAPABILITIES.CLOUDFLARE` absent the middleware awaits it inline rather than
  abandoning it, and with no cache handle at all it passes through with `BYPASS` rather than
  throwing.
- **Not in this package.** D1 as a database backend is Milestone 52c — the seam a backend implements
  (`IDatabaseAdapter`) lives inside `database-plugin` and is not a committed `common` port, so
  shipping it means a contract promotion. A Durable-Object realtime backplane and distributed lock
  are Milestone 52d: both need the application to export a DO class plus a wrangler migration
  stanza.

---

## GraphQL (`@setu-ts/graphql-plugin`)

Schema-first and code-first GraphQL support over the kernel router.

### Overview

GraphQL plugin providing schema construction, execution, and HTTP transport. Supports both SDL-based
schema definition with resolver maps and pre-built schemas. Includes media-type negotiation for
`application/graphql-response+json`, error masking, query-depth limiting, and optional GraphiQL UI.

### Capability Token

- `CAPABILITIES.GRAPHQL` (`'graphql'`) — the capability token under which `GraphqlPlugin` registers
  the `IGraphqlService`.

### Usage

Pass the plugin to `createApplication({ plugins: [...] })` — there is no `new Application()` /
`app.use()` API:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    // Schema-first
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
  ],
});

await app.start({ port: 3000 });

// Resolve the service AFTER start() — plugins register during start().
const graphql = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
```

Code-first differs only in passing a pre-built schema instead of `typeDefs` + `resolvers`:

```typescript
import { buildSchema } from 'npm:graphql@^16';
const schema = buildSchema(`type Query { hello: String }`);

GraphqlPlugin({ schema });
```

### Options

| Option               | Type                                      | Default    | Description                                                                            |
| -------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `typeDefs`           | `string`                                  | -          | SDL schema definition (schema-first mode)                                              |
| `resolvers`          | `ResolverMap`                             | -          | Resolver map (schema-first mode)                                                       |
| `schema`             | `GraphqlSchemaLike`                       | -          | Pre-built schema (code-first mode)                                                     |
| `path`               | `string`                                  | `/graphql` | Endpoint path                                                                          |
| `graphiql`           | `boolean`                                 | `true`     | Enable GraphiQL UI                                                                     |
| `introspection`      | `boolean`                                 | `true`     | Enable schema introspection                                                            |
| `maxDepth`           | `number`                                  | `10`       | Maximum query depth (0 to disable)                                                     |
| `validationRules`    | `unknown[]`                               | omitted    | Extra rules, appended after the built-ins, assembled once at registration              |
| `maskInternalErrors` | `boolean`                                 | `true`     | Mask internal server errors                                                            |
| `formatError`        | `(error: unknown) => unknown`             | omitted    | Custom error formatter applied after masking                                           |
| `documentCacheSize`  | `number`                                  | `1000`     | Max cached documents (0 to disable)                                                    |
| `buildContext`       | `(input: GraphqlContextInput) => unknown` | omitted    | Custom context builder                                                                 |
| `rootValue`          | `unknown`                                 | omitted    | Root value for resolvers                                                               |
| `graphqlModule`      | `GraphqlModuleLike`                       | omitted    | Injected graphql module (for testing or code-first scenarios)                          |
| `subscriptions`      | `GraphqlSubscriptionsOptions`             | omitted    | Subscription transports. **Omitted registers no transport route at all.**              |
| `apq`                | `GraphqlApqOptions`                       | omitted    | Automatic Persisted Queries. **Omitted disables APQ**; requires `CAPABILITIES.RUNTIME` |
| `maxBatchSize`       | `number`                                  | `0`        | **`0` disables batching** and an array body is still refused with `400`                |

#### `subscriptions`

| Option                           | Type                                  | Default                | Purpose                                        |
| -------------------------------- | ------------------------------------- | ---------------------- | ---------------------------------------------- |
| `websocket`                      | `GraphqlWsTransportOptions \| false`  | enabled                | `false` disables the WebSocket transport       |
| `websocket.path`                 | `string`                              | `` `${path}/ws` ``     | WebSocket endpoint                             |
| `websocket.connectionInitWaitMs` | `number`                              | `3000`                 | Close `4408` when no `connection_init` arrives |
| `websocket.heartbeatMs`          | `number`                              | `0`                    | Protocol `ping` interval; `0` disables         |
| `websocket.onConnect`            | `(info) => false \| void`             | omitted                | Returning `false` closes `4403: Forbidden`     |
| `sse`                            | `GraphqlSseTransportOptions \| false` | enabled                | `false` disables the SSE transport             |
| `sse.path`                       | `string`                              | `` `${path}/stream` `` | SSE endpoint                                   |
| `sse.heartbeatMs`                | `number`                              | `0`                    | `:keep-alive` comment interval; `0` disables   |

#### `apq`

| Option       | Type     | Default | Purpose                                                            |
| ------------ | -------- | ------- | ------------------------------------------------------------------ |
| `ttlSeconds` | `number` | `300`   | TTL for entries in a registered `ICacheStore`                      |
| `maxEntries` | `number` | `1000`  | Bound on the in-process LRU used when no cache store is registered |

### Exports

| Export                        | Kind      | Purpose                                                                                                                                        |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GraphqlPlugin`               | function  | Plugin factory — registers `IGraphqlService` under `CAPABILITIES.GRAPHQL`                                                                      |
| `GraphqlService`              | class     | The `IGraphqlService` implementation; exported for testing                                                                                     |
| `adaptGraphqlModule`          | function  | Structural adaptation of graphql module into internal runtime port                                                                             |
| `graphiqlHtml`                | function  | Generates GraphiQL UI HTML page                                                                                                                |
| `createDepthLimitRule`        | function  | Creates a validation rule for query depth limiting                                                                                             |
| `GraphqlSchemaError`          | class     | Thrown when schema construction or resolver attachment fails                                                                                   |
| `GraphqlRuntimeLoadError`     | class     | Thrown when graphql runtime cannot be loaded                                                                                                   |
| `loadGraphqlModule`           | function  | Loads `npm:graphql@^16` through a real dynamic import                                                                                          |
| `GraphqlPluginOptions`        | type      | The factory parameter shape (union of the two arms)                                                                                            |
| `GraphqlSchemaFirstOptions`   | type      | The schema-first arm of that union                                                                                                             |
| `GraphqlCodeFirstOptions`     | type      | The code-first arm of that union                                                                                                               |
| `ResolverMap`                 | type      | Resolver map for schema-first mode                                                                                                             |
| `TypeResolverMap`             | type      | The resolver entries for one object or interface type                                                                                          |
| `FieldResolver`               | type      | Field resolver function type                                                                                                                   |
| `AnyFieldResolver`            | type      | The bivariant entry type a `TypeResolverMap` field holds — accepts a narrowly annotated resolver AND contextually types an unannotated one     |
| `AnySubscriptionResolver`     | interface | The bivariant entry type a `TypeResolverMap` subscription field holds — same rule as `AnyFieldResolver`, for `{ subscribe, resolve? }` entries |
| `SubscriptionResolver`        | type      | A subscription field's `{ subscribe, resolve? }` pair                                                                                          |
| `GraphqlScalarResolver`       | type      | Custom scalar `serialize`/`parseValue`/`parseLiteral` methods                                                                                  |
| `GraphqlSubscriptionsOptions` | type      | The `subscriptions` option (WebSocket and SSE arms)                                                                                            |
| `GraphqlWsTransportOptions`   | type      | WebSocket transport options, including `onConnect`                                                                                             |
| `GraphqlSseTransportOptions`  | type      | SSE transport options                                                                                                                          |
| `GraphqlApqOptions`           | type      | Automatic Persisted Queries options                                                                                                            |
| `ApqResolver`                 | class     | Verifies and resolves persisted-query hashes                                                                                                   |
| `IApqResolver`                | type      | The port the transports consume; implemented by `ApqResolver`                                                                                  |
| `ApqResolveResult`            | type      | The resolved query, or a refusal carrying its code                                                                                             |
| `extractPersistedQuery`       | function  | Reads `{ version, sha256Hash }` from a request's `extensions`                                                                                  |
| `persistedQueryHash`          | function  | SHA-256 hex of a query, over an injected `SubtleCrypto`                                                                                        |
| `encodeSseEvent`              | function  | Encodes a `next` SSE frame                                                                                                                     |
| `encodeSseComplete`           | function  | Encodes the `complete` SSE frame, empty `data:` field included                                                                                 |
| `encodeSseComment`            | function  | Encodes a `:keep-alive` comment frame                                                                                                          |
| `GRAPHQL_TRANSPORT_WS`        | const     | The `'graphql-transport-ws'` subprotocol identifier                                                                                            |
| `GraphqlScalarTypeLike`       | type      | Structural constraint for a custom scalar type                                                                                                 |
| `GraphqlSchemaLike`           | type      | Structural constraint for pre-built schemas                                                                                                    |
| `GraphqlModuleLike`           | type      | Structural constraint for injected graphql modules                                                                                             |
| `DefaultGraphqlContext`       | type      | Default context shape passed to resolvers                                                                                                      |
| `GraphqlContextInput`         | type      | Input type for custom context builder                                                                                                          |

> `GraphqlRuntime` and the structural graphql facades are **not** exported. They are an internal
> port.

### Notes

- **Two schema construction arms.** Schema-first (`typeDefs` + `resolvers`) and code-first
  (`schema`) are mutually exclusive; supplying both is a compile error.
- **Resolver context.** Without `buildContext`, resolvers receive a `DefaultGraphqlContext` whose
  shape is per-transport. Over **HTTP**: `{ services, requestContext, user?, tenant? }` — `services`
  is the live `IServiceRegistry`, so a resolver reaches any other capability through it, and
  `user`/`tenant` are whatever the auth and multi-tenancy middleware published on the request. Over
  **WebSocket**: `{ services, connection }` — `requestContext` is **absent** (not
  `undefined`-valued): the runtime closes the upgrade request once the handshake response is
  returned, so a synthesized one would be dead by the time a resolver runs; that is why the member
  is typed optional. The upgrade request's headers and query live on
  `GraphqlConnectionInfo.headers`/`.query`, and identity set by an `onConnect` hook via
  `info.data.set('user', …)` surfaces as `ctx.user`. Supplying `buildContext` replaces that object
  wholesale.
- **Media-type negotiation and the status watershed.** Responds with
  `application/graphql-response+json` when the client requests it, otherwise `application/json` —
  including for failures raised before execution, so a client is never handed a media type it did
  not ask for. Under `graphql-response`, a **request** error (parse, validation, operation
  resolution) is `400`, a subscription over HTTP is `400`, and a mutation over `GET` is `405`. Under
  `application/json`, every request the endpoint processed as GraphQL answers `200` with the error
  in the body, because a client predating the newer media type reads a non-200 as a network failure
  and never reads the `errors` array. Exactly three cases keep their status under `application/json`
  — an unsupported request content type (`415`), a malformed JSON body (`400`), and a mutation over
  `GET` (`405`) — because none of them is a GraphQL result. An **APQ refusal** follows the watershed
  too: under `application/json` it answers `200` with `PersistedQueryNotFound` in the body (it is
  exactly the error a client must read and retry), while under `graphql-response` it carries the
  resolver's own status. Batching remains refused before per-element resolution, so an APQ miss
  inside a batch under `graphql-response` surfaces as `400 BATCHING_NOT_SUPPORTED`. The status is
  decided from the outcome alone and never from the response body, so a `formatError` hook cannot
  change it.
- **Two resolver authoring styles, both supported.** `FieldResolver<TSource, TContext, TArgs>` is
  generic with `unknown` defaults, so a resolver may be **annotated** narrowly
  (`FieldResolver<IssueRow, DefaultGraphqlContext, { id: string }>`) and still assign to a
  `ResolverMap`. A resolver written **unannotated** — `(source, args) => …`, the ordinary
  schema-first shape — takes its parameter types contextually from `AnyFieldResolver`, so `args` is
  `Record<string, unknown>` rather than `never`. The map entry is bivariant for exactly this reason:
  a non-bivariant entry can serve one style or the other, never both. Subscription entries follow
  the same rule through `AnySubscriptionResolver`, so a typed
  `{ subscribe, resolve: (payload: Book) => … }` assigns too.
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
- **Subscriptions are opt-in and never ride the HTTP endpoint.** Supply `subscriptions` to register
  the transports; omit it and no transport route exists. `POST`/`GET /graphql` continues to refuse a
  subscription operation with `400 SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`, unchanged — a
  subscription is served only on `` `${path}/ws` `` and `` `${path}/stream` ``.
- **Declaring a subscription (schema-first).** A `Subscription` field's resolver entry is a
  `SubscriptionResolver` — `{ subscribe, resolve? }` — not a bare function. `subscribe` returns the
  async iterable the field streams from and is attached to the schema field's own `subscribe` slot;
  graphql reads the event source from there and nowhere else.
- **Both transports require `CAPABILITIES.RUNTIME`.** They take their timers (the connection-init
  timeout, the protocol ping, the SSE keep-alive) from `IRuntimeServices` rather than global timers,
  so configuring `subscriptions` without a registered runtime throws at registration naming the
  requirement — rather than failing at the first connection.
- **The WebSocket transport is optional and self-limiting.** It registers only when
  `CAPABILITIES.WEBSOCKET` is present AND `IWebSocketService.available` is `true`; otherwise the
  plugin logs a notice and everything else carries on. The route claims `heartbeat: false` on
  `WebSocketRouteOptions`, because `websocket-plugin`'s shared sweeper sends a raw text frame that a
  conformant `graphql-transport-ws` client must answer by closing `4400`. Liveness on that route is
  the protocol's own `ping`/`pong`, configured by `subscriptions.websocket.heartbeatMs`.
- **Authenticating a subscription.** `subscriptions.websocket.onConnect` runs on `connection_init`
  before the ack, receives the `GraphqlConnectionInfo` (including `connectionParams` — the
  protocol's auth channel — plus the upgrade headers and query), and closes the socket with
  `4403: Forbidden` when it returns `false`. Writing to `conn.data` there sets the `user`/`tenant`
  the default resolver context reads back. With no hook configured the socket is accepted.
- **Resolver context over a socket.** A WebSocket carries no `IRequestContext`, so
  `IGraphqlService.subscribe` takes a `GraphqlOperationContext` instead. On that path `services` is
  the plugin-level `IServiceRegistry`, so a subscription resolver reaches every capability an HTTP
  resolver can.
- **Errors inside a live subscription are masked.** `maskInternalErrors` applies identically on
  every transport: masking happens once, in the service, and the transports put the already-masked
  payload on the wire.
- **SSE follows the graphql-sse protocol, not the HTTP watershed.** In distinct-connections mode a
  GraphQL **request** error (parse, validation, operation resolution) is delivered INSIDE the
  accepted `text/event-stream` as a `next` event followed by `complete` — not as a `400`, which
  would make the user agent fail the connection and give native `EventSource` nothing to read. A
  **transport** failure that happens before any GraphQL request exists (unsupported content type,
  unparseable body, a missing `query` parameter) is still an ordinary buffered HTTP error. A
  persisted-query miss counts as a request error and is therefore delivered in-stream too. The
  `complete` frame always carries an empty `data:` field, without which `EventSource` never fires
  the listener.
- **Automatic Persisted Queries verify the hash.** A request carrying both a query and a hash is
  persisted only when `sha256(query)` matches the submitted `sha256Hash`; a mismatch answers
  `PERSISTED_QUERY_HASH_MISMATCH`. Without that check any client could store a document under a hash
  another client later executes — a cache-poisoning primitive, and worst when the store is a shared
  Redis. A hash-only request that misses answers `PersistedQueryNotFound` /
  `PERSISTED_QUERY_NOT_FOUND`, the standard retry signal. Entries live under the `apq:` namespace in
  `CAPABILITIES.CACHE` when one is registered, and in a bounded in-process LRU otherwise. Hashing
  uses `IRuntimeServices.subtle`, so configuring `apq` without `CAPABILITIES.RUNTIME` throws at
  registration.
- **Batching is opt-in.** `maxBatchSize: 0` (the default) keeps refusing an array body with `400`.
  Above `0`, an array body executes its elements concurrently and answers a JSON array in request
  order; over the limit is `400 BATCH_TOO_LARGE`. A batch always answers `application/json` — the
  `application/graphql-response+json` media type describes a single result and cannot express an
  array, so an array body from a client negotiating it is refused with `400 BATCHING_NOT_SUPPORTED`.
- **Custom scalars.** In the schema-first arm a resolver-map entry for a scalar type supplies any
  subset of `serialize`, `parseValue`, and `parseLiteral`; omitted members keep graphql's identity
  default.

---

## Static Files Plugin (`@setu-ts/static-plugin`)

**Package:** `@setu-ts/static-plugin`

**Token:** `CAPABILITIES.STATIC_FILES = 'static-files'`

### Registration

```typescript
import { StaticPlugin } from '@setu-ts/static-plugin';

app.register(StaticPlugin({
  root: './public',
  urlPrefix: '/assets',
}));
```

### Options

| Option           | Type                           | Default                                | Description                                                                              |
| ---------------- | ------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `root`           | `string`                       | (required)                             | Directory to serve files from                                                            |
| `urlPrefix`      | `string`                       | `'/'`                                  | URL prefix for static routes                                                             |
| `index`          | `string`                       | `'index.html'`                         | Index file for directories                                                               |
| `fallback`       | `string`                       | `undefined`                            | SPA fallback file                                                                        |
| `cacheControl`   | `string \| ((path) => string)` | Hashed→immutable, else must-revalidate | Cache-Control header. A callback receives a **leading-slash** root-relative request path |
| `etag`           | `boolean`                      | `true`                                 | Enable ETag generation                                                                   |
| `ranges`         | `boolean`                      | `true`                                 | Enable Range requests                                                                    |
| `compressed`     | `boolean`                      | `true`                                 | Negotiate .br/.gz sidecars                                                               |
| `maxBufferBytes` | `number`                       | `1048576`                              | Threshold for streaming                                                                  |

### Exports

| Export                | Kind      | Description                         |
| --------------------- | --------- | ----------------------------------- |
| `StaticPlugin`        | function  | Plugin factory                      |
| `StaticFilesService`  | class     | Service implementing `IStaticFiles` |
| `createStaticHandler` | function  | Standalone route handler            |
| `IStaticFiles`        | interface | Service interface                   |
| `StaticPluginOptions` | type      | Plugin options type                 |

`IStaticFiles` declares one method:

```typescript
serve(ctx: IRequestContext): Promise<HandlerResult>;
```

### Notes

- Mounts routes on both `GET` and `HEAD`
- **A root `urlPrefix` claims `GET /*` and `HEAD /*`, which no second plugin can share.** The plugin
  registers `<urlPrefix>/*`, so `urlPrefix: '/'` mounts the bare wildcard — and the kernel refuses a
  duplicate `METHOD path`, naming the plugin that registered it first
  (`Route 'GET /*' is already registered by plugin 'react-router'.`). An application serving SSR at
  the root therefore cannot also mount static files there: give the static files their own prefix
  (`urlPrefix: '/assets'`), which is the arrangement content-hashed assets want anyway
- Conditional requests: `ETag`, `If-None-Match`, `If-Modified-Since` → `304`
- Range requests: `206` with `Content-Range`, `416` for unsatisfiable
- The `ETag` is **strong** (`"<size>-<mtimeMs>"`) when the runtime reports an `mtime`, and degrades
  to a **weak** size-only validator when it does not. This matters for resumption: `If-Range` MUST
  be ignored for a weak validator (RFC 9110 §13.1.5), so an interrupted download resumes only
  against the strong form. `size`+`mtime` is what nginx and Apache emit as strong for static files
- Precompressed sidecars: `.br` preferred over `.gz`, ETag from sidecar stat
- `Cache-Control` is resolved from the **original root-relative request path with a leading slash**,
  never the absolute filesystem path and never the `.br`/`.gz` sidecar path — so a content-hashed
  asset keeps its `immutable` policy whichever encoding is negotiated. A `cacheControl` function
  receives `/assets/app-A9acsx54.js` (not `assets/app-…`, not `/srv/assets/app-…`), and the literal
  `'/'` when the request equals the prefix root. The leading slash is guaranteed for BOTH shapes —
  before it was normalised, a file arrived slash-less while the prefix root arrived as `'/'`, so a
  callback written against one observed shape was silently wrong for the other.
- A `HEAD` opens no body stream, so it cannot leak a file descriptor on a file above
  `maxBufferBytes`
- An explicit `Accept-Encoding` entry overrides the wildcard, so `br;q=0, *` refuses brotli
- Workers degradation: registers capability but mounts no route when `fs` is absent
- Health indicator: reports `up`/`down`/`degraded` based on root directory accessibility

---

## Boundary-Type Compatibility

Applications own their third-party dependency resolution. Setu-TS therefore does not freeze a
consumer's dependency graph; it declares the third-party values it accepts at an application
boundary and tests those claims in `deno task check:compat`.

| Third-party value                  | Owning packages                                           | Supported versions                 | Boundary and compatibility rule                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod schemas                        | `validation-plugin`, `openapi-plugin`, `decorator-plugin` | zod `>=3.24.0 <4` and `>=4.4.0 <5` | Validation uses public `safeParse`; OpenAPI uses Zod v4's public `toJSONSchema()`. The legacy Zod v3 transformer has no equivalent public conversion API, so its private-internal compatibility is limited to the stated v3 range and tested separately. Decorators forward schemas to the validation/OpenAPI boundaries without inspecting them. |
| Drizzle database and table objects | `database-plugin`                                         | `0.45.2` baseline; range pending   | The application creates the database configuration and tables; the plugin loads its own query operators. Its exact lazy-loader import is a separate resolution-policy repair, so no broader application-instance range is claimed until that pin is removed and both endpoints are tested.                                                        |
| Prisma client                      | `database-plugin`                                         | **Pending boundary repair**        | Prisma v7 is the current application integration, but no formal range is claimed until the adapter stops its `_activeProvider` fallback and relies solely on the documented `provider` option plus public client methods.                                                                                                                         |

GraphQL is intentionally absent: `graphqlModule` is a package-declared `GraphqlModuleLike` facade,
not an opaque `unknown` value. Its compile-time shape and adapter tests cover that boundary.

## Summary

The Setu-TS public API is designed for developer experience:

1. **Start minimal** — Just kernel + runtime, add plugins as needed
2. **Everything is replaceable** — Any plugin can be swapped via capability tokens
3. **Full programmatic API** — No feature requires decorators or reflection
4. **Optional decorators** — Available for those who prefer NestJS-style DX
5. **Type-safe** — Full TypeScript support with no `any` in public APIs
6. **Runtime independent** — Runs on Node.js, Deno, Bun, and Cloudflare Workers (future)
7. **Testable** — Built-in test utilities, mock plugins, request injection
8. **Enterprise-ready** — Auth, secrets, audit, resilience, multi-tenancy, feature flags
