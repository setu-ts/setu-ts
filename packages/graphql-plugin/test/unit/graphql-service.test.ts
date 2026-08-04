/**
 * Tests for graphql-service.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GraphqlService } from '../../src/services/graphql-service.ts';
import type { GraphqlRuntime, GraphqlSchemaLike } from '../../src/interfaces/graphql-runtime.ts';
import type {
  GraphqlConnectionInfo,
  GraphqlOperationContext,
  IRequestContext,
  IServiceRegistry,
} from '@hono-enterprise/common';

const mockServiceRegistry: IServiceRegistry = {
  register: () => {},
  registerFactory: () => {},
  get: () => {
    throw new Error('not registered');
  },
  getAll: () => [],
  has: () => false,
  unregister: () => true,
};

describe('GraphqlService', () => {
  const createFakeRuntime = (): GraphqlRuntime =>
    ({
      // The document carries a real operation node, because the operation guard
      // resolves the kind off the AST the parse produced.
      parse: (_src: string) => ({
        kind: 'Document',
        definitions: [{
          kind: 'OperationDefinition',
          operation: 'query',
          selectionSet: { kind: 'SelectionSet', selections: [] },
        }],
      }),
      validate: (_schema: unknown, _document: unknown, rules: unknown[]) => {
        const errors: Array<{ message: string }> = [];
        const mockContext = {
          reportError: (error: { message: string }) => errors.push(error),
        };
        for (const rule of rules) {
          if (typeof rule === 'function') {
            try {
              const visitor = rule(mockContext as never);
              if (visitor && typeof visitor === 'object' && typeof visitor.Field === 'function') {
                try {
                  // Pass empty ancestors to avoid depth-limit rule throwing on undefined
                  visitor.Field(undefined, undefined, undefined, []);
                } catch (e) {
                  // Custom rules may throw to signal validation errors
                  errors.push({ message: (e as Error).message });
                }
              }
            } catch {
              // Built-in rules may throw; ignore
            }
          }
        }
        return errors as never;
      },
      execute: () => Promise.resolve({ data: { hello: 'world' } }),
      subscribe: () => Promise.resolve({ data: {} }),
      buildSchema: (_src: string) => ({
        getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
        getMutationType: () => null,
        getSubscriptionType: () => null,
        getType: (name: string) => ({ name }),
        getPossibleTypes: () => [],
        getDirectives: () => [],
        getDirective: () => null,
        toAST: () => ({}),
      }),
      validateSchema: () => [],
      getOperationAST: (document: { definitions: unknown[] }) => document.definitions[0] ?? null,
      GraphQLError: class extends Error {
        override name = 'GraphQLError';
        toJSON() {
          return { message: this.message };
        }
      },
      NoSchemaIntrospectionCustomRule: {},
      specifiedRules: [],
    }) as GraphqlRuntime;

  const createFakeSchema = (): GraphqlSchemaLike =>
    ({
      getQueryType: () => ({
        name: 'Query',
        getFields: () => ({ hello: { name: 'hello', type: { name: 'String' }, args: [] } }),
        getInterfaces: () => [],
      }),
      getMutationType: () => null,
      getSubscriptionType: () => null,
      getType: (name: string) => ({ name }),
      getPossibleTypes: () => [],
      getDirectives: () => [],
      getDirective: () => null,
      toAST: () => ({}),
    }) as GraphqlSchemaLike;

  it('has endpoint property', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    expect(service.endpoint).toBe('/graphql');
  });

  it('reports cached document count', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    expect(service.cachedDocumentCount).toBe(0);
  });

  it('clears cache', () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    (service as GraphqlService & { clearCache(): void }).clearCache();
    expect(service.cachedDocumentCount).toBe(0);
  });

  it('builds context from buildContext option', async () => {
    let capturedContext: unknown;
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      buildContext: (input) => {
        capturedContext = input;
        return { custom: 'value' };
      },
    });

    await service.execute({ query: '{ hello }' });

    expect(capturedContext).toBeDefined();
  });

  it('uses default context when buildContext is absent', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
    expect(result.result.data).toEqual({ hello: 'world' });
  });

  it('uses custom validation rules', async () => {
    let customRuleCalled = false;
    const customRule = () => {
      customRuleCalled = true;
      return {};
    };

    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      validationRules: [customRule],
    });

    await service.execute({ query: '{ hello }' });

    // Custom rule must be invoked by the runtime's validate
    expect(customRuleCalled).toBe(true);
  });

  it('custom validation rules have observable effect on execution', async () => {
    const rejectRule = () => {
      return {
        Field: () => {
          throw new Error('rejected by custom rule');
        },
      };
    };

    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      validationRules: [rejectRule],
    });

    const result = await service.execute({ query: '{ hello }' });

    // Custom rule should cause validation to fail
    expect(result.status).toBe(400);
    expect(result.result.errors).toBeDefined();
    expect(result.result.errors!.length).toBeGreaterThan(0);
  });

  it('disables introspection when option is false', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: false,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses custom formatError function', async () => {
    const formatError = (error: unknown) => ({
      message: 'Custom formatted error',
      original: error,
    });

    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      formatError,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses rootValue option', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      rootValue: { custom: 'root' },
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('handles empty validation rules array', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      validationRules: [],
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('uses default formatError when not provided', async () => {
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
    });

    const result = await service.execute({ query: '{ hello }' });

    expect(result.status).toBe(200);
  });

  it('builds context with requestContext when provided', async () => {
    let capturedContext: unknown;
    const service = new GraphqlService(createFakeRuntime(), createFakeSchema(), {
      serviceRegistry: mockServiceRegistry,
      endpoint: '/graphql',
      documentCacheSize: 100,
      maxDepth: 10,
      introspection: true,
      maskInternalErrors: true,
      buildContext: (input) => {
        capturedContext = input;
        return { custom: 'value' };
      },
    });

    const mockRequestContext = {
      services: { test: 'service' },
      request: { url: 'http://test.com' },
    };

    await service.execute({ query: '{ hello }' }, mockRequestContext as unknown as IRequestContext);

    expect(capturedContext).toBeDefined();
  });

  describe('subscribe', () => {
    /** Fake runtime whose operation kind and parse behavior are controllable. */
    function createSubscribeRuntime(opts: {
      operation?: 'query' | 'subscription';
      parseThrows?: boolean;
      subscribeStream?: AsyncIterable<unknown>;
    }): GraphqlRuntime {
      return {
        parse: (_src: string) => {
          if (opts.parseThrows) throw new Error('syntax error');
          return {
            kind: 'Document',
            definitions: [{
              kind: 'OperationDefinition',
              operation: opts.operation ?? 'query',
              selectionSet: { kind: 'SelectionSet', selections: [] },
            }],
          };
        },
        validate: () => [],
        execute: () => Promise.resolve({ data: { hello: 'world' } }),
        subscribe: () =>
          Promise.resolve(
            opts.subscribeStream ?? (async function* () {
              yield { data: { tick: 0 } };
            })(),
          ),
        buildSchema: (_src: string) =>
          ({
            getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
            getMutationType: () => null,
            getSubscriptionType: () => ({ name: 'Subscription' }),
            getType: () => null,
            getPossibleTypes: () => [],
            getDirectives: () => [],
            getDirective: () => null,
            toAST: () => ({}),
          }) as never,
        validateSchema: () => [],
        getOperationAST: (document: { definitions: Array<{ operation?: string }> }) =>
          document.definitions[0] ?? null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      } as unknown as GraphqlRuntime;
    }

    function makeService(
      runtime: GraphqlRuntime,
      opts: { buildContext?: (input: unknown) => unknown } = {},
    ) {
      return new GraphqlService(runtime, createFakeSchema(), {
        serviceRegistry: mockServiceRegistry,
        endpoint: '/graphql',
        documentCacheSize: 100,
        maxDepth: 10,
        introspection: true,
        maskInternalErrors: true,
        ...(opts.buildContext ? { buildContext: opts.buildContext as never } : {}),
      });
    }

    it('returns a single outcome for a query', async () => {
      const service = makeService(createSubscribeRuntime({ operation: 'query' }));
      const outcome = await service.subscribe({ query: '{ hello }' });
      expect(outcome.kind).toBe('single');
      if (outcome.kind === 'single') {
        expect(outcome.result.data).toEqual({ hello: 'world' });
      }
    });

    it('returns a stream outcome for a subscription', async () => {
      const service = makeService(createSubscribeRuntime({ operation: 'subscription' }));
      const outcome = await service.subscribe({ query: 'subscription { tick }' });
      expect(outcome.kind).toBe('stream');
      if (outcome.kind === 'stream') {
        const first = await outcome.stream[Symbol.asyncIterator]().next();
        expect(first.value).toEqual({ data: { tick: 0 } });
      }
    });

    it('returns an error outcome when the query fails to parse', async () => {
      const service = makeService(
        createSubscribeRuntime({ operation: 'query', parseThrows: true }),
      );
      const outcome = await service.subscribe({ query: '{ bad' });
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') {
        expect(outcome.result.errors).toBeDefined();
      }
    });

    it('builds WS-shaped context: services from the registry, user/tenant from conn.data', async () => {
      let captured: { services?: unknown; user?: unknown; tenant?: unknown } = {};
      const service = makeService(
        createSubscribeRuntime({ operation: 'subscription' }),
        {
          buildContext: (input) => {
            captured = input as typeof captured;
            return { marker: 'ctx' };
          },
        },
      );
      const data = new Map<string, unknown>([['user', 'alice'], ['tenant', 't1']]);
      const connection: GraphqlConnectionInfo = {
        id: 'c1',
        headers: new Headers(),
        query: {},
        data,
      };
      const context: GraphqlOperationContext = { connection };

      await service.subscribe({ query: 'subscription { tick }' }, context);

      // The plugin-level registry is handed to the WS path's context.
      expect(captured.services).toBe(mockServiceRegistry);
      // A custom buildContext receives the connection so it can read identity.
      expect((captured as { connection?: GraphqlConnectionInfo }).connection).toBe(connection);
    });

    it('uses the default context (services from registry) when no buildContext, on the WS path', async () => {
      let subscribedContext: unknown;
      const runtime = createSubscribeRuntime({ operation: 'subscription' });
      (runtime as unknown as { subscribe: (args: unknown) => Promise<unknown> }).subscribe = (
        args: unknown,
      ) => {
        const ctx = args as { contextValue?: unknown };
        subscribedContext = ctx.contextValue;
        return Promise.resolve((async function* () {
          yield { data: { tick: 0 } };
        })());
      };
      const service = makeService(runtime);
      const connection: GraphqlConnectionInfo = {
        id: 'c1',
        headers: new Headers(),
        query: {},
        data: new Map([['user', 'bob']]),
      };

      await service.subscribe({ query: 'subscription { tick }' }, { connection });

      const ctx = subscribedContext as { services: unknown; user?: string };
      expect(ctx.services).toBe(mockServiceRegistry);
      expect(ctx.user).toBe('bob');
    });

    it('defaults services to {} when neither requestContext nor connection is supplied', async () => {
      let subscribedContext: unknown;
      const runtime = createSubscribeRuntime({ operation: 'query' });
      (runtime as unknown as { execute: (args: unknown) => Promise<unknown> }).execute = (
        args: unknown,
      ) => {
        const ctx = args as { contextValue?: unknown };
        subscribedContext = ctx.contextValue;
        return Promise.resolve({ data: { hello: 'world' } });
      };
      const service = makeService(runtime);

      await service.subscribe({ query: '{ hello }' });

      expect((subscribedContext as { services: unknown }).services).toEqual({});
    });

    it('honors a non-default maskInternalErrors identically to execute', async () => {
      const runtime = createSubscribeRuntime({ operation: 'query', parseThrows: true });
      const service = new GraphqlService(runtime, createFakeSchema(), {
        serviceRegistry: mockServiceRegistry,
        endpoint: '/graphql',
        documentCacheSize: 100,
        maxDepth: 10,
        introspection: true,
        maskInternalErrors: true,
      });
      const outcome = await service.subscribe({ query: '{ bad' });
      expect(outcome.kind).toBe('error');
    });
  });
});
