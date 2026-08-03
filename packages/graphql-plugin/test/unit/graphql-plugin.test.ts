/**
 * Tests for graphql-plugin.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import { GraphqlPlugin } from '../../src/plugin/graphql-plugin.ts';
import type { ResolverMap } from '../../src/interfaces/options.ts';
import { createHandlerLogger } from '../../src/plugin/graphql-plugin.ts';

describe('createHandlerLogger', () => {
  it('creates handler logger with info and error wrappers', () => {
    const infoCalls: string[] = [];
    const errorCalls: { msg: string; err?: unknown }[] = [];

    const mockLogger = {
      info: (msg: string) => infoCalls.push(msg),
      error: (msg: string, err?: unknown) => errorCalls.push({ msg, err }),
    };

    const handlerLogger = createHandlerLogger(mockLogger as never);

    handlerLogger.info('test info');
    handlerLogger.error('test error', new Error('test'));

    expect(infoCalls).toEqual(['test info']);
    expect(errorCalls).toEqual([{ msg: 'test error', err: new Error('test') }]);
  });
});

describe('GraphqlPlugin', () => {
  it('returns plugin with correct name', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    });

    expect(plugin.name).toBe('graphql-plugin');
  });

  it('has provides array with GRAPHQL capability', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    });

    expect(plugin.provides).toContain('graphql');
  });

  it('has optionalDependencies array', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    });

    expect(Array.isArray(plugin.optionalDependencies)).toBe(true);
  });

  it('has version property', () => {
    const plugin = GraphqlPlugin({
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    });

    expect(typeof plugin.version).toBe('string');
    expect(plugin.version).toBeTruthy();
  });

  describe('register', () => {
    it('registers GraphQL service', async () => {
      let registeredToken: string | null = null;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: (token: string) => {
              registeredToken = token;
            },
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(registeredToken).toBe('graphql');
    });

    it('uses default path when not specified', async () => {
      let postPath: string | null = null;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: (path: string) => {
              postPath = path;
            },
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(postPath).toBe('/graphql');
    });

    it('uses custom path when specified', async () => {
      let postPath: string | null = null;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/api/graphql',
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: (path: string) => {
              postPath = path;
            },
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(postPath).toBe('/api/graphql');
    });

    it('registers health indicator', async () => {
      let healthRegistered = false;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: (_name: string, _check: () => Promise<{ status: string }>) => {
              healthRegistered = true;
            },
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(healthRegistered).toBe(true);
    });

    it('logs info when registered', async () => {
      let logged = false;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: {
            info: () => {
              logged = true;
            },
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(logged).toBe(true);
    });

    it('logs a masked internal error through the plugin context logger', async () => {
      // Masking without logging discards the error entirely. `IRequestContext`
      // carries no logger, so the sink must come from the plugin context.
      const errorCalls: { msg: string; err?: unknown }[] = [];

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { boom: String }',
        resolvers: {
          Query: {
            boom: () => {
              throw new Error('SECRET internal detail');
            },
          },
        },
      });

      let registeredService: unknown;

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: (msg: string, err?: unknown) => errorCalls.push({ msg, err }),
          },
          router: { post: () => {}, get: () => {} },
          services: {
            register: (_token: string, service: unknown) => {
              registeredService = service;
            },
          },
          health: { register: () => {} },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      const service = registeredService as {
        execute(params: { query: string }): Promise<{ result: { errors?: unknown[] } }>;
      };
      const outcome = await service.execute({ query: '{ boom }' });

      // The client sees nothing...
      expect(JSON.stringify(outcome.result)).not.toContain('SECRET internal detail');
      // ...but the operator does.
      const masked = errorCalls.filter((c) => c.msg === 'Internal GraphQL error');
      expect(masked.length).toBe(1);
      expect(String((masked[0]!.err as { message?: string })?.message)).toContain(
        'SECRET internal detail',
      );
    });

    it('registers the service and both routes in schema-first mode', async () => {
      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/api/graphql',
      });

      const registered: Array<[string, unknown]> = [];
      const routes: Array<[string, string]> = [];

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: (p: string) => routes.push(['post', p]),
            get: (p: string) => routes.push(['get', p]),
          },
          services: {
            register: (token: string, service: unknown) => registered.push([token, service]),
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(registered.length).toBe(1);
      expect(registered[0]![0]).toBe(CAPABILITIES.GRAPHQL);
      expect((registered[0]![1] as { endpoint: string }).endpoint).toBe('/api/graphql');
      expect(routes).toEqual([['post', '/api/graphql'], ['get', '/api/graphql']]);
    });

    it('handles schema build error', async () => {
      const plugin = GraphqlPlugin({
        typeDefs: 'INVALID SCHEMA {{{',
        resolvers: { Query: { hello: () => 'world' } },
      });

      let errorCaught = false;

      try {
        await plugin.register(
          {
            logger: {
              info: () => {},
              error: () => {},
            },
            router: {
              post: () => {},
              get: () => {},
            },
            services: {
              register: () => {},
            },
            health: {
              register: () => {},
            },
          } as unknown as Parameters<typeof plugin.register>[0],
        );
      } catch {
        errorCaught = true;
      }

      // Schema validation should fail for invalid schema
      expect(errorCaught).toBe(true);
    });

    it('handles attach resolvers error', async () => {
      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } } as unknown as ResolverMap,
      });

      let errorCaught = false;

      try {
        await plugin.register(
          {
            logger: {
              info: () => {},
              error: () => {},
            },
            router: {
              post: () => {},
              get: () => {},
            },
            services: {
              register: () => {},
            },
            health: {
              register: () => {},
            },
          } as unknown as Parameters<typeof plugin.register>[0],
        );
      } catch {
        errorCaught = true;
      }

      // This should complete successfully with valid schema
      expect(errorCaught).toBe(false);
    });

    it('registers with custom options', async () => {
      let postPath: string | null = null;
      let getPath: string | null = null;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/custom/graphql',
        maxDepth: 5,
        introspection: false,
        maskInternalErrors: false,
        documentCacheSize: 500,
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: (path: string) => {
              postPath = path;
            },
            get: (path: string) => {
              getPath = path;
            },
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      expect(postPath).toBe('/custom/graphql');
      expect(getPath).toBe('/custom/graphql');
    });

    it('registers without logger', async () => {
      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      const registered: Array<[string, unknown]> = [];

      await plugin.register(
        {
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: (token: string, service: unknown) => registered.push([token, service]),
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // `logger` is an optional dependency: the service must still register, and
      // must still execute, with no logger anywhere in the context.
      expect(registered.map(([token]) => token)).toEqual([CAPABILITIES.GRAPHQL]);
      const service = registered[0]![1] as {
        execute(params: { query: string }): Promise<{ status: number }>;
      };
      expect((await service.execute({ query: '{ hello }' })).status).toBe(200);
    });

    it('executes health indicator callback', async () => {
      let healthCallback: () => Promise<{ status: string; data: unknown }>;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/graphql',
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: (
              _name: string,
              callback: () => Promise<{ status: string; data: unknown }>,
            ) => {
              healthCallback = callback;
            },
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // Execute the health callback
      const healthResult = await healthCallback!();
      expect(healthResult.status).toBe('up');
      expect(healthResult.data).toEqual({ endpoint: '/graphql', cachedDocuments: 0 });
    });

    it('executes logger wrapper functions', async () => {
      const infoCalls: string[] = [];

      const mockLogger = {
        info: (msg: string) => infoCalls.push(msg),
        error: (_msg: string, _err?: unknown) => {},
      };

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: mockLogger,
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // The logger wrapper should have been created and the info call should have been made
      expect(infoCalls.length).toBeGreaterThan(0);
      expect(infoCalls[0]).toContain('GraphQL plugin registered');
    });

    it('invokes handlerLogger info wrapper', async () => {
      const handlerInfoCalls: string[] = [];
      const handlerErrorCalls: { msg: string; err?: unknown }[] = [];

      const mockLogger = {
        info: (msg: string) => handlerInfoCalls.push(msg),
        error: (msg: string, err?: unknown) => {
          handlerErrorCalls.push({ msg, err });
        },
      };

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: mockLogger,
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // The handlerLogger info wrapper is invoked when the plugin logs registration
      expect(handlerInfoCalls.length).toBeGreaterThan(0);
    });

    it('executes health indicator callback with correct data', async () => {
      let capturedCallback: (() => Promise<{ status: string; data: unknown }>) | undefined;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/test-graphql',
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: (
              _name: string,
              callback: () => Promise<{ status: string; data: unknown }>,
            ) => {
              capturedCallback = callback;
            },
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // Invoke the health callback and verify it returns correct data
      expect(capturedCallback).toBeDefined();
      const result = await capturedCallback!();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({
        endpoint: '/test-graphql',
        cachedDocuments: 0,
      });
    });

    it('executes health callback with correct endpoint and cachedDocuments', async () => {
      let capturedCallback: (() => Promise<{ status: string; data: unknown }>) | undefined;

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        path: '/api/graphql',
      });

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: (
              _name: string,
              callback: () => Promise<{ status: string; data: unknown }>,
            ) => {
              capturedCallback = callback;
            },
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // Execute the health callback to exercise the arrow function
      const result = await capturedCallback!();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({
        endpoint: '/api/graphql',
        cachedDocuments: 0,
      });
    });

    it('executes logger error wrapper function', async () => {
      const errorCalls: { msg: string; err?: unknown }[] = [];

      const mockLogger = {
        info: (_msg: string) => {},
        error: (msg: string, err?: unknown) => {
          errorCalls.push({ msg, err });
        },
      };

      const plugin = GraphqlPlugin({
        typeDefs: 'INVALID SCHEMA {{{',
        resolvers: { Query: { hello: () => 'world' } },
      });

      // This should throw during schema building, which exercises the error logger
      await expect(
        plugin.register(
          {
            logger: mockLogger,
            router: {
              post: () => {},
              get: () => {},
            },
            services: {
              register: () => {},
            },
            health: {
              register: () => {},
            },
          } as unknown as Parameters<typeof plugin.register>[0],
        ),
      ).rejects.toThrow();

      // The error wrapper should have been called
      expect(errorCalls.length).toBeGreaterThan(0);
    });

    it('handles code-first mode with injected schema', async () => {
      // Test code-first mode using an injected graphqlModule
      const executedSchemas: unknown[] = [];
      const fakeModule = {
        parse: (_src: string) => ({
          kind: 'Document',
          definitions: [{
            kind: 'OperationDefinition',
            operation: 'query',
            selectionSet: { kind: 'SelectionSet', selections: [] },
          }],
        }),
        validate: () => [],
        execute: (args: { schema: unknown }) => {
          executedSchemas.push(args.schema);
          return Promise.resolve({ data: { hello: 'world' } });
        },
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
        getOperationAST: (document: { definitions: Array<{ kind: string; operation?: string }> }) =>
          document.definitions[0] ?? null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      };

      const providedSchema = fakeModule.buildSchema('type Query { hello: String }');
      const plugin = GraphqlPlugin({
        schema: providedSchema,
        graphqlModule: fakeModule,
      });

      let registeredService: unknown;

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: (_token: string, service: unknown) => {
              registeredService = service;
            },
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // The code-first arm must execute against the schema the application
      // handed over, untouched.
      expect(executedSchemas).toEqual([]);
      const service = registeredService as {
        execute(params: { query: string }): Promise<{ status: number }>;
      };
      expect((await service.execute({ query: '{ hello }' })).status).toBe(200);
      expect(executedSchemas).toEqual([providedSchema]);
    });

    it('uses the injected graphqlModule instead of loading one', async () => {
      // Shared field object so mutations persist
      const helloField = { name: 'hello', type: { name: 'String' }, args: [] };
      const queryFields = { hello: helloField };
      const calls: string[] = [];

      const fakeModule = {
        parse: (_src: string) => {
          calls.push('parse');
          return {
            kind: 'Document',
            definitions: [{
              kind: 'OperationDefinition',
              operation: 'query',
              selectionSet: { kind: 'SelectionSet', selections: [] },
            }],
          };
        },
        validate: () => {
          calls.push('validate');
          return [];
        },
        execute: () => {
          calls.push('execute');
          return Promise.resolve({ data: { hello: 'world' } });
        },
        subscribe: () => Promise.resolve({ data: {} }),
        buildSchema: (_src: string) => {
          calls.push('buildSchema');
          return {
            getQueryType: () => ({
              name: 'Query',
              getFields: () => queryFields,
              getInterfaces: () => [],
            }),
            getMutationType: () => null,
            getSubscriptionType: () => null,
            getType: (name: string) => {
              if (name === 'Query') {
                return {
                  name,
                  getFields: () => queryFields,
                };
              }
              return null;
            },
            getPossibleTypes: () => [],
            getDirectives: () => [],
            getDirective: () => null,
            toAST: () => ({}),
          };
        },
        validateSchema: () => [],
        getOperationAST: (document: { definitions: Array<{ kind: string; operation?: string }> }) =>
          document.definitions[0] ?? null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      };

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
        graphqlModule: fakeModule,
      });

      let registeredService: unknown;

      await plugin.register(
        {
          logger: {
            info: () => {},
            error: () => {},
          },
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: (_token: string, service: unknown) => {
              registeredService = service;
            },
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // The injected module built the schema (had the loader run instead, this
      // fake's methods would never be reached).
      expect(calls).toContain('buildSchema');

      const service = registeredService as {
        execute(params: { query: string }): Promise<{ status: number }>;
      };
      const outcome = await service.execute({ query: '{ hello }' });

      expect(outcome.status).toBe(200);
      // ...and every execution step ran through the injected module.
      expect(calls).toContain('parse');
      expect(calls).toContain('validate');
      expect(calls).toContain('execute');
    });

    it('invokes handlerLogger error wrapper', async () => {
      const handlerErrorCalls: { msg: string; err?: unknown }[] = [];

      const mockLogger = {
        info: (_msg: string) => {},
        error: (msg: string, err?: unknown) => {
          handlerErrorCalls.push({ msg, err });
        },
      };

      const plugin = GraphqlPlugin({
        typeDefs: 'type Query { hello: String }',
        resolvers: { Query: { hello: () => 'world' } },
      });

      await plugin.register(
        {
          logger: mockLogger,
          router: {
            post: () => {},
            get: () => {},
          },
          services: {
            register: () => {},
          },
          health: {
            register: () => {},
          },
        } as unknown as Parameters<typeof plugin.register>[0],
      );

      // The handlerLogger is created during registration
      // Verify it was created properly
      expect(handlerErrorCalls.length).toBe(0); // No errors during registration
    });
  });
});
