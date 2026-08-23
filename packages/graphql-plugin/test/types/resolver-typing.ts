/**
 * Type-level fixture for X6-4 (M70i): the resolver surface is typeable.
 *
 * Asserts, at the type level only (compiled by `deno task check`; not executed
 * as a test):
 *
 * - a **narrowly annotated** resolver — `FieldResolver<IssueRow,
 *   DefaultGraphqlContext, { id: string }>` — assigns cleanly to the resolver
 *   map. Under `strictFunctionTypes` this was impossible while `FieldResolver`
 *   was a non-generic function type whose parameters were `unknown`: a narrower
 *   parameter is a contravariance error, so every real resolver was written
 *   with `unknown` parameters and hand-written casts.
 * - the narrowly annotated resolver assigns through the **public plugin API**
 *   — `GraphqlPlugin({ typeDefs, resolvers })`. The first widening stopped at
 *   the generic instantiation; `TypeResolverMap` still bound the bare
 *   all-`unknown` `FieldResolver`, so the same TS2322 fired one level up, at
 *   the option. The map's `FieldResolver` binding is now instantiated at
 *   `never`, which accepts every resolver instantiation without weakening what
 *   graphql receives.
 * - `ctx.services.get(...)` and `ctx.user?.id` compile **without a cast**:
 *   `DefaultGraphqlContext` is typed against `@setu-ts/common`
 *   (`IServiceRegistry`, `IPrincipal`), not `unknown`.
 */
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { GraphqlPlugin } from '../../src/index.ts';
import type { DefaultGraphqlContext, FieldResolver } from '../../src/interfaces/options.ts';

/** A row shape a real application resolver would resolve. */
interface IssueRow {
  readonly id: string;
  readonly title: string;
}

/**
 * A narrowly annotated resolver: the source is an `IssueRow`, the context is
 * the documented `DefaultGraphqlContext`, and the argument object names its
 * single field. This assignment is the whole point of the widening — it must
 * compile with no `unknown` parameters and no cast.
 */
const getIssue: FieldResolver<IssueRow, DefaultGraphqlContext, { id: string }> = (
  _source: IssueRow,
  args: { id: string },
  ctx: DefaultGraphqlContext,
  _info: unknown,
): unknown => {
  // X6-4: `ctx.services` is `IServiceRegistry`, so `.get` is callable and its
  // return type is the requested capability — no cast. `CAPABILITIES.RUNTIME`
  // is a real `CapabilityToken`.
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  // X6-4: `ctx.user` is `IPrincipal | undefined`, so `.id` is a `string` when
  // present — no cast.
  const subjectId: string | undefined = ctx.user?.id;
  // The arg object is the declared `{ id: string }`, so `args.id` is a
  // `string` — no cast.
  const id: string = args.id;
  // `requestContext` is optional (X6-6): present over HTTP, absent over WS.
  const hasRequestContext: boolean = ctx.requestContext !== undefined;
  return { runtime, subjectId, id, hasRequestContext };
};

/**
 * The narrowly annotated resolver assigns cleanly to a map entry typed with
 * the same generic instantiation — the shape an application's own resolver-map
 * annotation takes once the widening exists. (A map entry typed with the
 * *bare* all-`unknown` `FieldResolver` cannot accept a narrow resolver: under
 * `strictFunctionTypes` a narrower parameter is a contravariance error, which
 * is exactly why the pre-widening code forced `unknown` parameters plus casts
 * everywhere.)
 */
const resolvers: {
  Query: {
    getIssue: FieldResolver<IssueRow, DefaultGraphqlContext, { id: string }>;
  };
} = {
  Query: {
    getIssue,
  },
};

/**
 * THE X6-4 gate: the same narrowly annotated resolver passes through the
 * PUBLIC registration path — `GraphqlPlugin({ typeDefs, resolvers })`. Before
 * `TypeResolverMap`'s `FieldResolver` binding was instantiated at `never`,
 * this exact call failed with TS2322 even though the resolver itself was
 * perfectly typed: the plugin's accepted `ResolverMap` fixed the entry to the
 * bare all-`unknown` function type, which no narrow resolver satisfies.
 */
const plugin = GraphqlPlugin({
  typeDefs: 'type Issue { id: ID! title: String }\ntype Query { issue(id: ID!): Issue }',
  resolvers: {
    Query: {
      issue: getIssue,
    },
  },
});

/**
 * The `unknown` defaults keep every existing resolver assignable: a resolver
 * written in the pre-widening style (all-`unknown` parameters) still assigns
 * to the bare `FieldResolver` that `TypeResolverMap` names.
 */
const legacy: FieldResolver = (
  _source: unknown,
  _args: Record<string, unknown>,
  _context: unknown,
  _info: unknown,
) => null;

export { getIssue, legacy, plugin, resolvers };
