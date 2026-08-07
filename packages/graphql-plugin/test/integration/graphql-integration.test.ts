/**
 * Integration tests for the GraphQL plugin.
 *
 * These drive a REAL kernel application against the REAL `graphql` module. A
 * hand-rolled mock plugin context cannot see the defects this file exists to
 * catch — chiefly whether the context a resolver actually receives is the one
 * the plugin documents.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IGraphqlService } from '@setu-ts/common';
import * as graphqlModule from 'npm:graphql@^16';
import { GraphqlPlugin } from '../../src/plugin/graphql-plugin.ts';
import type { GraphqlModuleLike } from '../../src/interfaces/graphql-runtime.ts';
import type { DefaultGraphqlContext, GraphqlPluginOptions } from '../../src/interfaces/options.ts';

const realModule = graphqlModule as unknown as GraphqlModuleLike;

const typeDefs = `
  type Query { hello: String, whoami: String, boom: String }
`;

/** Build an application with the plugin over the real graphql module. */
function createApp(options: Partial<GraphqlPluginOptions> & { resolvers: never }) {
  const app = createApplication();
  app.register(RuntimePlugin());
  app.register(GraphqlPlugin({
    graphqlModule: realModule,
    typeDefs,
    ...options,
  } as GraphqlPluginOptions));
  return app;
}

/** Parse an injected response body, failing loudly rather than on `null`. */
function json(res: { body: string | null }): unknown {
  expect(res.body).not.toBeNull();
  return JSON.parse(res.body as string);
}

const post = (
  app: ReturnType<typeof createApplication>,
  body: unknown,
  accept = 'application/json',
) =>
  app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify(body),
  });

describe('GraphQL plugin integration', () => {
  it('registers the service under CAPABILITIES.GRAPHQL and serves it', async () => {
    const app = createApp({
      resolvers: { Query: { hello: () => 'Hello World' } } as never,
    });
    await app.start();

    const service = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
    expect(service.endpoint).toBe('/graphql');

    const res = await post(app, { query: '{ hello }' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ data: { hello: 'Hello World' } });

    await app.stop();
  });

  it('hands resolvers the documented default context, with a live service registry', async () => {
    // Regression: the plugin used to default `buildContext` to a stub returning
    // `{}`, which made the documented default context unreachable and left
    // every resolver unable to resolve any other capability.
    let seen: DefaultGraphqlContext | undefined;

    const app = createApp({
      resolvers: {
        Query: {
          whoami: (_s: unknown, _a: unknown, ctx: DefaultGraphqlContext) => {
            seen = ctx;
            return 'ok';
          },
        },
      } as never,
    });
    await app.start();

    const res = await post(app, { query: '{ whoami }' });
    expect(res.statusCode).toBe(200);

    expect(seen).toBeDefined();
    expect(Object.keys(seen!).sort()).toEqual(['requestContext', 'services', 'tenant', 'user']);
    // The registry must be the live one, so a resolver can reach any capability.
    const services = seen!.services as { get(token: string): unknown };
    expect(services.get(CAPABILITIES.RUNTIME)).toBeDefined();
    expect(seen!.requestContext).toBeDefined();

    await app.stop();
  });

  it('lets a resolver resolve another capability from the registry', async () => {
    const app = createApp({
      resolvers: {
        Query: {
          whoami: (_s: unknown, _a: unknown, ctx: DefaultGraphqlContext) => {
            const services = ctx.services as { get(token: string): { uuid(): string } };
            // A real capability, used for real: the runtime's uuid generator.
            return typeof services.get(CAPABILITIES.RUNTIME).uuid() === 'string' ? 'reached' : 'no';
          },
        },
      } as never,
    });
    await app.start();

    const res = await post(app, { query: '{ whoami }' });
    expect(json(res)).toEqual({ data: { whoami: 'reached' } });

    await app.stop();
  });

  it('drives execute() and the HTTP route to identical results under a NON-default config', async () => {
    // One capability, one implementation: the route handler must not own any
    // execution behaviour the service entry point lacks. Driven under
    // `maskInternalErrors: false` plus a custom `buildContext` so a divergence
    // in either option shows up.
    const app = createApp({
      resolvers: {
        Query: {
          boom: () => {
            throw new Error('SECRET detail');
          },
          hello: (_s: unknown, _a: unknown, ctx: { marker?: string }) => ctx.marker ?? 'no-context',
        },
      } as never,
      maskInternalErrors: false,
      buildContext: () => ({ marker: 'custom-context' }),
    });
    await app.start();

    const service = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);

    for (const query of ['{ hello }', '{ boom }']) {
      const direct = await service.execute({ query });
      const overHttp = await post(app, { query }, 'application/graphql-response+json');

      expect(overHttp.statusCode).toBe(direct.status);
      expect(json(overHttp)).toEqual(JSON.parse(JSON.stringify(direct.result)));
    }

    // ...and the non-default options genuinely took effect on both paths.
    const unmasked = await service.execute({ query: '{ boom }' });
    expect(JSON.stringify(unmasked.result)).toContain('SECRET detail');
    const contextual = await service.execute({ query: '{ hello }' });
    expect(contextual.result.data).toEqual({ hello: 'custom-context' });

    await app.stop();
  });

  it('caches each distinct document once across repeated real requests', async () => {
    const app = createApp({
      resolvers: { Query: { hello: () => 'Hello World' } } as never,
    });
    await app.start();

    const service = app.services.get<IGraphqlService>(CAPABILITIES.GRAPHQL);
    expect(service.cachedDocumentCount).toBe(0);

    await post(app, { query: '{ hello }' });
    await post(app, { query: '{ hello }' });
    expect(service.cachedDocumentCount).toBe(1);

    await post(app, { query: '{ hello whoami }' });
    expect(service.cachedDocumentCount).toBe(2);

    await app.stop();
  });

  it('serves a code-first schema built by the application', async () => {
    const g = graphqlModule as unknown as {
      GraphQLSchema: new (config: unknown) => unknown;
      GraphQLObjectType: new (config: unknown) => unknown;
      GraphQLString: unknown;
    };
    const schema = new g.GraphQLSchema({
      query: new g.GraphQLObjectType({
        name: 'Query',
        fields: { hello: { type: g.GraphQLString, resolve: () => 'from code-first' } },
      }),
    });

    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(GraphqlPlugin({
      graphqlModule: realModule,
      schema: schema as never,
    }));
    await app.start();

    const res = await post(app, { query: '{ hello }' });
    expect(json(res)).toEqual({ data: { hello: 'from code-first' } });

    await app.stop();
  });

  it('declares its capability and optional dependencies', () => {
    const plugin = GraphqlPlugin({
      graphqlModule: realModule,
      typeDefs,
      resolvers: { Query: { hello: () => 'x' } },
    });

    expect(plugin.provides).toContain(CAPABILITIES.GRAPHQL);
    expect(plugin.optionalDependencies).toContain('logger');
    expect(plugin.optionalDependencies).toContain(CAPABILITIES.HEALTH);
  });

  it('serves at a custom path and nowhere else', async () => {
    const app = createApp({
      resolvers: { Query: { hello: () => 'Hello World' } } as never,
      path: '/api/graphql',
    } as never);
    await app.start();

    const served = await app.inject({
      method: 'POST',
      url: '/api/graphql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    expect(served.statusCode).toBe(200);

    const absent = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });
    expect(absent.statusCode).toBe(404);

    await app.stop();
  });
});
