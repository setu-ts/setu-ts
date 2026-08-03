/**
 * End-to-end tests for GraphQL plugin security features.
 *
 * These tests exercise the production-default path for:
 * - Depth limit enforcement (maxDepth)
 * - Error masking (maskInternalErrors)
 */

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GraphqlPlugin } from '../../src/index.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('GraphQL security', () => {
  describe('depth limit', () => {
    it('rejects queries exceeding maxDepth with 200 under JSON media type', async () => {
      const typeDefs = `
        type Query {
          nested: Nested
        }
        type Nested {
          level1: Nested
          value: String
        }
      `;
      const resolvers = {
        Query: {
          nested: () => ({ level1: { level1: { value: 'deep' } } }),
        },
        Nested: {
          level1: () => ({ value: 'nested' }),
          value: () => 'nested',
        },
      };

      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, maxDepth: 2 })],
      });

      await app.start({ port: 0 });

      // Query with depth 3: nested { level1 { level1 { value } } }
      const deepQuery = '{ nested { level1 { level1 { value } } } }';
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: deepQuery }),
      });
      const json = await res.json() as { errors?: Array<{ message?: string }>; data?: unknown };

      // Under JSON media type, validation errors (including depth limit) return 200 (B1 watershed)
      expect(res.statusCode).toBe(200);
      expect(json.errors?.[0]?.message?.includes('too deep')).toBe(true);

      await app.stop();
    });

    it('rejects queries exceeding maxDepth with 400 under graphql-response media type', async () => {
      const typeDefs = `
        type Query {
          nested: Nested
        }
        type Nested {
          level1: Nested
          value: String
        }
      `;
      const resolvers = {
        Query: {
          nested: () => ({ level1: { level1: { value: 'deep' } } }),
        },
        Nested: {
          level1: () => ({ value: 'nested' }),
          value: () => 'nested',
        },
      };

      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, maxDepth: 2 })],
      });

      await app.start({ port: 0 });

      // Query with depth 3: nested { level1 { level1 { value } } }
      const deepQuery = '{ nested { level1 { level1 { value } } } }';
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          'content-type': 'application/json',
          accept: 'application/graphql-response+json',
        },
        body: JSON.stringify({ query: deepQuery }),
      });
      const json = await res.json() as { errors?: Array<{ message?: string }>; data?: unknown };

      // Under graphql-response media type, validation errors return 400
      expect(res.statusCode).toBe(400);
      expect(json.errors?.[0]?.message?.includes('too deep')).toBe(true);

      await app.stop();
    });

    it('allows queries within maxDepth with 200', async () => {
      const typeDefs = `
        type Query {
          nested: Nested
        }
        type Nested {
          level1: String
        }
      `;
      const resolvers = {
        Query: {
          nested: () => ({ level1: 'nested' }),
        },
      };

      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, maxDepth: 2 })],
      });

      await app.start({ port: 0 });

      const shallowQuery = '{ nested { level1 } }';
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: shallowQuery }),
      });
      const json = await res.json() as {
        errors?: unknown;
        data?: { nested?: { level1?: string } };
      };

      expect(res.statusCode).toBe(200);
      expect(json.data?.nested?.level1).toBe('nested');

      await app.stop();
    });
  });

  describe('error masking', () => {
    it('masks internal errors when maskInternalErrors=true', async () => {
      const typeDefs = `
        type Query {
          error: String
        }
      `;
      const resolvers = {
        Query: {
          error: () => {
            throw new Error('Internal server details');
          },
        },
      };

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maskInternalErrors: true }),
        ],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ error }' }),
      });
      const json = await res.json() as { errors?: Array<{ message?: string }>; data?: unknown };

      expect(json.errors?.[0]?.message).toBe('Internal server error');

      await app.stop();
    });

    it('exposes internal errors when maskInternalErrors=false', async () => {
      const typeDefs = `
        type Query {
          error: String
        }
      `;
      const resolvers = {
        Query: {
          error: () => {
            throw new Error('Internal server details');
          },
        },
      };

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maskInternalErrors: false }),
        ],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ error }' }),
      });
      const json = await res.json() as { errors?: Array<{ message?: string }>; data?: unknown };

      expect(json.errors?.[0]?.message).toBe('Internal server details');

      await app.stop();
    });

    it('masked and unmasked responses differ', async () => {
      const typeDefs = `
        type Query {
          error: String
        }
      `;
      const resolvers = {
        Query: {
          error: () => {
            throw new Error('Internal server details');
          },
        },
      };

      // Test with masking ON
      const appMasked = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maskInternalErrors: true }),
        ],
      });
      await appMasked.start({ port: 0 });

      const maskedRes = await appMasked.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ error }' }),
      });
      const maskedJson = await maskedRes.json() as {
        errors?: Array<{ message?: string }>;
        data?: unknown;
      };
      const maskedMsg = maskedJson.errors?.[0]?.message;

      await appMasked.stop();

      // Test with masking OFF
      const appUnmasked = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maskInternalErrors: false }),
        ],
      });
      await appUnmasked.start({ port: 0 });

      const unmaskedRes = await appUnmasked.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ error }' }),
      });
      const unmaskedJson = await unmaskedRes.json() as {
        errors?: Array<{ message?: string }>;
        data?: unknown;
      };
      const unmaskedMsg = unmaskedJson.errors?.[0]?.message;

      await appUnmasked.stop();

      expect(maskedMsg).toBe('Internal server error');
      expect(unmaskedMsg).toBe('Internal server details');
      expect(maskedMsg).not.toBe(unmaskedMsg);
    });
  });
});
