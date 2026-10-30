# @setu-ts/graphql-plugin — queries and mutations over HTTP

**Add it:** `setu add graphql` adds the package and prints the registration for `setu.config.ts`;
install `graphql` too. `GraphqlPlugin` provides `CAPABILITIES.GRAPHQL` (`IGraphqlService`).

## Serve a schema with application services

Put this registration in the config's plugin list:

```ts
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import type { DefaultGraphqlContext, FieldResolver } from '@setu-ts/graphql-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';

const greeting: FieldResolver<unknown, DefaultGraphqlContext, { name: string }> =
  (_source, args, context) =>
    `${context.services.get<IConfig>(CAPABILITIES.CONFIG).get('GREETING', { default: 'Hello' })} ${args.name}`;

export const graphql = GraphqlPlugin({
  typeDefs: 'type Query { greeting(name: String!): String! }',
  resolvers: { Query: { greeting } },
  maxNodes: 500,
});
```

## Execute a query inside a handler

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IGraphqlService } from '@setu-ts/common';

const graphql = ctx.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
const outcome = await graphql.execute({ query: '{ greeting(name: "Ada") }' }, ctx);
ctx.response.status(outcome.status).json(outcome.result);
```

## Behaviour the types do not show

- The HTTP path defaults to `/graphql`; `graphiql` and `introspection` default to `true`.
- `maxDepth` defaults to 10; `0` disables it. `maxNodes` defaults to `0` (off).
- Internal errors are masked by default; `maskInternalErrors` controls that.
- `documentCacheSize` defaults to 1000; `0` disables document caching.
- Default resolver context contains `services`; HTTP requests also supply `requestContext`, `user`
  and `tenant`. Resolve services there after startup.

## Other options

- Use `schema` instead of `typeDefs` plus `resolvers` for a pre-built schema.
- `subscriptions` enables transports; `apq` enables persisted queries; `maxBatchSize` enables
  batching.
- `buildContext`, `formatError`, `validationRules` and `rootValue` customize execution.
