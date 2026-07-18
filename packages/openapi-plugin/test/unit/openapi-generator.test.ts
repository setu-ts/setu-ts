/**
 * Tests for OpenApiGenerator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import type { RouteInfo } from '@hono-enterprise/common';
import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';

describe('OpenApiGenerator', () => {
  describe('generate', () => {
    it('should generate basic OpenAPI document with info', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [];
      const result = generator.generate(routes);

      expect(result.openapi).toBe('3.1.0');
      expect(result.info).toEqual({
        title: 'Test API',
        version: '1.0.0',
      });
    });

    it('should include description when provided', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        description: 'Test description',
      });

      const routes: readonly RouteInfo[] = [];
      const result = generator.generate(routes);

      expect(result.info).toEqual({
        title: 'Test API',
        version: '1.0.0',
        description: 'Test description',
      });
    });

    it('should convert :param to {param} in paths', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              response: {
                200: z.object({ id: z.string(), name: z.string() }),
              },
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths).toHaveProperty('/users/{id}');
      expect(result.paths).not.toHaveProperty('/users/:id');
    });

    it('should generate operationId from method and path', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths['/users/{id}']?.get?.operationId).toBe('get-users-{id}');
    });

    it('should include summary from RouteSchema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              summary: 'Get all users',
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths['/users']?.get?.summary).toBe('Get all users');
    });

    it('should include tags from RouteSchema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              tags: ['users'],
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths['/users']?.get?.tags).toEqual(['users']);
    });

    it('should generate requestBody from body schema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'POST',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              body: z.object({ name: z.string() }),
            },
          },
        },
      ];

      const result = generator.generate(routes);

      // The generator includes the schema in the requestBody
      const requestBody = result.paths['/users']?.post?.requestBody;
      expect(requestBody).toBeDefined();
      expect(requestBody?.content?.['application/json']?.schema).toBeDefined();
      // Verify the schema has the correct structure
      expect(requestBody?.content?.['application/json']?.schema).toEqual(
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            name: expect.objectContaining({ type: 'string' }),
          }),
          required: expect.arrayContaining(['name']),
        }),
      );
    });

    it('should generate parameters from params schema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              params: z.object({ id: z.string() }),
            },
          },
        },
      ];

      const result = generator.generate(routes);

      const params = result.paths['/users/{id}']?.get?.parameters;
      expect(params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'id',
            in: 'path',
            required: true,
          }),
        ]),
      );
    });

    it('should generate parameters from query schema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              query: z.object({
                page: z.number().optional(),
                limit: z.number(),
              }),
            },
          },
        },
      ];

      const result = generator.generate(routes);

      const params = result.paths['/users']?.get?.parameters;
      expect(params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'page',
            in: 'query',
            required: false,
          }),
          expect.objectContaining({
            name: 'limit',
            in: 'query',
            required: true,
          }),
        ]),
      );
    });

    it('should generate responses from response schema', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              response: {
                200: z.object({ id: z.string() }),
                404: z.object({ error: z.string() }),
              },
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths['/users/{id}']?.get?.responses).toEqual({
        '200': expect.objectContaining({
          description: 'Successful response',
        }),
        '404': expect.objectContaining({
          description: 'Not found',
        }),
      });
    });

    it('should deduplicate schemas into components/schemas', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const userSchema = z.object({ id: z.string(), name: z.string() });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              response: {
                200: userSchema,
              },
            },
          },
        },
        {
          method: 'POST',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              body: userSchema,
              response: {
                201: userSchema,
              },
            },
          },
        },
      ];

      const result = generator.generate(routes);

      // Per plan §3.4: schemas used more than once get Schema<n> names and are hoisted
      expect(result.components?.schemas).toHaveProperty('Schema1');
    });

    it('should use $ref for deduplicated schemas', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const userSchema = z.object({ id: z.string(), name: z.string() });

      // Use the same schema twice to trigger deduplication
      const routes: readonly RouteInfo[] = [
        {
          method: 'POST',
          path: '/users',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              body: userSchema,
              response: {
                201: userSchema,
              },
            },
          },
        },
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              response: {
                200: userSchema,
              },
            },
          },
        },
      ];

      const result = generator.generate(routes);

      const responseSchema = result.paths['/users/{id}']?.get?.responses['200']?.content
        ?.['application/json']?.schema;
      // Per plan §3.4: reused schemas get $ref with Schema<n> name
      expect(responseSchema).toEqual({
        $ref: '#/components/schemas/Schema1',
      });
    });

    it('should include servers when provided', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        servers: [{ url: 'https://api.example.com', description: 'Production' }],
      });

      const routes: readonly RouteInfo[] = [];
      const result = generator.generate(routes);

      expect(result.servers).toEqual([
        { url: 'https://api.example.com', description: 'Production' },
      ]);
    });

    it('should include securitySchemes in components', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      });

      const routes: readonly RouteInfo[] = [];
      const result = generator.generate(routes);

      expect(result.components?.securitySchemes).toEqual({
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      });
    });

    it('should handle multi-segment path parameters', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/orgs/:orgId/users/:userId',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths).toHaveProperty('/orgs/{orgId}/users/{userId}');
    });
  });

  describe('addSchema', () => {
    it('should register a named schema for deduplication', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
      });

      // Use a unique schema name that won't match any auto-generated names
      const schema = z.object({ customField: z.string() });
      generator.addSchema('CustomSchema', schema);

      const routes: readonly RouteInfo[] = [];
      const result = generator.generate(routes);

      // The schema should be registered in components
      expect(result.components?.schemas).toBeDefined();
      expect(Object.keys(result.components?.schemas || {})).toContain('CustomSchema');
    });
  });
});
