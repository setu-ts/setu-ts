/**
 * Tests for OpenApiGenerator.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import type { MiddlewareFunction, RouteInfo } from '@setu-ts/common';
import { withSecurityMetadata } from '@setu-ts/common';
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

      // M70m/X11-8: a path placeholder is unwrapped rather than carried into
      // the id verbatim — braces are URL-unsafe and Redocly's recommended
      // ruleset flags them.
      expect(result.paths['/users/{id}']?.get?.operationId).toBe('get-users-by-id');
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

    it('should generate parameters from headers schema', () => {
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
              headers: z.object({
                'x-request-id': z.string(),
                'x-trace-flags': z.string().optional(),
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
            name: 'x-request-id',
            in: 'header',
            required: true,
          }),
          expect.objectContaining({
            name: 'x-trace-flags',
            in: 'header',
            required: false,
          }),
        ]),
      );
    });

    it('should emit no header parameters when the headers schema has no properties', () => {
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
            // A non-object schema transforms to `{ type: 'string' }` — no
            // `properties`, no `required` — which must yield no parameters
            // rather than throwing.
            schema: { headers: z.string() },
          },
        },
      ];

      const result = generator.generate(routes);

      expect(result.paths['/users']?.get?.parameters).toBeUndefined();
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

    it('should unwrap the decorator { schema, description } response shape', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const routes: readonly RouteInfo[] = [
        {
          method: 'GET',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            schema: {
              // Shape produced by the decorator plugin's @ApiResponse.
              response: {
                200: { description: 'The user', schema: z.object({ id: z.string() }) },
              },
            },
          },
        },
      ];

      const response = generator.generate(routes).paths['/users/{id}']?.get?.responses['200'];
      // The decorator description wins over the status-code default.
      expect(response?.description).toBe('The user');
      // The inner Zod schema is transformed, NOT collapsed to `{}`.
      expect(response?.content?.['application/json']?.schema).toEqual({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
    });

    it('should emit a bare response (no content) for a schemaless status', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const routes: readonly RouteInfo[] = [
        {
          method: 'DELETE',
          path: '/users/:id',
          definition: {
            handler: () => {
              throw new Error('not used');
            },
            // A non-object response value (e.g. an unset status) yields a
            // description-only response with no content block.
            schema: { response: { 204: null as unknown as undefined } },
          },
        },
      ];

      const response = generator.generate(routes).paths['/users/{id}']?.delete?.responses['204'];
      expect(response?.description).toBe('No content');
      expect(response?.content).toBeUndefined();
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

      // M70m/X11-6: a hoisted component is named from the site that first
      // reached it — here the GET route, which is listed first — rather than
      // the meaningless `Schema1`. Exactly one component, not one per site.
      expect(Object.keys(result.components?.schemas ?? {})).toEqual([
        'GetUsersByIdResponse200',
      ]);
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

      // M70m/X11-6: EVERY site of a reused schema carries the `$ref`,
      // including the first. Before this the first use was inlined and never
      // rewritten, so one shape appeared in two forms in one document.
      const ref = { $ref: '#/components/schemas/PostUsersBody' };
      const responseSchema = result.paths['/users/{id}']?.get?.responses['200']?.content
        ?.['application/json']?.schema;
      expect(responseSchema).toEqual(ref);

      const bodySchema = result.paths['/users']?.post?.requestBody?.content['application/json']
        ?.schema;
      expect(bodySchema).toEqual(ref);

      const createdSchema = result.paths['/users']?.post?.responses['201']?.content
        ?.['application/json']?.schema;
      expect(createdSchema).toEqual(ref);

      // Exactly one component, not one per site.
      expect(Object.keys(result.components?.schemas ?? {})).toEqual(['PostUsersBody']);
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

  describe('path parameter schemas', () => {
    it('should type an undeclared path parameter as a string, not as any', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([route('GET', '/users/:id')]);

      const params = result.paths['/users/{id}']?.get?.parameters;
      expect(params).toEqual([
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ]);
    });

    it('should still prefer the declared params schema over the string default', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([
        route('GET', '/users/:id', { params: z.object({ id: z.string().uuid() }) }),
      ]);

      const params = result.paths['/users/{id}']?.get?.parameters;
      expect(params?.[0]?.schema).toEqual({ type: 'string', format: 'uuid' });
    });

    it('should give each parameter its OWN default schema object', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([route('GET', '/a/:x'), route('GET', '/b/:y')]);

      const first = result.paths['/a/{x}']?.get?.parameters?.[0]?.schema;
      const second = result.paths['/b/{y}']?.get?.parameters?.[0]?.schema;

      // `OpenApiSchemaObject` declares mutable fields and `OpenApiDocument` is
      // public API, so a consumer post-processing the document may assign to a
      // parameter schema. A shared constant would alias every path parameter
      // in the process; a frozen one would throw on a legitimate write.
      expect(first).not.toBe(second);
      expect(Object.isFrozen(first)).toBe(false);

      (first as { type?: string }).type = 'integer';
      expect(second).toEqual({ type: 'string' });
    });

    it('should default only the parameters the params schema omits', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([
        route('GET', '/orgs/:orgId/users/:userId', {
          params: z.object({ orgId: z.number() }),
        }),
      ]);

      const params = result.paths['/orgs/{orgId}/users/{userId}']?.get?.parameters;
      expect(params?.[0]).toEqual({
        name: 'orgId',
        in: 'path',
        required: true,
        schema: { type: 'number' },
      });
      expect(params?.[1]).toEqual({
        name: 'userId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    });
  });

  describe('exclude', () => {
    it('should omit an excluded path from the document', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        exclude: ['/openapi.json', '/docs'],
      });

      const result = generator.generate([
        route('GET', '/users'),
        route('GET', '/openapi.json'),
        route('GET', '/docs'),
      ]);

      expect(Object.keys(result.paths)).toEqual(['/users']);
    });

    it('should omit every method registered on an excluded path', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        exclude: ['/internal'],
      });

      const result = generator.generate([
        route('GET', '/internal'),
        route('POST', '/internal'),
        route('DELETE', '/internal'),
      ]);

      expect(result.paths).toEqual({});
    });

    it('should match the registered router path, not the OpenAPI template', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        exclude: ['/users/:id'],
      });

      const result = generator.generate([route('GET', '/users/:id'), route('GET', '/users')]);

      expect(Object.keys(result.paths)).toEqual(['/users']);
    });

    it('should keep every path when no exclusions are configured', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([route('GET', '/users'), route('GET', '/docs')]);

      expect(Object.keys(result.paths).sort()).toEqual(['/docs', '/users']);
    });
  });

  describe('deriveSecurity', () => {
    /** Stand-ins for branded guards; the real ones are driven in the integration suite. */
    const guard = () => withSecurityMetadata(passthrough(), { authenticated: true });
    const open = () => withSecurityMetadata(passthrough(), { authenticated: false });

    it('should derive a requirement from a branded guard', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        securitySchemes: { bearerAuth: {} },
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      const result = generator.generate([route('GET', '/todos', undefined, [guard()])]);

      expect(result.paths['/todos']?.get?.security).toEqual([{ bearerAuth: [] }]);
    });

    it('should derive an empty requirement from an explicitly public guard', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      const result = generator.generate([route('GET', '/health', undefined, [open()])]);

      expect(result.paths['/health']?.get?.security).toEqual([]);
    });

    it('should let a DECLARED requirement win over a derived one', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      // The guard says protected; the route declares public. Declared wins, so
      // this milestone cannot change a document that already declares.
      const result = generator.generate([route('POST', '/login', { security: [] }, [guard()])]);

      expect(result.paths['/login']?.post?.security).toEqual([]);
    });

    it('should treat authenticated as winning when a route carries both brands', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      // Matches enforcement: publicRoute() only calls next(), so requireAuth()
      // still rejects an anonymous caller.
      const result = generator.generate([route('GET', '/both', undefined, [open(), guard()])]);

      expect(result.paths['/both']?.get?.security).toEqual([{ bearerAuth: [] }]);
    });

    it('should derive nothing when the option is absent', () => {
      const generator = new OpenApiGenerator({ title: 'T', version: '1' });

      const result = generator.generate([route('GET', '/todos', undefined, [guard()])]);

      expect('security' in (result.paths['/todos']?.get as object)).toBe(false);
    });

    it('should derive nothing from unbranded middleware', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      const result = generator.generate([route('GET', '/todos', undefined, [passthrough()])]);

      expect('security' in (result.paths['/todos']?.get as object)).toBe(false);
    });

    it('should derive nothing when the route declares no middleware at all', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'bearerAuth' },
      });

      // `RouteDefinition.middleware` is optional — the derivation must not
      // assume an array is present.
      const result = generator.generate([route('GET', '/todos')]);

      expect('security' in (result.paths['/todos']?.get as object)).toBe(false);
    });

    it('should use the configured scheme name verbatim', () => {
      const generator = new OpenApiGenerator({
        title: 'T',
        version: '1',
        deriveSecurity: { scheme: 'myCustomScheme' },
      });

      const result = generator.generate([route('GET', '/todos', undefined, [guard()])]);

      expect(result.paths['/todos']?.get?.security).toEqual([{ myCustomScheme: [] }]);
    });
  });

  describe('security', () => {
    it('should emit the document-level requirement when configured', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        security: [{ bearerAuth: [] }],
      });

      const result = generator.generate([route('GET', '/users')]);

      expect(result.security).toEqual([{ bearerAuth: [] }]);
      expect(result.components?.securitySchemes).toEqual({
        bearerAuth: { type: 'http', scheme: 'bearer' },
      });
    });

    it('should omit document-level security when not configured', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([route('GET', '/users')]);

      expect(result.security).toBeUndefined();
      expect('security' in result).toBe(false);
    });

    it('should emit a route-declared requirement on the operation', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([
        route('GET', '/todos', { security: [{ bearerAuth: [] }] }),
      ]);

      expect(result.paths['/todos']?.get?.security).toEqual([{ bearerAuth: [] }]);
    });

    it('should emit scopes for an OAuth2-style requirement', () => {
      const generator = new OpenApiGenerator({ title: 'Test API', version: '1.0.0' });

      const result = generator.generate([
        route('POST', '/todos', { security: [{ oauth2: ['write:todos'] }] }),
      ]);

      expect(result.paths['/todos']?.post?.security).toEqual([{ oauth2: ['write:todos'] }]);
    });

    it('should emit an EMPTY security array so a route can opt out of the document default', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        security: [{ bearerAuth: [] }],
      });

      const result = generator.generate([route('POST', '/login', { security: [] })]);

      // The empty array is the specification's marker for a public operation.
      // Dropping it (an `.length > 0` guard) would leave `/login` inheriting
      // the document requirement and documented as needing the token it issues.
      expect(result.paths['/login']?.post?.security).toEqual([]);
    });

    it('should leave an undeclared operation without a security key so it inherits', () => {
      const generator = new OpenApiGenerator({
        title: 'Test API',
        version: '1.0.0',
        security: [{ bearerAuth: [] }],
      });

      const result = generator.generate([route('GET', '/todos')]);

      const operation = result.paths['/todos']?.get;
      expect(operation).toBeDefined();
      expect('security' in (operation as object)).toBe(false);
    });
  });
});

/**
 * Builds a `RouteInfo` with a handler that is never invoked — these tests
 * exercise document generation, never dispatch.
 */
function route(
  method: RouteInfo['method'],
  path: string,
  schema?: RouteInfo['definition']['schema'],
  middleware?: readonly MiddlewareFunction[],
): RouteInfo {
  return {
    method,
    path,
    definition: {
      handler: () => {
        throw new Error('not used');
      },
      ...(schema !== undefined ? { schema } : {}),
      ...(middleware !== undefined ? { middleware } : {}),
    },
  };
}

/** An unbranded middleware, for the negative derivation cases. */
function passthrough(): MiddlewareFunction {
  return async (_ctx, next) => {
    await next();
  };
}
