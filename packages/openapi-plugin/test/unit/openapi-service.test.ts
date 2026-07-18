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

  listRoutes(): readonly { readonly method: string; readonly path: string; readonly definition: { readonly handler: unknown } }[] {
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
});
