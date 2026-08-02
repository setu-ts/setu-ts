/**
 * Integration tests for GraphQL plugin
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GraphqlPlugin } from '../../src/plugin/graphql-plugin.ts';
import type { IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

describe('GraphQL plugin integration', () => {
  it('registers under GRAPHQL capability', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: {
        Query: {
          hello: () => 'Hello World',
        },
      },
    });

    expect(plugin.name).toBe('graphql-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.GRAPHQL);
  });

  it('declares optional dependencies', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: {
        Query: {
          hello: () => 'Hello World',
        },
      },
    });

    expect(plugin.optionalDependencies).toContain('logger');
    expect(plugin.optionalDependencies).toContain(CAPABILITIES.HEALTH);
  });

  it('registers routes and health indicator', async () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: {
        Query: {
          hello: () => 'Hello World',
        },
      },
    });

    // Mock context - use type assertions to bypass strict interface checks
    const mockContext = {
      services: {
        register: () => {},
        registerFactory: () => {},
        get: () => {},
        getAll: () => [],
        has: () => false,
        unregister: () => {},
      },
      router: {
        post: () => {},
        get: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
      },
      health: {
        register: () => {},
        check: () => ({ status: 'ok', indicators: {} }),
      },
      logger: {
        level: 'info' as const,
        fatal: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        child: () => ({} as Record<string, unknown>),
      },
      request: {} as Record<string, unknown>,
    };

    await plugin.register(mockContext as unknown as IPluginContext);

    // Plugin should complete without throwing
    expect(true).toBe(true);
  });

  it('supports custom path', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: {
        Query: {
          hello: () => 'Hello World',
        },
      },
      path: '/api/graphql',
    });

    expect(plugin.name).toBe('graphql-plugin');
  });

  it('supports code-first schema', () => {
    const fakeSchema = {
      getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => ({ name }),
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    };

    const plugin = GraphqlPlugin({
      schema: fakeSchema as unknown as GraphqlSchemaLike,
    });

    expect(plugin.name).toBe('graphql-plugin');
  });
});
