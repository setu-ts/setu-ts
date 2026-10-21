# @setu-ts/graphql-plugin — GraphQL over the kernel router

`setu add graphql` pins the package and prints the registration line for `setu.config.ts`; it does
not edit the config. Install `graphql` beside it — the plugin imports it lazily. `GraphqlPlugin`
registers `CAPABILITIES.GRAPHQL` during `app.start()`. Supply one schema arm only: `typeDefs` with
`resolvers`, or a pre-built `schema`.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';

export const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GraphqlPlugin({
      typeDefs: 'type Query { ping: String }',
      resolvers: { Query: { ping: () => 'pong' } },
      path: '/graphql',
      maxNodes: 500,
    }),
  ],
});
```

Resolvers receive `DefaultGraphqlContext`: `services`, plus `requestContext`, `user` and `tenant`
over HTTP. Read a capability from `context.services` — never from a captured application:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';
import type { DefaultGraphqlContext, FieldResolver } from '@setu-ts/graphql-plugin';

export const greeting: FieldResolver<unknown, DefaultGraphqlContext, { name: string }> = (
  _source,
  args,
  context,
) =>
  `${context.services.get<IConfig>(CAPABILITIES.CONFIG).get('GREETING', { default: 'Hello' })} ${args.name}`;
```

- Other options: `graphiql` and `introspection` (both on), `maxDepth` (10; nesting only),
  `maskInternalErrors`, `documentCacheSize`, `buildContext`, `formatError`, `validationRules`,
  `rootValue`, and `graphqlModule` for your own `graphql` copy (`adaptGraphqlModule`).
- `maxDepth: 0` and `documentCacheSize: 0` disable; `maxNodes` is off by default and counts aliases
  as fields, so set it from the largest query your clients send.
- Subscriptions are opt-in: `subscriptions: { websocket, sse }` serves `<path>/ws` and
  `<path>/stream`, needs `CAPABILITIES.RUNTIME`, and WS also needs `CAPABILITIES.WEBSOCKET`. A
  schema-first subscription field is `{ subscribe, resolve? }` (`SubscriptionResolver`).
- `apq: { ttlSeconds, maxEntries }` and `maxBatchSize` are opt-in; batching stays off at `0`.
- A guard covering the `/graphql` prefix refuses the upgrade before `onConnect` runs; scope the
  guard to the HTTP path instead.
- `GraphqlSchemaError` means the schema would not build; `GraphqlRuntimeLoadError` means `graphql`
  could not be imported.
