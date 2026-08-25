/**
 * Type-level fixture for X6-3 (M70i): the structural facades accept what the
 * real `graphql` package produces.
 *
 * Statically imports `npm:graphql@^16` — no dynamic import, no cast — and
 * asserts, at the type level only:
 *
 * - a real `GraphQLSchema` (from `buildSchema`) is assignable to
 *   `GraphqlSchemaLike`;
 * - the real `graphql` module is assignable to `GraphqlModuleLike`, i.e.
 *   `adaptGraphqlModule(graphql)` type-checks without a cast.
 *
 * Compiled by `deno task check`; not executed as a test.
 */
import * as graphql from 'npm:graphql@^16';
import type { GraphqlModuleLike, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import { adaptGraphqlModule } from '../../src/runtime/graphql-loader.ts';

// X6-3: a real schema the library builds is assignable to the facade.
const schema: GraphqlSchemaLike = graphql.buildSchema('type Query { hello: String }');

// X6-3: the real module is assignable to the external facade shape.
const realModule: GraphqlModuleLike = graphql;

// X6-3: the real module passes through the adapter without a cast.
const runtime = adaptGraphqlModule(graphql);

export { realModule, runtime, schema };
