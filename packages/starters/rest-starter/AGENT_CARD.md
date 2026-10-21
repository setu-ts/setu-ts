# @setu-ts/rest-starter — one factory for the REST plugin set

Starters are composition libraries, not plugins: nothing to register, and `setu add` has no short
name for them — install `@setu-ts/rest-starter` directly. `createRestApp(options?)` returns an
un-started `IKernelApplication` built from the REST plugin set — runtime, config, logger,
validation, HTTP security, health, metrics, OpenAPI and decorators — plus
`errorHandler({ format: 'rfc9457' })` at priority 0. A scaffolded rest project inlines this list
instead; reach for the starter when you want it named once.

```ts
import { createRestApp } from '@setu-ts/rest-starter';

const app = createRestApp({
  logger: {},
  database: { type: 'memory' },
  session: { secret: 'replace-with-at-least-32-characters', csrf: {} },
  realtime: { sse: {}, backplane: { transport: 'memory' } },
});

app.router.get('/hello', (ctx) => ctx.response.text('Hello'));
await app.start({ port: 3000 });
```

```ts
import { buildRestPlugins } from '@setu-ts/rest-starter';
import { createApplication } from '@setu-ts/kernel';

export const app = createApplication({
  plugins: buildRestPlugins({ database: { type: 'memory' } }),
});
```

- Always-on arms configure a plugin the starter always registers: `config`, `logger`, `validation`,
  `httpSecurity`, `health`, `metrics`, `openapi`, `decorators`. Omitted → that plugin's defaults.
- Gated arms register nothing unless supplied: `database`, `auth`, `session`, `di`, `graphql`,
  `serviceDiscovery`, and each `realtime` sub-arm (`websocket`, `sse`, `backplane`). `realtime: {}`
  adds nothing and is not an error.
- Gated because they cannot be defaulted: `session` throws without a secret, `auth` needs a passive
  strategy, `graphql` needs a schema, and `di` changes how every decorated service is constructed.
- OpenAPI self-hosts Swagger UI: install `swagger-ui-dist` (`^5`) or pass
  `openapi: { swagger: { assets: 'cdn' } }`. On Workers the starter selects CDN for you.
- No arm sets a plugin `name`; each registers on the bare capability token. Add a second instance on
  the returned app: `app.register(CachePlugin({ name: 'session' }))`.
- `backplane: { transport: 'messaging' }` throws during `app.start()` here — this tier registers no
  broker; use the microservice starter.
