# @setu-ts/rest-starter

Opinionated plugin composition for building REST APIs with Setu-TS.

Provides a pre-configured set of plugins for building production-ready REST applications, including
configuration, logging, validation, security, health checks, metrics, OpenAPI documentation,
decorators, database support, and authentication.

## Installation

```bash
deno add jsr:@setu-ts/rest-starter
```

Or via npm/yarn/pnpm when using the Node-compatible runtime:

```bash
npm install @setu-ts/rest-starter
```

## Usage

The starter exports a single factory function `createRestApp` that returns a fully wired application
with error handling already configured:

```typescript
import { createRestApp } from '@setu-ts/rest-starter';

const app = createRestApp();

app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

await app.start({ port: 3000 });
```

### With Options

You can customize plugin configuration through the optional `options` parameter:

```typescript
import { createRestApp } from '@setu-ts/rest-starter';
import type { RestStarterOptions } from '@setu-ts/rest-starter';

const options: RestStarterOptions = {
  config: {/* config plugin options */},
  logger: {/* logger plugin options */},
  validation: {/* validation plugin options */},
  httpSecurity: {/* http-security plugin options */},
  health: {/* health plugin options */},
  metrics: {/* metrics plugin options */},
  openapi: {/* openapi plugin options */},
  decorators: {/* decorator plugin options */},
  database: {/* database plugin options */},
  auth: {/* auth plugin options */},
  session: {/* session plugin options */},
  di: {/* di plugin options */},
  realtime: {
    websocket: {/* websocket plugin options */},
    sse: {/* sse plugin options */},
    backplane: {/* realtime-backplane plugin options */},
  },
};

const app = createRestApp(options);
```

### Advanced Plugin Composition

For scenarios requiring custom plugin ordering or selective inclusion, use the `buildRestPlugins`
builder function together with `createApplication` from the kernel:

```typescript
import { buildRestPlugins } from '@setu-ts/rest-starter';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication({
  plugins: buildRestPlugins({
    database: { type: 'memory' }, // provide options object; omit to exclude
    auth: {
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    },
  }),
});
```

## Included Plugins

| Plugin             | Description                            |
| ------------------ | -------------------------------------- |
| RuntimePlugin      | Core runtime integration               |
| ConfigPlugin       | Configuration management               |
| LoggerPlugin       | Structured logging                     |
| ValidationPlugin   | Request/response validation            |
| HttpSecurityPlugin | HTTP security headers                  |
| HealthPlugin       | Health check endpoints                 |
| MetricsPlugin      | Application metrics collection         |
| OpenApiPlugin      | OpenAPI/Swagger documentation          |
| DecoratorPlugin    | Decorator-based route registration     |
| DatabasePlugin     | Optional — database access layer       |
| AuthPlugin         | Optional — authentication middleware   |
| DiPlugin           | Optional — DI container                |
| WebSocketPlugin    | Optional — WebSocket messaging         |
| SsePlugin          | Optional — Server-Sent Events          |
| RealtimeBackplane  | Optional — cross-replica fan-out       |
| SessionPlugin      | Optional — cookie sessions + form CSRF |

Gated plugins (`database`, `auth`, `session`, `di`, and each `realtime` sub-arm) are only included
when explicitly provided in options.

### The `session` arm

Adds `SessionPlugin`: cookie-backed sessions under `CAPABILITIES.SESSION`, and — with `csrf` — the
synchronizer-token form-CSRF middleware at priority 275, which is the check a
progressive-enhancement `<Form>` post can satisfy (the stateless Origin/Referer check in
`httpSecurity` structurally cannot). Running both together is intended.

```typescript
const app = createRestApp({
  session: { secret: Deno.env.get('SESSION_SECRET')!, csrf: {} },
});
```

It is gated rather than always-on because the secret cannot be defaulted: `SessionPlugin` throws
during `register()` without an adequate one, so an always-on arm would stop every application from
booting until it supplied one. A token-authenticated API needs no cookie at all.

### The `realtime` arm

One option groups the three plugins that make a connection-oriented application work. Each sub-arm's
presence adds exactly its plugin; `realtime: {}` adds nothing and is not an error.

```typescript
const app = createRestApp({
  realtime: {
    sse: {},
    websocket: {},
    // Without a backplane, rooms and channels reach only clients connected to
    // THIS replica, and both plugins log a scaling notice.
    backplane: { transport: 'redis', url: 'redis://localhost:6379' },
  },
});
```

The backplane registers at `PLUGIN_PRIORITY.HIGH`, so it precedes both consumers regardless of
option order. `backplane: {}` selects the in-process `'memory'` transport.

`{ transport: 'messaging' }` carries frames over whatever broker is registered under
`CAPABILITIES.MESSAGING`. The REST tier registers no broker, so that combination throws at `start()`
naming `MessagingPlugin` — use the microservice starter, which always registers one, or register
`MessagingPlugin` yourself before starting.

On Node and Bun a WebSocket upgrade needs a real listening server, so under `app.inject()` the
plugin registers with `available: false`. The same application code is correct on Deno and Workers.

### The `di` arm

Supplying `di` registers `DiPlugin`, and that **changes how every decorated service in the
application is constructed**: `DecoratorPlugin` branches on the presence of a container, so each
`@Injectable` class becomes a container provider honoring its `scope`. Omitted (the default), those
classes are constructed directly and registered in the kernel's `ServiceRegistry`.

That is why it is an arm rather than always-on — a starter app that never asks for it composes
exactly as it did before the option existed.

## Coming from NestJS

| NestJS                        | Setu-TS                                                         |
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

### Workers Portability

All plugins bundled by default in this starter are compatible with Cloudflare Workers (edge
runtime). The default REST starter is fully Workers-portable — every plugin uses only standard Web
APIs (`fetch`, `Request`, `Response`) and has no filesystem or network-socket dependencies. You can
deploy an app built with `rest-starter` directly to Workers via
`export default { fetch: app.fetch }`.

The gated arms vary. `di`, `realtime.websocket`, `realtime.sse`, and a `'memory'` backplane are all
Workers-portable. A `'redis'` backplane is not — it needs a raw socket. A `'messaging'` backplane is
portable only if the broker under `CAPABILITIES.MESSAGING` is.

### Multi-instance Restriction + Escape Hatch

The four multi-instance plugins (**cache**, **database**, **queue**, **messaging**) accept an
`options.name` parameter that creates a derived capability token. The starter registers **one
instance per arm on the bare token** (e.g., `CAPABILITIES.CACHE`). Setting `name` through a starter
arm moves the plugin off the bare token, which will break any code that resolves the capability
(including health checks and documentation examples).

The starter does **not** support setting `name` through its option arms. If you need a second
instance (e.g., a session cache distinct from the default), register it manually after the starter
returns:

```typescript
import { createRestApp } from '@setu-ts/rest-starter';
import { CachePlugin } from '@setu-ts/cache-plugin';

const app = createRestApp();
app.register(CachePlugin({ name: 'session' }));
```

This escape hatch works because `createRestApp` returns an un-started `IKernelApplication` that
accepts additional registrations.

## See Also

- [JSR Registry](https://jsr.io/@setu-ts/rest-starter)
- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md)
