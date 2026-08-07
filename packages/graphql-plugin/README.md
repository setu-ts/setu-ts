# @setu-ts/graphql-plugin

GraphQL plugin for the Setu-TS framework. Provides schema-first and code-first GraphQL support over
the kernel router.

## Features

- Schema-first construction (SDL + resolver map)
- Code-first construction (application-built schema)
- GraphQL-over-HTTP transport with media-type negotiation
- Bounded parse+validate document cache
- Error masking, query-depth limiting, introspection control
- GraphiQL UI for development
- Health indicator integration

## Installation

```bash
deno add npm:graphql@^16 @setu-ts/graphql-plugin
```

## Usage

### Schema-First

```typescript
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { Application } from '@setu-ts/kernel';

const app = new Application();

app.use(
  GraphqlPlugin({
    typeDefs: `
      type Query {
        hello(name: String!): String
      }
    `,
    resolvers: {
      Query: {
        hello: (_, { name }) => `Hello, ${name}!`,
      },
    },
  }),
);

await app.start({ port: 3000 });
```

### Code-First

```typescript
import { GraphqlPlugin } from '@setu-ts/graphql-plugin';
import { buildSchema } from 'npm:graphql@^16';

const schema = buildSchema(`
  type Query {
    hello(name: String!): String
  }
`);

const app = new Application();

app.use(
  GraphqlPlugin({
    schema,
  }),
);

await app.start({ port: 3000 });
```

### Injecting Your Own graphql Module

If your application uses its own copy of `graphql`, inject it to avoid cross-copy issues:

```typescript
import { adaptGraphqlModule, GraphqlPlugin } from '@setu-ts/graphql-plugin';
import * as graphql from 'npm:graphql@^16';

app.use(
  GraphqlPlugin({
    schema: mySchema,
    graphqlModule: adaptGraphqlModule(graphql),
  }),
);
```

## Options

| Option               | Type                 | Default    | Description                               |
| -------------------- | -------------------- | ---------- | ----------------------------------------- |
| `typeDefs`           | `string`             | -          | SDL schema definition (schema-first mode) |
| `resolvers`          | `ResolverMap`        | -          | Resolver map (schema-first mode)          |
| `schema`             | `GraphqlSchemaLike`  | -          | Pre-built schema (code-first mode)        |
| `path`               | `string`             | `/graphql` | Endpoint path                             |
| `graphiql`           | `boolean`            | `true`     | Enable GraphiQL UI                        |
| `introspection`      | `boolean`            | `true`     | Enable schema introspection               |
| `maxDepth`           | `number`             | `10`       | Maximum query depth (0 to disable)        |
| `validationRules`    | `unknown[]`          | `[]`       | Additional validation rules               |
| `maskInternalErrors` | `boolean`            | `true`     | Mask internal server errors               |
| `formatError`        | `(error) => error`   | -          | Custom error formatter                    |
| `documentCacheSize`  | `number`             | `1000`     | Max cached documents (0 to disable)       |
| `buildContext`       | `(input) => context` | -          | Custom context builder                    |
| `rootValue`          | `unknown`            | -          | Root value for resolvers                  |
| `graphqlModule`      | `GraphqlModuleLike`  | -          | Injected graphql module                   |

## Platform Notes

### Deno

The `graphql` package reads `process.env.NODE_ENV` at import time. If you run into permission
errors, add the `--allow-env` flag:

```bash
deno run --allow-env --allow-net main.ts
```

### Cloudflare Workers

Enable `nodejs_compat` in your `wrangler.toml`:

```toml
[vars]
nodejs_compat = true
```

## Subscriptions

Subscriptions are **opt-in**. Without a `subscriptions` option no transport route is registered, and
`POST`/`GET /graphql` continues to refuse a subscription operation with
`400 SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP`.

```typescript
GraphqlPlugin({
  typeDefs,
  resolvers,
  subscriptions: {
    // WebSocket registers only when CAPABILITIES.WEBSOCKET is present and the
    // adapter can upgrade; otherwise the plugin logs a notice and carries on.
    websocket: {
      onConnect: (info) => {
        const token = info.connectionParams?.authorization;
        if (!isValid(token)) return false; // closes 4403: Forbidden
        info.data.set('user', userFor(token)); // read back by the resolver context
      },
    },
    sse: { heartbeatMs: 15_000 },
  },
});
```

Endpoints default to the GraphQL path plus `/ws` and `/stream`, so `path: '/api/graphql'` gives
`/api/graphql/ws` and `/api/graphql/stream`. Both transports take their timers from
`IRuntimeServices`, so `subscriptions` requires `CAPABILITIES.RUNTIME` and throws at registration
without it.

A schema-first subscription field takes a `{ subscribe, resolve? }` entry — `subscribe` returns the
async iterable, and graphql reads the event source from there:

```typescript
const resolvers: ResolverMap = {
  Subscription: {
    tick: {
      subscribe: () => tickStream(),
      resolve: (payload) => (payload as { tick: number }).tick,
    },
  },
};
```

The WebSocket route opts out of `websocket-plugin`'s shared heartbeat sweep, because that sweeper
sends a raw text frame a `graphql-transport-ws` client must answer by closing `4400`. Liveness on
this route is the protocol's own `ping`/`pong` via `subscriptions.websocket.heartbeatMs`.

The SSE transport follows the graphql-sse protocol for distinct-connections mode: a GraphQL request
error is delivered inside the accepted event stream as a `next` event, not as a `400`, because a
`400` makes the user agent fail the connection and leaves native `EventSource` with nothing to read.

## Batching and Automatic Persisted Queries

Both are opt-in:

```typescript
GraphqlPlugin({
  typeDefs,
  resolvers,
  maxBatchSize: 25, // 0 (the default) keeps refusing an array body with 400
  apq: { ttlSeconds: 300 }, // omitted disables APQ entirely
});
```

APQ stores documents under an `apq:` prefix in `CAPABILITIES.CACHE` when a cache store is
registered, and in a bounded in-process LRU otherwise. A submitted hash is **verified** against the
submitted document before it is persisted, so a shared store cannot be poisoned with a document
under another client's hash. Hashing uses `IRuntimeServices.subtle`, so `apq` requires
`CAPABILITIES.RUNTIME`.

## Security

- Query depth limiting is enabled by default (max 10 levels)
- Internal errors are masked by default — including errors raised inside a live subscription, which
  are masked by the same code path the HTTP transport uses
- APQ verifies a submitted hash against the submitted document before persisting it
- Internal errors are masked by default
- Introspection is enabled by default (disable in production if needed)
- GraphiQL is enabled by default (disable in production with `graphiql: false`)

## License

MIT
