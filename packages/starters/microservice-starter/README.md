# @hono-enterprise/microservice-starter

Opinionated plugin composition for building microservices with Hono Enterprise.

Extends the REST starter bundle with additional capabilities essential for distributed systems:
messaging, queue processing, resilience patterns, and telemetry. Ideal for service-oriented
architectures requiring async communication, circuit breakers, and observability.

## Installation

```bash
deno add jsr:@hono-enterprise/microservice-starter
```

Or via npm/yarn/pnpm:

```bash
npm install @hono-enterprise/microservice-starter
```

## Usage

The starter exports `createMicroserviceApp` — a fully wired application combining REST plugins plus
microservice-specific features:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';

const app = createMicroserviceApp();

app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

await app.start({ port: 3000 });
```

### With Options

Customize all plugin configurations through the optional options parameter:

```typescript
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';
import type { MicroserviceStarterOptions } from '@hono-enterprise/microservice-starter';

const options: MicroserviceStarterOptions = {
  // REST base plugins (see rest-starter)
  config: {/* ... */},
  logger: {/* ... */},

  // Microservice additions
  messaging: {/* messaging plugin options */},
  queue: {/* queue plugin options */},
  resilience: {/* resilience plugin options */},
  telemetry: {/* telemetry plugin options */},
};

const app = createMicroserviceApp(options);
```

### Advanced Plugin Composition

Use `buildMicroservicePlugins` together with `createApplication` from the kernel to construct a
custom plugin array with full control over ordering and configuration:

```typescript
import { buildMicroservicePlugins } from '@hono-enterprise/microservice-starter';
import { createApplication } from '@hono-enterprise/kernel';

const app = createApplication({
  plugins: buildMicroservicePlugins({
    messaging: {}, // provide options object; omit to use default
    queue: {/* custom config */},
    // telemetry omitted to exclude (no-op default)
  }),
});
```

## Included Plugins

| Category         | Plugin             | Description               |
| ---------------- | ------------------ | ------------------------- |
| **REST Base**    | RuntimePlugin      | Core runtime integration  |
|                  | ConfigPlugin       | Configuration management  |
|                  | LoggerPlugin       | Structured logging        |
|                  | ValidationPlugin   | Request validation        |
|                  | HttpSecurityPlugin | Security headers          |
|                  | HealthPlugin       | Health check endpoints    |
|                  | MetricsPlugin      | Metrics collection        |
|                  | OpenApiPlugin      | OpenAPI documentation     |
|                  | DecoratorPlugin    | Decorator-based routing   |
|                  | DatabasePlugin     | Optional database access  |
|                  | AuthPlugin         | Optional authentication   |
| **Microservice** | MessagingPlugin    | Async message bus support |
|                  | QueuePlugin        | Background job queueing   |
|                  | ResiliencePlugin   | Circuit breaker & retries |
|                  | TelemetryPlugin    | Tracing & observability   |

All microservice plugins are enabled by default; individual plugins can be configured or omitted via
options.

### Workers Portability

This starter bundles **MessagingPlugin** and **QueuePlugin**, which require raw network sockets
(TCP/UDP) and are therefore **not compatible with Cloudflare Workers**. This starter is for Node.js,
Deno, or Bun runtimes only — matching the CLI's refusal of
`--template microservice --runtime cloudflare-workers`. The REST base plugins (Runtime, Config,
Logger, etc.) are all edge-safe.

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
import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

const app = createMicroserviceApp();
app.register(CachePlugin({ name: 'session' }));
app.register(QueuePlugin({ name: 'dead-letter' }));
```

This escape hatch works because `createMicroserviceApp` returns an un-started `IKernelApplication`
that accepts additional registrations.

## Realtime and DI arms

`createMicroserviceApp` inherits the `realtime` and `di` arms from the REST starter — the option
type extends `RestStarterOptions`, so every sub-arm behaves identically and nothing new is
registered by default.

```typescript
const app = createMicroserviceApp({
  di: {},
  realtime: { sse: {}, websocket: {}, backplane: { transport: 'messaging' } },
});
```

`{ transport: 'messaging' }` works on this tier without extra wiring: `MessagingPlugin` is always
registered, so the backplane finds a broker under `CAPABILITIES.MESSAGING`. On the REST tier that
combination throws at `start()`.

See
[rest-starter](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/starters/rest-starter/README.md)
for the full description of each arm.

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

- [JSR Registry](https://jsr.io/@hono-enterprise/microservice-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [rest-starter](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/starters/rest-starter/README.md)
