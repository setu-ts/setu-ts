# @setu-ts/rest-starter — compose a REST application

**Add it:** install `@setu-ts/rest-starter` directly; it has no `setu add` entry. Call
`createRestApp` from `setu.config.ts`; the starter itself provides no capability and composes the
runtime, config, logger, validation, HTTP security, health, metrics, OpenAPI and decorator plugins.

## Start a REST service with cookie sessions

Use this factory in place of the scaffold's application construction, and put route registration in
the module's routes file:

```ts
import type { IRouterApi } from '@setu-ts/common';
import { createRestApp } from '@setu-ts/rest-starter';

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get('/greeting', {
    handler: (ctx) => ctx.response.json({ hello: 'world' }),
  });
}

const app = createRestApp({
  session: { secret: process.env.SESSION_SECRET!, csrf: {} },
  openapi: { swagger: { assets: 'cdn' } },
});
registerGreetingRoutes(app.router);
await app.start({ port: 3000 });
```

## Behaviour the types do not show

- The factory returns an unstarted application. Register routes and extra plugins before startup.
- It adds the RFC 9457 error handler at priority 0; `buildRestPlugins` returns only plugins and does
  not add that middleware.
- Omitted always-on arms use their plugin defaults. Gated arms register nothing until supplied;
  `realtime: {}` adds nothing.
- Sessions require a secret; their cookies default to secure, so plain HTTP development needs
  `session.cookie: { secure: false }`.
- OpenAPI self-hosts its UI unless CDN assets are selected; Workers select CDN automatically.
- A messaging backplane needs a broker; the REST tier does not supply one.

## Other options

- `config`, `logger`, `validation`, `httpSecurity`, `health`, `metrics`, `openapi`, `decorators`
  configure the always-on plugins.
- `database`, `auth`, `session`, `di`, `graphql` and `serviceDiscovery` are gated arms.
- `realtime.websocket`, `realtime.sse` and `realtime.backplane` opt into each real-time plugin.
- `buildRestPlugins(options)` supplies the array for a custom composition.
