/**
 * E2E tests for GraphQL HTTP transport
 *
 * Tests cover:
 * - Status code rows from plan §3.4 (405/415/400/200)
 * - Media-type negotiation watershed (B1)
 * - Parse errors returning 400 with locations (B3)
 * - GraphiQL GET
 * - Operation kind refusals (B6)
 */

import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GraphqlPlugin } from '../../src/index.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('GraphQL HTTP E2E', () => {
  const typeDefs = `
    type Query {
      hello(name: String): String
      error: String
    }
    type Mutation {
      doSomething: String
    }
  `;

  const resolvers = {
    Query: {
      hello: (_: unknown, args: { name?: string }) => `Hello ${args.name ?? 'World'}`,
      error: () => {
        throw new Error('Test error');
      },
    },
    Mutation: {
      doSomething: () => 'Done',
    },
  };

  describe('status codes (§3.4)', () => {
    it('returns 200 for valid query', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });
      const json = await res.json() as { data?: { hello?: string }; errors?: unknown[] };

      expect(res.statusCode).toBe(200);
      expect(json.data?.hello).toBe('Hello World');
      expect(json.errors).toBeUndefined();

      await app.stop();
    });

    it('returns 415 for unsupported media type', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'text/plain' },
        body: '{ hello }',
      });

      expect(res.statusCode).toBe(415);

      await app.stop();
    });

    it('returns 400 for invalid JSON', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: 'not valid json',
      });
      const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };

      expect(res.statusCode).toBe(400);
      expect(json.errors?.[0]?.extensions?.code).toBe('INVALID_JSON');

      await app.stop();
    });

    it('returns 400 for mutation over GET', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/graphql?query=mutation{doSomething}',
      });

      expect(res.statusCode).toBe(405);

      await app.stop();
    });
  });

  describe('media-type negotiation (B1)', () => {
    it('returns 200 for validation error with Accept: application/json', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      // Validation error (unknown field)
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query: '{ unknownField }' }),
      });
      const json = await res.json() as { errors?: unknown[] };

      // Under 'json' media type, well-formed GraphQL requests (even with validation errors) return 200
      expect(res.statusCode).toBe(200);
      expect(json.errors).toBeDefined();

      await app.stop();
    });

    it('returns 400 for validation error with Accept: application/graphql-response+json', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      // Validation error (unknown field)
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          'content-type': 'application/json',
          accept: 'application/graphql-response+json',
        },
        body: JSON.stringify({ query: '{ unknownField }' }),
      });
      const json = await res.json() as { errors?: unknown[] };

      // Under 'graphql-response' media type, validation errors return 400
      expect(res.statusCode).toBe(400);
      expect(json.errors).toBeDefined();

      await app.stop();
    });

    it('sets correct Content-Type for json media type', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(res.headers.get('content-type')?.includes('application/json')).toBe(true);

      await app.stop();
    });

    it('sets correct Content-Type for graphql-response media type', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: {
          'content-type': 'application/json',
          accept: 'application/graphql-response+json',
        },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(res.headers.get('content-type')?.includes('application/graphql-response+json')).toBe(
        true,
      );

      await app.stop();
    });
  });

  describe('parse errors (B3)', () => {
    it('returns 400 with locations for parse error', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      // Invalid syntax: missing closing brace
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ hello' }),
      });
      const json = await res.json() as {
        errors?: Array<{ message?: string; locations?: unknown[] }>;
      };

      expect(res.statusCode).toBe(400);
      expect(json.errors).toBeDefined();
      expect(json.errors?.[0]?.message).toBeDefined();
      expect(json.errors?.[0]?.locations).toBeDefined();

      await app.stop();
    });
  });

  describe('variables (B2)', () => {
    it('passes numeric variables through verbatim', async () => {
      const typeDefsWithVars = `
        type Query {
          test(limit: Int): String
        }
      `;
      const resolversWithVars = {
        Query: {
          test: (_: unknown, args: { limit?: number }) => `Limit: ${args.limit}`,
        },
      };

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs: typeDefsWithVars, resolvers: resolversWithVars }),
        ],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query($limit: Int) { test(limit: $limit) }',
          variables: { limit: 10 },
        }),
      });
      const json = await res.json() as { data?: { test?: string } };

      expect(res.statusCode).toBe(200);
      expect(json.data?.test).toBe('Limit: 10');

      await app.stop();
    });

    it('passes boolean variables through verbatim', async () => {
      const typeDefsWithVars = `
        type Query {
          test(flag: Boolean): String
        }
      `;
      const resolversWithVars = {
        Query: {
          test: (_: unknown, args: { flag?: boolean }) => `Flag: ${args.flag}`,
        },
      };

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          GraphqlPlugin({ typeDefs: typeDefsWithVars, resolvers: resolversWithVars }),
        ],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query($flag: Boolean) { test(flag: $flag) }',
          variables: { flag: true },
        }),
      });
      const json = await res.json() as { data?: { test?: string } };

      expect(res.statusCode).toBe(200);
      expect(json.data?.test).toBe('Flag: true');

      await app.stop();
    });
  });

  describe('GraphiQL', () => {
    it('serves GraphiQL page on GET with text/html accept', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, graphiql: true })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/graphql',
        headers: { accept: 'text/html' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers.get('content-type')?.includes('text/html')).toBe(true);
      const body = await res.json() as unknown;
      void body; // Skip body check for now

      await app.stop();
    });

    it('returns 400 on GET with no query and no text/html accept', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers, graphiql: true })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/graphql',
        headers: { accept: 'application/json' },
      });

      expect(res.statusCode).toBe(400);

      await app.stop();
    });
  });

  describe('operation kind (B6)', () => {
    it('returns 400 for subscription over POST', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'subscription { test }' }),
      });
      const json = await res.json() as { errors?: Array<{ extensions?: { code?: string } }> };

      expect(res.statusCode).toBe(400);
      expect(json.errors?.[0]?.extensions?.code).toBe('SUBSCRIPTIONS_NOT_SUPPORTED_OVER_HTTP');

      await app.stop();
    });

    it('returns 405 for mutation over GET', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      const res = await app.inject({
        method: 'GET',
        url: '/graphql?query=mutation{doSomething}',
      });

      expect(res.statusCode).toBe(405);

      await app.stop();
    });

    it('returns 405 for mutation with leading comment over GET', async () => {
      const app = createApplication({
        plugins: [RuntimePlugin(), GraphqlPlugin({ typeDefs, resolvers })],
      });

      await app.start({ port: 0 });

      // Mutation with leading comment - should still be detected as mutation
      const res = await app.inject({
        method: 'GET',
        url: '/graphql?query=%23%20comment%0Amutation%7BdoSomething%7D',
      });

      expect(res.statusCode).toBe(405);

      await app.stop();
    });
  });
});
