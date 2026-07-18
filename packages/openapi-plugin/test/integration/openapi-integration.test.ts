/**
 * Integration tests for OpenAPI plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

describe('OpenAPI Integration', () => {
  it('should generate OpenAPI spec for programmatic routes', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
        }),
      ],
    });

    // Register a route with Zod schema
    app.router.post('/users', {
      handler: (ctx) => {
        return ctx.response.status(201).json({ id: '1', name: 'Test' });
      },
      schema: {
        body: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            name: z.string(),
          }),
        },
      },
    });

    app.router.get('/users/:id', {
      handler: (ctx) => {
        return ctx.response.json({ id: ctx.params.id, name: 'Test' });
      },
      schema: {
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
          }),
        },
      },
    });

    await app.start();

    // Get the OpenAPI spec
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const openapiSpec = response.json() as Record<string, unknown>;
    expect(openapiSpec.openapi).toBe('3.1.0');
    expect(openapiSpec.info).toEqual(
      expect.objectContaining({
        title: 'Test API',
        version: '1.0.0',
      }),
    );
    expect(openapiSpec.paths).toHaveProperty('/users');
    expect(openapiSpec.paths).toHaveProperty('/users/{id}');
    await app.stop();
  });

  it('should serve Swagger UI HTML', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          swagger: true,
        }),
      ],
    });

    await app.start();

    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = response.body ?? '';
    expect(html).toContain('swagger-ui');
    expect(html).toContain('/openapi.json');

    await app.stop();
  });

  it('should not serve Swagger UI when swagger is false', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          swagger: false,
        }),
      ],
    });

    await app.start();

    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/docs',
    });

    // When swagger is false, /docs endpoint should return 404
    expect(response.statusCode).toBe(404);

    // But spec endpoint should still work
    const specResponse = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });
    expect(specResponse.statusCode).toBe(200);

    await app.stop();
  });

  it('should handle routes with query parameters', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
        }),
      ],
    });

    app.router.get('/users', {
      handler: (ctx) => {
        return ctx.response.json({ users: [] });
      },
      schema: {
        query: z.object({
          page: z.number().optional(),
          limit: z.number().default(10),
        }),
      },
    });

    await app.start();

    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });

    const spec = response.json() as Record<string, unknown>;

    expect(spec.paths).toEqual(
      expect.objectContaining({
        '/users': expect.objectContaining({
          get: expect.objectContaining({
            parameters: expect.arrayContaining([
              expect.objectContaining({
                name: 'page',
                in: 'query',
              }),
              expect.objectContaining({
                name: 'limit',
                in: 'query',
              }),
            ]),
          }),
        }),
      }),
    );

    // C4 guard: assert required and default on the 'limit' parameter
    const paths = spec.paths as Record<string, unknown>;
    const params = ((paths['/users'] as Record<string, unknown>).get as Record<string, unknown>)
      .parameters as Array<Record<string, unknown>>;
    const limitParam = params.find((p) => p.name === 'limit');
    expect(limitParam).toBeDefined();
    expect(limitParam?.required).toBe(false);
    expect((limitParam?.schema as Record<string, unknown> | undefined)?.default).toBe(10);

    await app.stop();
  });

  it('should use custom endpoints', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          endpoint: '/api-docs',
          specEndpoint: '/api/spec.json',
        }),
      ],
    });

    await app.start();

    // Custom spec endpoint should work
    const specResponse = await app.inject({
      method: 'GET',
      url: 'http://localhost/api/spec.json',
    });
    expect(specResponse.statusCode).toBe(200);

    // Custom UI endpoint should work
    const uiResponse = await app.inject({
      method: 'GET',
      url: 'http://localhost/api-docs',
    });
    expect(uiResponse.statusCode).toBe(200);

    // Default endpoints should not work
    const defaultSpecResponse = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });
    expect(defaultSpecResponse.statusCode).toBe(404);

    const defaultUiResponse = await app.inject({
      method: 'GET',
      url: 'http://localhost/docs',
    });
    expect(defaultUiResponse.statusCode).toBe(404);

    await app.stop();
  });

  // T1: End-to-end test that a cross-plugin OPENAPI_SCHEMA contribution appears in the served /openapi.json spec
  it('should include cross-plugin OPENAPI_SCHEMA contributions in the served spec', async () => {
    // Create a fake plugin that contributes a schema via ctx.openapi.addSchema()
    const schemaContributorPlugin: IPlugin = {
      name: 'schema-contributor-plugin',
      version: '1.0.0',
      provides: [CAPABILITIES.OPENAPI_SCHEMA],
      priority: PLUGIN_PRIORITY.NORMAL,
      register(ctx: IPluginContext): void {
        // This contributes a named schema that should appear in the final OpenAPI spec
        ctx.openapi.addSchema(
          'User',
          z.object({
            id: z.string(),
            email: z.string().email(),
            createdAt: z.string().datetime(),
          }),
        );
      },
    };

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        // Register the schema contributor before the OpenAPI plugin
        schemaContributorPlugin,
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
        }),
      ],
    });

    // Register a route that references the contributed schema
    app.router.post('/users', {
      handler: (ctx) => {
        return ctx.response.status(201).json({ id: '1', name: 'Test' });
      },
      schema: {
        body: z.object({
          name: z.string(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            name: z.string(),
          }),
        },
      },
    });

    await app.start();

    // Hit the spec endpoint and verify the contributed schema appears
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const openapiSpec = response.json() as unknown as Record<string, unknown>;
    const apiComponents = openapiSpec.components as Record<string, unknown> | undefined;
    expect(apiComponents).toBeDefined();
    const schemas = (apiComponents ?? {}).schemas as Record<string, unknown>;
    expect(schemas).toBeDefined();

    // The 'User' schema contributed by the fake plugin should appear in components.schemas
    expect(schemas).toHaveProperty('User');
    const userSchema = schemas.User as Record<string, unknown>;
    expect(userSchema.type).toBe('object');
    expect(userSchema.properties).toBeDefined();

    await app.stop();
  });
});
