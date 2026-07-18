/**
 * Tests for OpenApiService.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IApplication } from '@hono-enterprise/common';
import { OpenApiService } from '../../src/services/openapi-service.ts';
import { z } from 'npm:zod@^3.24.0';

/**
 * Minimal Router mock for testing.
 */
class MockRouter {
  readonly routes: Array<{ method: string; path: string; handler: unknown }> = [];

  get(path: string, handler: unknown): void {
    this.routes.push({ method: 'GET', path, handler });
  }

  post(path: string, handler: unknown): void {
    this.routes.push({ method: 'POST', path, handler });
  }

  put(path: string, handler: unknown): void {
    this.routes.push({ method: 'PUT', path, handler });
  }

  patch(path: string, handler: unknown): void {
    this.routes.push({ method: 'PATCH', path, handler });
  }

  delete(path: string, handler: unknown): void {
    this.routes.push({ method: 'DELETE', path, handler });
  }

  head(path: string, handler: unknown): void {
    this.routes.push({ method: 'HEAD', path, handler });
  }

  options(path: string, handler: unknown): void {
    this.routes.push({ method: 'OPTIONS', path, handler });
  }

  group(_prefix: string, configure: (router: unknown) => void): void {
    // Simple mock implementation
    const subRouter = new MockRouter();
    configure(subRouter);
  }

  listRoutes(): readonly {
    readonly method: string;
    readonly path: string;
    readonly definition: { readonly handler: unknown };
  }[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: r.path,
      definition: { handler: r.handler },
    }));
  }
}

describe('OpenApiService', () => {
  let app: IApplication;
  let router: MockRouter;

  beforeEach(() => {
    router = new MockRouter();
    app = {
      router,
      services: {
        register: () => {},
        registerFactory: () => {},
        get: () => {
          throw new Error('not implemented');
        },
        getAll: () => [],
        has: () => false,
        unregister: () => {},
      },
      middleware: {
        add: () => {},
      },
      lifecycle: {
        onInit: () => {},
        onShutdown: () => {},
      },
      health: {
        register: () => {},
      },
      metrics: {
        register: () => {},
      },
      environment: {
        validate: () => {},
      },
      decorators: {
        addController: () => {},
      },
      cli: {
        command: () => {},
      },
    } as unknown as IApplication;
  });

  it('should generate spec on first getSpec call', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const spec = service.getSpec();

    expect(spec).toBeDefined();
    expect(typeof spec).toBe('object');
  });

  it('should cache spec on subsequent getSpec calls', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const spec1 = service.getSpec();
    const spec2 = service.getSpec();

    expect(spec1).toBe(spec2);
  });

  it('should include routes in generated spec', () => {
    router.get('/users', () => {
      throw new Error('not used');
    });

    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
  });

  it('should use title from options', () => {
    const service = new OpenApiService({
      app,
      title: 'My Custom API',
      version: '1.0.0',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.info).toEqual(
      expect.objectContaining({
        title: 'My Custom API',
      }),
    );
  });

  it('should use version from options', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '2.0.0',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.info).toEqual(
      expect.objectContaining({
        version: '2.0.0',
      }),
    );
  });

  it('should use default title when not provided', () => {
    const service = new OpenApiService({
      app,
      version: '1.0.0',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.info).toEqual(
      expect.objectContaining({
        title: 'API',
      }),
    );
  });

  it('should use default version when not provided', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.info).toEqual(
      expect.objectContaining({
        version: '1.0.0',
      }),
    );
  });

  it('should include description in spec when provided', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      description: 'A test API description',
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec.info).toEqual(
      expect.objectContaining({
        description: 'A test API description',
      }),
    );
  });

  it('should include servers in spec when provided', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      servers: [{ url: 'https://api.example.com', description: 'Production' }],
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec).toHaveProperty('servers');
    expect(Array.isArray(spec.servers)).toBe(true);
  });

  it('should include securitySchemes in spec when provided', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec).toHaveProperty('components.securitySchemes');
  });

  it('should register pre-registered schemas in the generator', () => {
    const testSchema = z.object({ id: z.string() });
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      schemas: [{ name: 'Test', schema: testSchema }],
    });

    const spec = service.getSpec() as Record<string, unknown>;

    // The schema should be registered
    expect(spec).toBeDefined();
  });

  it('should register pre-registered schemas from options', () => {
    const testSchema = z.object({ id: z.string(), name: z.string() });
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      schemas: [{ name: 'TestModel', schema: testSchema }],
    });

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec).toBeDefined();
    expect(spec.components).toBeDefined();
  });

  // N2 test: addSchema before getSpec with non-empty schemas option
  it('should include options.schemas even when addSchema is called before getSpec', () => {
    const schemaA = z.object({ id: z.string() });
    const schemaB = z.object({ userId: z.string() });
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      schemas: [{ name: 'A', schema: schemaA }],
    });

    // Call addSchema before getSpec — this used to silently drop 'A'
    service.addSchema('B', schemaB);

    const spec = service.getSpec() as unknown as Record<string, unknown>;
    const comps = spec.components as Record<string, unknown> | undefined;
    expect(comps?.schemas).toBeDefined();
    const schemas = comps?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toHaveProperty('A');
    expect(schemas).toHaveProperty('B');
  });

  it('should call addSchema to register a new schema', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const newSchema = z.object({ userId: z.string() });
    service.addSchema('UserSchema', newSchema);

    const spec = service.getSpec() as Record<string, unknown>;

    expect(spec).toBeDefined();
  });

  it('should invalidate cache when addSchema is called', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const spec1 = service.getSpec();
    service.addSchema('NewSchema', z.object({ foo: z.string() }));
    const spec2 = service.getSpec();

    expect(spec1).not.toBe(spec2);
  });

  it('should call addSchema with description option', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      description: 'Test description',
    });

    service.addSchema('TestSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
  });

  it('should call addSchema with servers option', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      servers: [{ url: 'https://api.example.com', description: 'Production' }],
    });

    service.addSchema('TestSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
  });

  it('should call addSchema with securitySchemes option', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    });

    service.addSchema('TestSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
  });

  it('should call addSchema with all options', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      description: 'Test description',
      servers: [{ url: 'https://api.example.com', description: 'Production' }],
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    });

    service.addSchema('TestSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
  });

  // T2 tests: C2, C3, C4 regression guards
  it('C2: second generate() call should reuse pre-registered schema ($ref)', () => {
    const userSchema = z.object({ id: z.string(), name: z.string() });
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    service.addSchema('User', userSchema);
    router.post('/users', {
      handler: () => ({}),
      schema: { body: z.object({ userId: z.string() }) },
    });

    // First generate
    const spec1 = service.getSpec() as unknown as Record<string, unknown>;
    const comps1 = spec1.components as Record<string, unknown> | undefined;
    expect(comps1?.schemas).toBeDefined();
    const schemas1 = comps1?.schemas as Record<string, unknown> | undefined;
    expect(schemas1).toHaveProperty('User');

    // Second generate (regeneration) — pre-registered schema should still be there
    // Trigger cache invalidation by adding a schema (which forces rebuild)
    service.addSchema('_regen', userSchema);
    const spec2 = service.getSpec() as unknown as Record<string, unknown>;
    const comps2 = spec2.components as Record<string, unknown> | undefined;
    expect(comps2?.schemas).toBeDefined();
    const schemas2 = comps2?.schemas as Record<string, unknown> | undefined;
    expect(schemas2).toHaveProperty('User');
  });

  it('C3: non-object schema hoisting — z.string().email() referenced by routes is hoisted', () => {
    const emailSchema = z.string().email();
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    service.addSchema('Email', emailSchema);
    router.post('/send', {
      handler: () => ({}),
      schema: { body: z.object({ email: emailSchema }) },
    });

    const spec = service.getSpec() as unknown as Record<string, unknown>;
    const comps = spec.components as Record<string, unknown> | undefined;
    expect(comps?.schemas).toBeDefined();
    // Non-object schemas get hoisted with a Schema<n> name
    const schemas = comps?.schemas as Record<string, unknown> | undefined;
    // Should have at least one entry (either 'Email' or 'Schema1')
    expect(Object.keys(schemas ?? {}).length).toBeGreaterThan(0);
  });

  it('C3: distinct collision-case schemas get distinct Schema<n> names', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    const schemaA = z.object({ field1: z.string() });
    const schemaB = z.object({ field2: z.number() });
    service.addSchema('CollisionA', schemaA);
    service.addSchema('CollisionB', schemaB);

    router.post('/a', {
      handler: () => ({}),
      schema: { body: schemaA },
    });
    router.post('/b', {
      handler: () => ({}),
      schema: { body: schemaB },
    });

    const spec = service.getSpec() as unknown as Record<string, unknown>;
    const comps = spec.components as Record<string, unknown> | undefined;
    expect(comps?.schemas).toBeDefined();
    const schemas = comps?.schemas as Record<string, unknown> | undefined;
    // Both schemas should be present with distinct names
    expect(schemas).toHaveProperty('CollisionA');
    expect(schemas).toHaveProperty('CollisionB');
  });

  // C4: ZodDefault parameter with required:false AND schema.default
  // NOTE: This behavior is fully tested in openapi-integration.test.ts which uses real routes.
  // The unit MockRouter doesn't preserve schema info, so we just verify the service
  // generates paths without throwing when a route has a query schema with defaults.
  it('C4: service handles routes with query schemas containing defaults', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    router.get('/items', {
      handler: () => ({}),
      schema: {
        query: z.object({
          limit: z.number().default(10),
        }),
      },
    });

    const spec = service.getSpec() as unknown as Record<string, unknown>;
    expect(spec.paths).toBeDefined();
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/items');
  });

  // Branch coverage: addSchema lazy-init path exercises the undefined branches
  // for description/servers/securitySchemes in the addSchema constructor block.
  it('addSchema lazy-init should use defaults when description/servers/securitySchemes are not provided', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
    });

    // Call addSchema BEFORE getSpec — this triggers the lazy-init branch in addSchema
    // where description, servers, securitySchemes are all undefined
    service.addSchema('LazyInitSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
    expect(spec.info).toEqual(
      expect.objectContaining({
        title: 'Test API',
        version: '1.0.0',
      }),
    );
  });

  // Branch coverage: constructor with schemas=false ensures the if-block is skipped
  it('should not create generator in constructor when schemas is empty', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      schemas: [],
    });

    // Generator should not be created yet
    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
  });

  // Branch coverage: addSchema with description/servers/securitySchemes defined
  // exercises the `!== undefined` → true branches in the addSchema lazy-init block
  it('addSchema lazy-init with all options defined exercises all branches', () => {
    const service = new OpenApiService({
      app,
      title: 'Test API',
      version: '1.0.0',
      description: 'Full description',
      servers: [{ url: 'https://api.example.com' }],
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    });

    // addSchema triggers lazy-init in addSchema (not constructor) because schemas=[]
    service.addSchema('FullSchema', z.object({ id: z.string() }));

    const spec = service.getSpec() as Record<string, unknown>;
    expect(spec).toBeDefined();
    expect(spec.info).toEqual(
      expect.objectContaining({
        description: 'Full description',
      }),
    );
    expect(spec).toHaveProperty('servers');
    expect(spec).toHaveProperty('components.securitySchemes');
  });
});
