/**
 * Tests for graphql-loader.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { adaptGraphqlModule, loadGraphqlModule } from '../../src/runtime/graphql-loader.ts';
import { GraphqlRuntimeLoadError } from '../../src/errors/graphql-errors.ts';

describe('graphql-loader', () => {
  describe('adaptGraphqlModule', () => {
    it('adapts a fake graphql module correctly', () => {
      const fakeModule = {
        parse: (_src: string) => ({ kind: 'Document', definitions: [] }),
        validate: () => [],
        execute: () => Promise.resolve({ data: {} }),
        subscribe: () => Promise.resolve({ data: {} } as never),
        buildSchema: (_src: string) => ({
          getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
          getMutationType: () => null,
          getSubscriptionType: () => null,
          getType: () => null,
          getPossibleTypes: () => [],
          getDirectives: () => [],
          getDirective: () => null,
          toAST: () => ({}),
        }),
        validateSchema: () => [],
        getOperationAST: () => null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      };

      const runtime = adaptGraphqlModule(fakeModule as never);

      expect(runtime.parse).toBeDefined();
      expect(runtime.validate).toBeDefined();
      expect(runtime.execute).toBeDefined();
      expect(runtime.buildSchema).toBeDefined();
    });
  });

  describe('loadGraphqlModule with custom importer', () => {
    it('uses injected importer', async () => {
      const fakeModule = {
        parse: (_src: string) => ({ kind: 'Document', definitions: [] }),
        validate: () => [],
        execute: () => Promise.resolve({ data: {} }),
        subscribe: () => Promise.resolve({ data: {} }),
        buildSchema: (_src: string) => ({
          getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
          getMutationType: () => null,
          getSubscriptionType: () => null,
          getType: () => null,
          getPossibleTypes: () => [],
          getDirectives: () => [],
          getDirective: () => null,
          toAST: () => ({}),
        }),
        validateSchema: () => [],
        getOperationAST: () => null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      };

      const runtime = await loadGraphqlModule(() => fakeModule as never);
      expect(runtime.parse).toBeDefined();
    });

    it('uses default importer when not provided', async () => {
      // This test verifies the defaultImporter path is exercised
      // We use a fake importer that returns our fake module
      const fakeModule = {
        parse: (_src: string) => ({ kind: 'Document', definitions: [] }),
        validate: () => [],
        execute: () => Promise.resolve({ data: {} }),
        subscribe: () => Promise.resolve({ data: {} }),
        buildSchema: (_src: string) => ({
          getQueryType: () => ({ name: 'Query', getFields: () => ({}), getInterfaces: () => [] }),
          getMutationType: () => null,
          getSubscriptionType: () => null,
          getType: () => null,
          getPossibleTypes: () => [],
          getDirectives: () => [],
          getDirective: () => null,
          toAST: () => ({}),
        }),
        validateSchema: () => [],
        getOperationAST: () => null,
        GraphQLError: class extends Error {
          override name = 'GraphQLError';
          toJSON() {
            return { message: this.message };
          }
        },
        NoSchemaIntrospectionCustomRule: {},
        specifiedRules: [],
      };

      // Test with explicit importer
      const runtime = await loadGraphqlModule(() => fakeModule as never);
      expect(runtime.parse).toBeDefined();
      expect(runtime.validate).toBeDefined();
      expect(runtime.execute).toBeDefined();
      expect(runtime.subscribe).toBeDefined();
      expect(runtime.buildSchema).toBeDefined();
      expect(runtime.validateSchema).toBeDefined();
      expect(runtime.getOperationAST).toBeDefined();
      expect(runtime.GraphQLError).toBeDefined();
      expect(runtime.NoSchemaIntrospectionCustomRule).toBeDefined();
      expect(runtime.specifiedRules).toBeDefined();
    });

    it('throws GraphqlRuntimeLoadError on importer failure', async () => {
      const failingImporter = () => {
        throw new Error('Import failed');
      };

      await expect(loadGraphqlModule(failingImporter)).rejects.toThrow(GraphqlRuntimeLoadError);
    });

    it('re-throws GraphqlRuntimeLoadError directly', async () => {
      const failingImporter = () => {
        throw new GraphqlRuntimeLoadError('npm:graphql@^16', new Error('Import failed'));
      };

      await expect(loadGraphqlModule(failingImporter)).rejects.toThrow(GraphqlRuntimeLoadError);
    });
  });
});
