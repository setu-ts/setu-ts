/**
 * Integration tests for OpenAPI plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import {
  authMiddleware,
  AuthPlugin,
  publicRoute,
  requireAuth,
  requireRole,
} from '@setu-ts/auth-plugin';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  Controller,
  DecoratorPlugin,
  Get,
  Post,
  Public,
  ValidateBody,
} from '@setu-ts/decorator-plugin';

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

  // §3.6: decorator-registered routes must reach the served spec with the SAME
  // body/response schemas as a programmatic route. Regression guard for the
  // decorator `@ApiResponse({ schema })` wrapper being dropped to `{}`.
  it('should generate spec for decorator-based controllers with body and response schemas', async () => {
    // Distinct schemas per operation so each renders inline (dedup of a shared
    // schema into components/$ref is covered separately in the generator unit tests).
    const ProductSchema = z.object({ id: z.string(), name: z.string() });
    const CreateProductSchema = z.object({ name: z.string() });
    const CreatedProductSchema = z.object({ id: z.string(), createdAt: z.string() });

    @Controller('/products')
    @ApiTags('Products')
    class ProductController {
      @Get('/:id')
      @ApiOperation({ summary: 'Get a product' })
      @ApiResponse({ status: 200, description: 'The product', schema: ProductSchema })
      get(): unknown {
        return { id: '1', name: 'Widget' };
      }

      @Post('/')
      @ApiOperation({ summary: 'Create a product' })
      @ValidateBody(CreateProductSchema)
      @ApiResponse({ status: 201, schema: CreatedProductSchema })
      create(): unknown {
        return { id: '2', createdAt: 'now' };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [ProductController] }),
        OpenApiPlugin({ title: 'Decorator API', version: '2.0.0' }),
      ],
    });

    await app.start();

    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });
    expect(response.statusCode).toBe(200);

    const spec = response.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;

    // Path templating + tags/summary reach the spec.
    expect(paths).toHaveProperty('/products/{id}');
    expect(paths).toHaveProperty('/products');
    const getOp = paths['/products/{id}'].get;
    expect(getOp.tags).toEqual(['Products']);
    expect(getOp.summary).toBe('Get a product');

    // The GET response schema is the REAL converted Zod object, not `{}`,
    // and the decorator-provided description wins over the status default.
    const getResp = getOp.responses as Record<string, Record<string, unknown>>;
    expect(getResp['200'].description).toBe('The product');
    const getSchema =
      ((getResp['200'].content as Record<string, Record<string, unknown>>)['application/json']
        .schema) as Record<string, unknown>;
    expect(getSchema.type).toBe('object');
    expect(getSchema.properties).toEqual(
      expect.objectContaining({ id: { type: 'string' }, name: { type: 'string' } }),
    );

    // The POST request body (via @ValidateBody) and response schema both render.
    const postOp = paths['/products'].post;
    const postBody = postOp.requestBody as Record<string, Record<string, Record<string, unknown>>>;
    const postBodySchema = postBody.content['application/json'].schema as Record<string, unknown>;
    expect(postBodySchema.type).toBe('object');
    expect(postBodySchema.properties).toHaveProperty('name');

    const postResp = postOp.responses as Record<string, Record<string, unknown>>;
    const postRespSchema =
      ((postResp['201'].content as Record<string, Record<string, unknown>>)['application/json']
        .schema) as Record<string, unknown>;
    expect(postRespSchema.type).toBe('object');
    expect(postRespSchema.properties).toHaveProperty('id');

    await app.stop();
  });

  it('should not document its own spec and UI endpoints', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'Test API', version: '1.0.0' })],
    });

    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as { paths: Record<string, unknown> };

    // Both endpoints ARE served — the exclusion is from the document, not the
    // router, so the routes still answer.
    expect((await app.inject({ method: 'GET', url: 'http://localhost/docs' })).statusCode).toBe(
      200,
    );

    expect(Object.keys(spec.paths)).toEqual(['/todos']);
    expect(spec.paths).not.toHaveProperty('/openapi.json');
    expect(spec.paths).not.toHaveProperty('/docs');

    await app.stop();
  });

  it('should exclude the spec endpoint even when Swagger UI is disabled', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({ title: 'Test API', version: '1.0.0', swagger: false }),
      ],
    });

    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).toEqual(['/todos']);

    await app.stop();
  });

  it('should honor custom endpoint paths when excluding its own routes', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          endpoint: '/api-docs',
          specEndpoint: '/api-spec.json',
        }),
      ],
    });

    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/api-spec.json' });
    const spec = response.json() as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).toEqual(['/todos']);

    await app.stop();
  });

  it('should match an excluded path against the group-prefixed pattern', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          exclude: ['/internal/metrics'],
        }),
      ],
    });

    app.router.group('/internal', (r) => {
      // Registered as '/metrics' but stored — and therefore matched — as the
      // resolved '/internal/metrics'.
      r.get('/metrics', { handler: (ctx) => ctx.response.text('') });
    });
    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).toEqual(['/todos']);

    await app.stop();
  });

  it('should refuse a security requirement naming an undeclared scheme', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          // Typo: the document declares `bearerAuth`, not `bearer`.
          security: [{ bearer: [] }],
        }),
      ],
    });

    // Emitting this would produce a document that is invalid per the
    // specification — a lock on every operation with no Authorize button to
    // satisfy it — while the spec endpoint still answered 200, so nothing
    // downstream could detect it.
    await expect(app.start()).rejects.toThrow(/scheme 'bearer'.*not declared/s);
  });

  it('should name the declared schemes when refusing an unknown one', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          security: [{ bearerAuth: [] }],
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/Declared: \(none\)/);
  });

  it('should accept a security requirement whose scheme IS declared', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          },
          security: [{ bearerAuth: [] }, { apiKey: [] }],
        }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    expect(response.statusCode).toBe(200);
    await app.stop();
  });

  it('should document a @Public decorated route as public, not as protected', async () => {
    @Controller('/auth')
    class AuthController {
      @Public()
      @Post('/login')
      login(): unknown {
        return { token: 'x' };
      }

      @Get('/me')
      me(): unknown {
        return { id: '1' };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [AuthController] }),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          security: [{ bearerAuth: [] }],
        }),
      ],
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    // `@Public` is the decorator that means "no authentication". Without it
    // reaching the document, the login route would inherit the document-level
    // requirement and be documented as needing the token it issues — and a
    // decorated app has no other way to opt out.
    expect(spec.paths['/auth/login']?.post?.security).toEqual([]);
    // A route with no `@Public` still inherits.
    expect('security' in (spec.paths['/auth/me']?.get as object)).toBe(false);

    await app.stop();
  });

  it('should derive an operation requirement from the REAL auth guards', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, rbac: { roles: {} } }),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          deriveSecurity: { scheme: 'bearerAuth' },
        }),
      ],
    });

    // No route declares `schema.security`. Everything below is derived from
    // the guards, which is the whole point: the document tracks what actually
    // enforces rather than a second declaration that can drift from it.
    app.router.get('/todos', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json([]),
    });
    app.router.delete('/todos/:id', {
      middleware: [requireRole('admin')],
      handler: (ctx) => ctx.response.json({}),
    });
    app.router.post('/login', {
      middleware: [publicRoute()],
      handler: (ctx) => ctx.response.json({}),
    });
    app.router.get('/unguarded', { handler: (ctx) => ctx.response.json({}) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    expect(spec.paths['/todos']?.get?.security).toEqual([{ bearerAuth: [] }]);
    // requireRole rejects an anonymous caller first, so it requires auth too —
    // but the document cannot say WHICH role, and does not pretend to.
    expect(spec.paths['/todos/{id}']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/login']?.post?.security).toEqual([]);
    // No guard, nothing branded, nothing derived.
    expect('security' in (spec.paths['/unguarded']?.get as object)).toBe(false);

    await app.stop();
  });

  it('should NOT derive from application-level middleware', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, rbac: { roles: {} } }),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          deriveSecurity: { scheme: 'bearerAuth' },
        }),
      ],
    });

    // `authMiddleware` POPULATES ctx.request.user and never rejects, so it is
    // not a guard. It is also app-level and therefore absent from RouteInfo.
    app.middleware.add(authMiddleware());
    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    expect('security' in (spec.paths['/todos']?.get as object)).toBe(false);

    await app.stop();
  });

  it('should let a declared requirement override a derived one end to end', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, rbac: { roles: {} } }),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          deriveSecurity: { scheme: 'bearerAuth' },
        }),
      ],
    });

    app.router.get('/odd', {
      middleware: [requireAuth()],
      schema: { security: [] },
      handler: (ctx) => ctx.response.json({}),
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    expect(spec.paths['/odd']?.get?.security).toEqual([]);

    await app.stop();
  });

  it('should derive against the named scheme when several are declared', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, rbac: { roles: {} } }),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          },
          deriveSecurity: { scheme: 'apiKey' },
        }),
      ],
    });

    app.router.get('/todos', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json([]),
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    expect(spec.paths['/todos']?.get?.security).toEqual([{ apiKey: [] }]);

    await app.stop();
  });

  it('should refuse a derived scheme that is not declared', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
          deriveSecurity: { scheme: 'bearer' },
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/scheme 'bearer'.*not declared/s);
  });

  it('should produce an unchanged document when deriveSecurity is absent', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: 'x'.repeat(40) }, rbac: { roles: {} } }),
        OpenApiPlugin({ title: 'Test API', version: '1.0.0' }),
      ],
    });

    app.router.get('/todos', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json([]),
    });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    // Branding the guards must not change any document by itself — derivation
    // is opt-in, so an application that does not ask for it sees no difference.
    expect('security' in (spec.paths['/todos']?.get as object)).toBe(false);

    await app.stop();
  });

  it('should exclude caller-supplied paths alongside its own', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          exclude: ['/internal/metrics'],
        }),
      ],
    });

    app.router.get('/todos', { handler: (ctx) => ctx.response.json([]) });
    app.router.get('/internal/metrics', { handler: (ctx) => ctx.response.text('') });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).toEqual(['/todos']);

    await app.stop();
  });

  it('should serve a document a client can authenticate against', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        OpenApiPlugin({
          title: 'Test API',
          version: '1.0.0',
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
          security: [{ bearerAuth: [] }],
        }),
      ],
    });

    app.router.post('/login', {
      schema: { security: [] },
      handler: (ctx) => ctx.response.json({ token: 'x' }),
    });
    app.router.get('/todos/:id', { handler: (ctx) => ctx.response.json({ id: ctx.params.id }) });

    await app.start();

    const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      security?: unknown;
      components?: { securitySchemes?: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    // The scheme declaration is what puts an Authorize button in Swagger UI.
    expect(spec.components?.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);

    // `/login` opted out, so it is documented as public.
    expect(spec.paths['/login']?.post?.security).toEqual([]);

    // `/todos/{id}` declared nothing, so it inherits the document requirement,
    // and its path parameter is typed rather than rendering as `any`.
    expect('security' in (spec.paths['/todos/{id}']?.get as object)).toBe(false);
    expect(spec.paths['/todos/{id}']?.get?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);

    await app.stop();
  });
});
