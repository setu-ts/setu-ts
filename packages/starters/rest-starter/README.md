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

For scenarios requiring custom plugin ordering or selective inclusion, export the `buildRestPlugins`
function to build a custom plugin array manually:

```typescript
import { buildRestPlugins, createApplication } from '@hono-enterprise/rest-starter';

const app = createApplication({
  plugins: buildRestPlugins({
    database: true, // enable with defaults
    auth: {/* custom auth options */},
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

## See Also

- [JSR Registry](https://jsr.io/@hono-enterprise/rest-starter)
- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
