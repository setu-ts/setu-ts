# @setu-ts/microservice-starter — the REST set plus async messaging

`createMicroserviceApp(options?)` is the REST starter's composition plus four always-registered
plugins: messaging (in-memory broker by default), queue (memory adapter), resilience, and telemetry
(no-op with no exporter). The `errorHandler` from the REST tier arrives with it at priority 0.
Starters are composition libraries, and `setu add` has no short name for them — install
`@setu-ts/microservice-starter` directly.

```ts
import { createMicroserviceApp } from '@setu-ts/microservice-starter';

const app = createMicroserviceApp({
  queue: { adapter: 'memory' },
  messaging: {},
  telemetry: { serviceName: 'orders', exporter: 'console' },
  realtime: { backplane: { transport: 'messaging' } },
});

app.router.get('/healthz', (ctx) => ctx.response.text('ok'));
await app.start({ port: 3000 });
```

```ts
import { buildMicroservicePlugins } from '@setu-ts/microservice-starter';
import { createApplication } from '@setu-ts/kernel';

export const app = createApplication({
  plugins: buildMicroservicePlugins({ queue: { adapter: 'memory' } }),
});
```

- Four added arms, always registered: `messaging`, `queue`, `resilience`, `telemetry`. Omitted →
  in-memory broker, memory queue adapter, plugin defaults, and a telemetry no-op with no exporter.
- Inherits every REST arm, gated ones included: `database`, `auth`, `session`, `di`, `graphql`,
  `serviceDiscovery`, `realtime.websocket`, `realtime.sse`, `realtime.backplane`.
- `realtime: { backplane: { transport: 'messaging' } }` works here because the broker is always
  registered; on the REST tier that combination throws at start.
- The `microservice` CLI template swaps `messaging` and `queue` for `CloudflarePlugin` from
  `@setu-ts/cloudflare-plugin` on Workers; this starter performs no swap and registers both
  unconditionally.
- OpenAPI self-hosts Swagger UI: install `swagger-ui-dist` (`^5`) or pass
  `openapi: { swagger: { assets: 'cdn' } }`.
- No arm sets a plugin `name`; register extra instances on the returned app.
- `buildMicroservicePlugins(options)` returns the plugin array for `createApplication` and does not
  add the error-handler middleware.
