# @setu-ts/full-stack-starter — compose a full application

**Add it:** scaffolding with `setu new my-app --template full-stack` wires this factory in
`setu.config.ts`; there is no `setu add` entry. The starter itself provides no capability; it
composes the microservice tier plus cache, events, CQRS, scheduling, audit, secrets, storage and
mail.

## Serve an application with the full plugin set

Use this instead of the scaffold's application construction; move the route function to the module's
routes file:

```ts
import type { IRouterApi } from '@setu-ts/common';
import { createFullStackApp } from '@setu-ts/full-stack-starter';

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get('/greeting', {
    handler: (ctx) => ctx.response.json({ hello: 'world' }),
  });
}

const app = createFullStackApp({ openapi: { swagger: { assets: 'cdn' } } });
registerGreetingRoutes(app.router);
await app.start({ port: 3000 });
```

## Load one configuration snapshot for composition and handlers

```ts
import { createFullStackAppFromConfig, fullStackConfigOf } from '@setu-ts/full-stack-starter';

const app = await createFullStackAppFromConfig(
  () => ({
    logger: { level: 'debug' },
    openapi: { swagger: { assets: 'cdn' } },
  }),
  { config: { envFilePath: ['.env.local', '.env'] } },
);
const config = fullStackConfigOf(app);
await app.start({ port: 3000 });
```

## Behaviour the types do not show

- Factories return unstarted applications with the RFC 9457 error handler at priority 0.
- The config factory loads once before constructing plugins; `CAPABILITIES.CONFIG` (`IConfig`)
  receives the same snapshot the callback saw.
- `fullStackConfigOf` throws `FullStackConfigUnavailableError` for apps from another factory.
- On Workers, pass platform `env` to the config factory; non-string bindings are ignored.
- Workers omit scheduling unless `scheduler` is supplied; explicitly enabling it fails startup.
- A root static wildcard collides with the SSR catch-all; give `static` a separate `urlPrefix`.

## Other options

- `featureFlags`, `notifications`, `multiTenancy`, `reactRouter` and `static` are gated arms.
- REST and microservice options pass through; omitted always-on arms use plugin defaults.
- The microservice tier's `messaging` and `queue` pick the broker and queue backend;
  `setu add messaging --broker <name>` and `setu add queue --queue <name>` write them into a
  generated `setu.config.ts`.
- `buildFullStackPlugins` returns only the plugins, without error middleware.
