# @hono-enterprise/rest-starter

Opinionated plugin composition for building REST APIs with Hono Enterprise.

Provides a pre-configured set of plugins for building production-ready REST applications, including
configuration, logging, validation, security, health checks, metrics, OpenAPI documentation,
decorators, database support, and authentication.

## Installation

```bash
deno add jsr:@hono-enterprise/rest-starter
```

Or via npm/yarn/pnpm when using the Node-compatible runtime:

```bash
npm install @hono-enterprise/rest-starter
```

## Usage

The starter exports a single factory function `createRestApp` that returns a fully wired application
with error handling already configured:

```typescript
import { createRestApp } from '@hono-enterprise/rest-starter';

const app = createRestApp();

app.get('/hello', () => 'Hello world');

await app.start({ port: 3000 });
```

### With Options

You can customize plugin configuration through the optional `options` parameter:

```typescript
import { createRestApp } from '@hono-enterprise/rest-starter';
import type { RestStarterOptions } from '@hono-enterprise/rest-starter';

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
};

const app = createRestApp(options);
```

### Advanced Plugin Composition

For scenarios requiring custom plugin ordering or selective inclusion, use the `buildRestPlugins`
builder function together with `createApplication` from the kernel:

```typescript
import { buildRestPlugins } from '@hono-enterprise/rest-starter';
import { createApplication } from '@hono-enterprise/kernel';

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

| Plugin             | Description                          |
| ------------------ | ------------------------------------ |
| RuntimePlugin      | Core runtime integration             |
| ConfigPlugin       | Configuration management             |
| LoggerPlugin       | Structured logging                   |
| ValidationPlugin   | Request/response validation          |
| HttpSecurityPlugin | HTTP security headers                |
| HealthPlugin       | Health check endpoints               |
| MetricsPlugin      | Application metrics collection       |
| OpenApiPlugin      | OpenAPI/Swagger documentation        |
| DecoratorPlugin    | Decorator-based route registration   |
| DatabasePlugin     | Optional — database access layer     |
| AuthPlugin         | Optional — authentication middleware |

Gated plugins (`database`, `auth`) are only included when explicitly provided in options.

### Workers Portability

All plugins bundled in this starter are compatible with Cloudflare Workers (edge runtime). The REST
starter is fully Workers-portable — every plugin uses only standard Web APIs (`fetch`, `Request`,
`Response`) and has no filesystem or network-socket dependencies. You can deploy an app built with
`rest-starter` directly to Workers via `export default { fetch: app.fetch }`.

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
import { createRestApp } from '@hono-enterprise/rest-starter';
import { CachePlugin } from '@hono-enterprise/cache-plugin';

const app = createRestApp();
app.register(CachePlugin({ name: 'session' }));
```

This escape hatch works because `createRestApp` returns an un-started `IKernelApplication` that
accepts additional registrations.

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/rest-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
