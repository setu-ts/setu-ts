# @setu-ts/full-stack-starter

Opinionated plugin composition for building full-stack applications with Setu-TS.

The most comprehensive starter bundle, combining REST capabilities, microservice patterns, and
full-stack features including caching, event-driven architecture, CQRS, scheduling, auditing,
secrets management, storage, mail delivery, feature flags, notifications, multi-tenancy, and React
SSR support.

## Installation

```bash
deno add jsr:@setu-ts/full-stack-starter
```

Or via npm/yarn/pnpm:

```bash
npm install @setu-ts/full-stack-starter
```

## Usage

The starter exports `createFullStackApp` — a fully wired application with all enterprise-grade
plugins pre-configured:

```typescript
import { createFullStackApp } from '@setu-ts/full-stack-starter';

const app = createFullStackApp();

app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

await app.start({ port: 3000 });
```

### With Options

Configure every plugin through the optional options parameter:

```typescript
import { createFullStackApp } from '@setu-ts/full-stack-starter';
import type { FullStackStarterOptions } from '@setu-ts/full-stack-starter';

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
  featureFlags: { provider: 'memory' },
  notifications: { channels: {} },
  multiTenancy: { resolver: 'header' },
  reactRouter: { serverBuildPath: './build/server/index.js' },
  static: { root: './build/client', urlPrefix: '/assets' },
};

const app = createFullStackApp(options);
```

### Advanced Plugin Composition

Use `buildFullStackPlugins` together with `createApplication` from the kernel to construct a custom
plugin array for advanced scenarios requiring selective inclusion or different ordering:

```typescript
import { buildFullStackPlugins } from '@setu-ts/full-stack-starter';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication({
  plugins: buildFullStackPlugins({
    cache: {}, // provide options object; omit to use default memory store
    events: {}, // provide options object; omit to use in-memory bus default
    reactRouter: { serverBuildPath: './build/server/index.js' },
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

The inherited `auth` arm accepts any `AuthPluginOptions` with at least one passive strategy (`jwt`,
`apiKey`, `session`, or `strategies`). When present, `AuthPlugin` installs authentication middleware
globally at priority 300 unless `auth.middleware` disables or moves it.

Gated plugins (`featureFlags`, `notifications`, `multiTenancy`, `reactRouter`, `static`) are only
registered when explicitly provided in options. The `static` arm exists because this is the one tier
that by definition serves a browser: supplying it registers `StaticPlugin` with the given options
(typically `root: './build/client'` so hashed assets and `public/` files are served beside SSR);
omitting it registers nothing, so the default composition stays byte-identical to before the option
existed. A root-level `urlPrefix` claims the bare wildcard and would collide with the SSR catch-all
— give static files their own prefix.

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
import { createFullStackApp } from '@setu-ts/full-stack-starter';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';

const app = createFullStackApp();
app.register(CachePlugin({ name: 'session' }));
app.register(QueuePlugin({ name: 'dead-letter' }));
```

This escape hatch works because `createFullStackApp` returns an un-started `IKernelApplication` that
accepts additional registrations.

## Realtime and DI arms

`createFullStackApp` inherits the `realtime`, `di`, and optional `serviceDiscovery` arms from the
REST starter — the option type extends `RestStarterOptions`, so every sub-arm behaves identically
and nothing new is registered by default.

```typescript
const app = createFullStackApp({
  di: {},
  serviceDiscovery: { provider: 'static', services: {} },
  realtime: { sse: {}, websocket: {}, backplane: { transport: 'messaging' } },
});
```

`{ transport: 'messaging' }` works on this tier without extra wiring, because the microservice set
it composes from always registers `MessagingPlugin`.

None of these arms collide with the plugins this tier already bundles — `sse`, `websocket`, `di`,
and the backplane are registered by no other arm. `di: {}` builds a container that falls back to the
kernel registry, so decorated classes can inject framework capabilities; see
[Constructor injection in loaders](#constructor-injection-in-loaders).

The `session` arm is inherited the same way: `session: { secret, csrf: {} }` adds cookie sessions
and the form-CSRF middleware, which a server-rendered `<Form>` post needs.

See
[rest-starter](https://github.com/setu-ts/setu-ts/blob/main/packages/starters/rest-starter/README.md)
for the full description of each arm.

## Constructor injection in loaders

React Router builds its loaders and actions itself, so the container never constructs them. A loader
reaches an injected service the same way it reaches the session: `populateLoadContext` resolves it
for each request and puts it on a context key the loader reads.

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type IContainer, type ILogger } from '@setu-ts/common';
import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';
import { contextKeyFor } from '@setu-ts/react-router-plugin';

@Injectable({ token: 'pricing-service', scope: 'singleton' })
@Inject(CAPABILITIES.LOGGER)
export class PricingService {
  constructor(private readonly logger: ILogger) {}
  quote(cents: number): string {
    this.logger.debug('pricing: quote');
    return `$${(cents / 100).toFixed(2)}`;
  }
}

// Declare it beside the template's other keys in app/lib/context-keys.server.ts:
// contextKeyFor reuses one key per name; separate { defaultValue: null } objects would not.
export const pricingContext = contextKeyFor<PricingService | null>('app.pricing', null);

const app = await createFullStackAppFromConfig(() => ({
  di: {},
  decorators: { services: [PricingService] },
  reactRouter: {
    serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
    populateLoadContext: (ctx, context) => {
      const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
      context.set(pricingContext, container.resolve<PricingService>('pricing-service'));
    },
  },
}));

await app.start({ port: 3000 });
```

A loader then calls `context.get(pricingContext)?.quote(4900)`.

Three things to know:

- **`di: {}` falls back to the kernel registry.** `DiPlugin`'s `autoRegister` defaults to `true`,
  which is what lets `@Inject(CAPABILITIES.LOGGER)` find the framework's own services. On `0.8.0`
  and earlier it defaulted to `false`, so write `di: { autoRegister: true }` there, or every page
  answers 500 with `No provider registered for DI token 'logger'`.
- **There is no per-request scope.** Nothing creates a scope for each request, so a `scoped` service
  resolved from the root container acts as a singleton. For one instance per request, call
  `container.createScope()` in `populateLoadContext` and resolve from the scope.
- **A DI mistake fails every page, not startup.** An unlisted service, a misspelled token, or a
  missing `di` arm starts cleanly and answers `/health` with 200, then throws in
  `populateLoadContext` on every server-rendered request. The smoke test `setu new` generates
  requests `/` as well as `/health`, so `deno task test` catches it; keep that request in.

## Composing from configuration

Plugin options must be decided **before** the plugins are constructed — which is before
`ConfigPlugin` has registered anything, so `ctx.services.get(CAPABILITIES.CONFIG)` is not available
yet. `createFullStackAppFromConfig` closes that ordering gap for every option at once:

```typescript
import { createFullStackAppFromConfig, fullStackConfigOf } from '@setu-ts/full-stack-starter';

const app = await createFullStackAppFromConfig((config) => ({
  // `prismaClient` is generated and constructed by the application — a Prisma v7
  // client carries its own connection configuration, so `url` is not an option.
  database: { type: 'prisma', options: { prismaClient } },
  session: { secret: config.getOrThrow<string>('SESSION_SECRET'), csrf: {} },
}), { config: { envFilePath: ['.env.local', '.env'] } });

const config = fullStackConfigOf(app); // the exact snapshot passed to the callback

await app.start({ port: 3000 });
```

Configuration is loaded once and the **same snapshot** is registered under `CAPABILITIES.CONFIG`, so
the values the composition branched on are the values handlers read — not a second snapshot taken a
moment later. The resolver runs exactly once; if it throws, or configuration fails to load, the
promise rejects and no partially-composed application exists.

Post-factory code reads that same object with `fullStackConfigOf(app)`. Calling the accessor for an
application built by another factory throws `FullStackConfigUnavailableError`.

This is why no plugin option carries a config-key shorthand such as `urlFromConfig`: that field
would need its value at the same impossible moment. Secrets are further out of reach — they are
served by `secrets-plugin` after registration, so a plugin needing one resolves it lazily at use
time.

## The React Router app skeleton

This package supplies the plugin **composition**; it cannot supply the application's `app/`
directory, because a JSR library cannot write files into your project. Scaffold that with the CLI,
which generates a `setu.config.ts` calling `createFullStackAppFromConfig`:

```bash
setu new my-app --template full-stack
```

## Coming from NestJS

| NestJS                        | Setu-TS                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `@Module({ … })`              | A plugin — `IPlugin` with `provides: [CAPABILITIES.X]`          |
| `providers: [UserService]`    | `decorators: { services: [UserService] }`, or `app.register(…)` |
| `@Injectable()`               | `@Injectable({ token, scope })`                                 |
| Constructor injection by type | `@Inject(token, …)` on the class, one entry per argument        |
| `@Controller('/users')`       | `@Controller('/users')` — identical                             |
| `@Get()` / `@Post()`          | `@Get()` / `@Post()` — identical                                |
| `@Body()` / `@Query()`        | `@Params(Body(), Query())` — sources, listed in argument order  |
| Guard (`CanActivate`)         | `@UseGuards(fn)`, or an `auth-plugin` guard factory             |
| Pipe (`ValidationPipe`)       | `@ValidateBody(schema)` (Zod)                                   |
| Interceptor                   | `@UseInterceptors(fn)`                                          |
| Exception filter              | `@UseFilters(fn)`, or `errorHandler()` middleware               |
| `imports: [OtherModule]`      | `ctx.services.get(CAPABILITIES.X)` — no plugin imports another  |
| DI is required                | DI is the optional `di` arm                                     |

**The one difference that will bite you: constructor injection needs an explicit token.**

```typescript
import { Inject, Injectable } from '@setu-ts/decorator-plugin';
import { CAPABILITIES, type ILogger } from '@setu-ts/common';

@Injectable({ token: 'user-service' })
@Inject(CAPABILITIES.LOGGER)
class UserService {
  constructor(private logger: ILogger) {}
}
```

`constructor(private db: DatabaseService)` cannot work here. Inferring the token from the
parameter's type requires `emitDecoratorMetadata`, which Deno does not support — so the type is
simply not available at runtime. This is permanent, not a gap waiting to be filled.

Two consequences follow from the list being positional:

- The Nth entry binds the Nth constructor argument, so reordering the constructor without reordering
  the tokens misinjects every argument — they are one declaration and move together.
- A list shorter than the constructor leaves the trailing arguments `undefined`; a positional list
  cannot have gaps. Method parameters are separate, and bind with `@Params(...)`.

## See Also

- [JSR Registry](https://jsr.io/@setu-ts/full-stack-starter)
- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#starter-exports-and-option-arms)
- [rest-starter](https://github.com/setu-ts/setu-ts/blob/main/packages/starters/rest-starter/README.md)
- [microservice-starter](https://github.com/setu-ts/setu-ts/blob/main/packages/starters/microservice-starter/README.md)

## Exports

| Export                            | Kind      |
| --------------------------------- | --------- |
| `buildFullStackPlugins`           | function  |
| `createFullStackApp`              | function  |
| `createFullStackAppFromConfig`    | function  |
| `FullStackConfigUnavailableError` | class     |
| `fullStackConfigOf`               | function  |
| `FromConfigOptions`               | interface |
| `FullStackStarterOptions`         | interface |
| `RealtimeArm`                     | interface |
| `StaticPluginOptions`             | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
