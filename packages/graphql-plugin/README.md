# @hono-enterprise/graphql-plugin

GraphQL plugin for the Hono Enterprise framework. Provides schema-first and code-first GraphQL
support over the kernel router.

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
deno add npm:graphql@^16 @hono-enterprise/graphql-plugin
```

## Usage

### Schema-First

```typescript
import { GraphqlPlugin } from '@hono-enterprise/graphql-plugin';
import { Application } from '@hono-enterprise/kernel';

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
import { GraphqlPlugin } from '@hono-enterprise/graphql-plugin';
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
import { adaptGraphqlModule, GraphqlPlugin } from '@hono-enterprise/graphql-plugin';
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

## Security

- Query depth limiting is enabled by default (max 10 levels)
- Internal errors are masked by default
- Introspection is enabled by default (disable in production if needed)
- GraphiQL is enabled by default (disable in production with `graphiql: false`)

## License

MIT
