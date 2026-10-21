# @setu-ts/full-stack-starter — every capability plugin, pre-composed

`createFullStackApp(options?)` is the microservice set plus caching, events, CQRS, scheduling,
audit, secrets, storage and mail, with gated `featureFlags`, `notifications`, `multiTenancy`,
`reactRouter` and `static`. `createFullStackAppFromConfig` closes the ordering gap: plugin options
must be decided before configuration exists. `setu new my-app --template full-stack` generates a
`setu.config.ts` that calls it. Starters are composition libraries, and `setu add` has no short name
for them.

```ts
import { createFullStackAppFromConfig, fullStackConfigOf } from '@setu-ts/full-stack-starter';

const app = await createFullStackAppFromConfig(
  (config) => ({
    database: { type: 'memory' },
    session: { secret: config.getOrThrow<string>('SESSION_SECRET'), csrf: {} },
    reactRouter: { serverBuildPath: '/srv/app/build/server/index.js' },
    static: { root: './build/client', urlPrefix: '/assets' },
  }),
  { config: { envFilePath: ['.env.local', '.env'] } },
);

const config = fullStackConfigOf(app);
await app.start({ port: 3000 });
```

```ts
import { createFullStackApp } from '@setu-ts/full-stack-starter';

const app = createFullStackApp({ cache: { store: 'memory' }, events: {} });
await app.start({ port: 3000 });
```

- Always-on arms: the REST eight, `messaging`, `queue`, `resilience`, `telemetry`, then `cache`,
  `events`, `cqrs`, `scheduler`, `audit`, `secrets`, `storage` and `mail`.
- Gated arms register nothing unless supplied: `featureFlags`, `notifications`, `multiTenancy`,
  `reactRouter`, `static`. Give `static` its own `urlPrefix`: a root wildcard collides with the SSR
  catch-all.
- On Cloudflare Workers the scheduler plugin is left out unless you pass the `scheduler` arm;
  schedule there with `WorkersCron` from `@setu-ts/cloudflare-plugin`. Memory arms are process-local
  and a Workers isolate is short-lived.
- `createFullStackAppFromConfig(build, options?)` loads configuration once, passes that snapshot to
  `build`, and registers the same object under `CAPABILITIES.CONFIG`; `fullStackConfigOf(app)` reads
  it back and throws `FullStackConfigUnavailableError` for an app from another factory. On Workers
  pass the request `env` as `options.env`.
- `di: {}` turns every decorated class into a container provider; loaders reach services through
  `populateLoadContext` and `contextKeyFor` from `@setu-ts/react-router-plugin`.
- No arm sets a plugin `name`; register extra instances on the returned app.
