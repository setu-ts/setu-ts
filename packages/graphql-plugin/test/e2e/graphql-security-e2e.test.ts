/**
 * End-to-end tests for GraphQL plugin security features.
 *
 * These tests exercise the production-default path for:
 * - Depth limit enforcement (maxDepth)
 * - Error masking (maskInternalErrors)
 */

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
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

  // -------------------------------------------------------------------------
  // X32-6 — breadth limit
  // -------------------------------------------------------------------------

  describe('node budget (X32-6)', () => {
    const typeDefs = `
      type Query {
        user: User
      }
      type User {
        id: ID
        name: String
      }
    `;
    const resolvers = {
      Query: { user: () => ({ id: '1', name: 'ada' }) },
    };

    /** 200 aliases of the same field at depth 2 — the X32-6 shape. */
    function aliasBomb(count: number): string {
      const aliases = Array.from({ length: count }, (_, i) => `a${i}: user { id name }`);
      return `{ ${aliases.join(' ')} }`;
    }

    it('refuses an alias bomb through the REAL validator when maxNodes is set', async () => {
      // The unit tests drive the rule directly; only this proves the plugin
      // option reaches `validate()` at all.
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maxNodes: 100 }),
        ],
      });
      await app.start({ port: 0 });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: aliasBomb(200) }),
        });
        const json = await res.json() as { errors?: Array<{ message?: string }>; data?: unknown };

        // A validation error under the JSON media type is 200 (the B1
        // watershed), same as the depth limiter above.
        expect(res.statusCode).toBe(200);
        expect(json.errors?.[0]?.message).toContain('Maximum node count is 100');
        expect(json.data).toBeUndefined();
      } finally {
        await app.stop();
      }
    });

    it('serves the SAME query when maxNodes is unset — the released default', async () => {
      // Default-off, so no released application starts refusing a document it
      // used to serve. This is the discriminating half.
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });
      await app.start({ port: 0 });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: aliasBomb(200) }),
        });
        const json = await res.json() as { errors?: unknown; data?: Record<string, unknown> };

        expect(res.statusCode).toBe(200);
        expect(json.errors).toBeUndefined();
        expect(Object.keys(json.data ?? {})).toHaveLength(200);
      } finally {
        await app.stop();
      }
    });

    it('a bundled document is judged by its LARGEST operation, not the sum', async () => {
      // Qodo review finding: summing refused a document whose SELECTED operation
      // was within budget. Each operation here costs 3 (user + id + name) against
      // a budget of 4; summed they are 6. The sibling `maxDepth` already behaved
      // per-operation, so the two limiters disagreed about what a "query" is.
      const bundled = `
        query A { user { id name } }
        query B { user { id name } }
      `;
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, maxNodes: 4 })],
      });
      await app.start({ port: 0 });
      try {
        for (const operationName of ['A', 'B']) {
          const res = await app.inject({
            method: 'POST',
            url: '/graphql',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: bundled, operationName }),
          });
          const json = await res.json() as { errors?: unknown; data?: unknown };
          expect(json.errors).toBeUndefined();
          expect(json.data).toBeDefined();
        }

        // The bound still binds: an operation that alone exceeds the budget is
        // refused whichever operation the caller selects, which is the policy —
        // no operation in the document may exceed it.
        const withBig = `
          query Small { user { id } }
          query Big { ${Array.from({ length: 10 }, (_, i) => `a${i}: user { id name }`).join(' ')} }
        `;
        const res = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: withBig, operationName: 'Small' }),
        });
        const json = await res.json() as { errors?: Array<{ message?: string }> };
        expect(json.errors?.[0]?.message).toContain('Maximum node count is 4');
      } finally {
        await app.stop();
      }
    });

    it('depth and breadth are independent limits', async () => {
      // A narrow query well within `maxNodes` is served, and a wide one within
      // `maxDepth` is refused — so neither limiter is standing in for the other.
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs, resolvers, maxDepth: 10, maxNodes: 10 }),
        ],
      });
      await app.start({ port: 0 });
      try {
        const narrow = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ user { id name } }' }),
        });
        const narrowJson = await narrow.json() as { data?: unknown; errors?: unknown };
        expect(narrowJson.errors).toBeUndefined();
        expect(narrowJson.data).toBeDefined();

        const wide = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: aliasBomb(20) }),
        });
        const wideJson = await wide.json() as { errors?: Array<{ message?: string }> };
        expect(wideJson.errors?.[0]?.message).toContain('Maximum node count is 10');
      } finally {
        await app.stop();
      }
    });
  });
});
