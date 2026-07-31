# @hono-enterprise/full-stack-starter

Opinionated plugin composition for building full-stack applications with Hono Enterprise.

The most comprehensive starter bundle, combining REST capabilities, microservice patterns, and
full-stack features including caching, event-driven architecture, CQRS, scheduling, auditing,
secrets management, storage, mail delivery, feature flags, notifications, multi-tenancy, and React
SSR support.

## Installation

```bash
deno add jsr:@hono-enterprise/full-stack-starter
```

Or via npm/yarn/pnpm:

```bash
npm install @hono-enterprise/full-stack-starter
```

## Usage

The starter exports `createFullStackApp` — a fully wired application with all enterprise-grade
plugins pre-configured:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';

const app = createFullStackApp();

app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

await app.start({ port: 3000 });
```

### With Options

Configure every plugin through the optional options parameter:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';
import type { FullStackStarterOptions } from '@hono-enterprise/full-stack-starter';

const options: FullStackStarterOptions = {
  // REST base plugins (see rest-starter)
  config: {/* ... */},
  logger: {/* ... */},

  // Microservice additions (see microservice-starter)
  messaging: {/* ... */},
  queue: {/* ... */},

  // Full-stack additions
  cache: {/* cache plugin options */},
  events: {/* events plugin options */},
  cqrs: {/* cqrs plugin options */},
  scheduler: {/* scheduler plugin options */},
  audit: {/* audit plugin options */},
  secrets: {/* secrets plugin options */},
  storage: {/* storage plugin options */},
  mail: {/* mail plugin options */},

  // Gated arms (only included when provided)
  featureFlags: {/* feature flags plugin options */},
  notifications: {/* notification plugin options */},
  multiTenancy: {/* multi-tenancy plugin options */},
  reactRouter: {/* react router plugin options */},
};

const app = createFullStackApp(options);
```

### Advanced Plugin Composition

Use `buildFullStackPlugins` together with `createApplication` from the kernel to construct a custom
plugin array for advanced scenarios requiring selective inclusion or different ordering:

```typescript
import { buildFullStackPlugins } from '@hono-enterprise/full-stack-starter';
import { createApplication } from '@hono-enterprise/kernel';

const app = createApplication({
  plugins: buildFullStackPlugins({
    cache: {}, // provide options object; omit to use default memory store
    events: {}, // provide options object; omit to use in-memory bus default
    reactRouter: {/* custom SSR config */},
    // Omit featureFlags, notifications, multiTenancy if not needed
  }),
});
```

## Included Plugins

| Category         | Plugin             | Description                    |
| ---------------- | ------------------ | ------------------------------ |
| **REST Base**    | RuntimePlugin      | Core runtime integration       |
|                  | ConfigPlugin       | Configuration management       |
|                  | LoggerPlugin       | Structured logging             |
|                  | ValidationPlugin   | Request validation             |
|                  | HttpSecurityPlugin | Security headers               |
|                  | HealthPlugin       | Health check endpoints         |
|                  | MetricsPlugin      | Metrics collection             |
|                  | OpenApiPlugin      | OpenAPI documentation          |
|                  | DecoratorPlugin    | Decorator-based routing        |
|                  | DatabasePlugin     | Optional database access       |
|                  | AuthPlugin         | Optional authentication        |
| **Microservice** | MessagingPlugin    | Async message bus support      |
|                  | QueuePlugin        | Background job queueing        |
|                  | ResiliencePlugin   | Circuit breaker & retries      |
|                  | TelemetryPlugin    | Tracing & observability        |
| **Full-Stack**   | CachePlugin        | Distributed caching            |
|                  | EventsPlugin       | Event publishing/subscribing   |
|                  | CqrsPlugin         | CQRS pattern support           |
|                  | SchedulerPlugin    | Scheduled task execution       |
|                  | AuditPlugin        | Audit trail logging            |
|                  | SecretsPlugin      | Secure secret management       |
|                  | StoragePlugin      | Object/file storage            |
|                  | MailPlugin         | Email delivery                 |
|                  | FeatureFlagsPlugin | Dynamic feature toggles        |
|                  | NotificationPlugin | Push/notification service      |
|                  | MultiTenancyPlugin | Tenant isolation               |
|                  | ReactRouterPlugin  | React SSR & file-based routing |

Gated plugins (`featureFlags`, `notifications`, `multiTenancy`, `reactRouter`) are only registered
when explicitly provided in options.

### Workers Portability

This starter bundles **MessagingPlugin** and **QueuePlugin**, which require raw network sockets and
are therefore **not compatible with Cloudflare Workers**. Additionally, **StoragePlugin** (local
filesystem), **MailPlugin** (SMTP), and **SchedulerPlugin** (timers) have Node/Deno/Bun-specific
dependencies that degrade or fail on Workers. The REST base plugins and CachePlugin/EventsPlugin are
edge-safe. Use this starter on Node.js, Deno, or Bun only — matching the CLI's refusal of
`--template microservice --runtime cloudflare-workers` (microservice inherits these constraints).

### Multi-instance Restriction + Escape Hatch

The four multi-instance plugins (**cache**, **database**, **queue**, **messaging**) accept an
`options.name` parameter that creates a derived capability token. The starter registers **one
instance per arm on the bare token** (e.g., `CAPABILITIES.CACHE`, `CAPABILITIES.MESSAGING`). Setting
`name` through a starter arm moves the plugin off the bare token, which will break any code that
resolves the capability (including health checks and documentation examples).

The starter does **not** support setting `name` through its option arms. If you need a second
instance (e.g., a session cache distinct from the default, or a separate queue for dead-letter
processing), register it manually after the starter returns:

```typescript
import { createFullStackApp } from '@hono-enterprise/full-stack-starter';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

const app = createFullStackApp();
app.register(CachePlugin({ name: 'session' }));
app.register(QueuePlugin({ name: 'dead-letter' }));
```

This escape hatch works because `createFullStackApp` returns an un-started `IKernelApplication` that
accepts additional registrations.

## Realtime and DI arms

`createFullStackApp` inherits the `realtime` and `di` arms from the REST starter — the option type
extends `RestStarterOptions`, so every sub-arm behaves identically and nothing new is registered by
default.

```typescript
const app = createFullStackApp({
  di: {},
  realtime: { sse: {}, websocket: {}, backplane: { transport: 'messaging' } },
});
```

`{ transport: 'messaging' }` works on this tier without extra wiring, because the microservice set
it composes from always registers `MessagingPlugin`.

None of these arms collide with the plugins this tier already bundles — `sse`, `websocket`, `di`,
and the backplane are registered by no other arm.

The `session` arm is inherited the same way: `session: { secret, csrf: {} }` adds cookie sessions
and the form-CSRF middleware, which a server-rendered `<Form>` post needs.

See
[rest-starter](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/starters/rest-starter/README.md)
for the full description of each arm.

## Composing from configuration

Plugin options must be decided **before** the plugins are constructed — which is before
`ConfigPlugin` has registered anything, so `ctx.services.get(CAPABILITIES.CONFIG)` is not available
yet. `createFullStackAppFromConfig` closes that ordering gap for every option at once:

```typescript
import { createFullStackAppFromConfig } from '@hono-enterprise/full-stack-starter';

const app = await createFullStackAppFromConfig((config) => ({
  database: { type: 'prisma', url: config.getOrThrow<string>('DATABASE_URL') },
  session: { secret: config.getOrThrow<string>('SESSION_SECRET'), csrf: {} },
}), { envFilePath: ['.env.local', '.env'] });

await app.start({ port: 3000 });
```

Configuration is loaded once and the **same snapshot** is registered under `CAPABILITIES.CONFIG`, so
the values the composition branched on are the values handlers read — not a second snapshot taken a
moment later. The resolver runs exactly once; if it throws, or configuration fails to load, the
promise rejects and no partially-composed application exists.

This is why no plugin option carries a config-key shorthand such as `urlFromConfig`: that field
would need its value at the same impossible moment. Secrets are further out of reach — they are
served by `secrets-plugin` after registration, so a plugin needing one resolves it lazily at use
time.

## The React Router app skeleton

This package supplies the plugin **composition**; it cannot supply the application's `app/`
directory, because a JSR library cannot write files into your project. Scaffold that with the CLI,
which generates a `honoe.config.ts` calling `createFullStackAppFromConfig`:

```bash
honoe new my-app --template full-stack
```

## Coming from NestJS

| NestJS                        | Hono Enterprise                                                 |
| ----------------------------- | --------------------------------------------------------------- |
| `@Module({ … })`              | A plugin — `IPlugin` with `provides: [CAPABILITIES.X]`          |
| `providers: [UserService]`    | `decorators: { services: [UserService] }`, or `app.register(…)` |
| `@Injectable()`               | `@Injectable({ token, scope })`                                 |
| Constructor injection by type | `@Inject(token)` on each constructor parameter                  |
| `@Controller('/users')`       | `@Controller('/users')` — identical                             |
| `@Get()` / `@Post()`          | `@Get()` / `@Post()` — identical                                |
| `@Body()` / `@Query()`        | `@Body()` / `@Query()` — identical                              |
| Guard (`CanActivate`)         | `@UseGuards(fn)`, or an `auth-plugin` guard factory             |
| Pipe (`ValidationPipe`)       | `@ValidateBody(schema)` (Zod)                                   |
| Interceptor                   | `@UseInterceptors(fn)`                                          |
| Exception filter              | `@UseFilters(fn)`, or `errorHandler()` middleware               |
| `imports: [OtherModule]`      | `ctx.services.get(CAPABILITIES.X)` — no plugin imports another  |
| DI is required                | DI is the optional `di` arm                                     |

**The one difference that will bite you: constructor injection needs an explicit token.**

```typescript
@Injectable({ token: 'user-service' })
class UserService {
  constructor(@Inject(CAPABILITIES.DATABASE) private db: IDatabase) {}
}
```

`constructor(private db: DatabaseService)` cannot work here. Inferring the token from the
parameter's type requires `emitDecoratorMetadata`, which Deno does not support — so the type is
simply not available at runtime. This is permanent, not a gap waiting to be filled.

Three consequences, each a startup throw rather than a silent misinjection:

- Leaving a constructor parameter undecorated (below the last injected one) throws, naming the class
  and the index.
- Mixing parameter-level `@Inject` with the deprecated class-level `@Inject('a', 'b')` list throws.
- `@Inject` on a _method_ parameter throws — those bind with `@Body`/`@Query`/`@Param`.

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/full-stack-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [rest-starter](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/starters/rest-starter/README.md)
- [microservice-starter](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/starters/microservice-starter/README.md)
