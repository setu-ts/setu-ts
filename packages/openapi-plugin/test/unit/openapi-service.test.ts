/**
 * Tests for OpenApiService.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IApplication, IRouterApi } from '@hono-enterprise/common';
import { OpenApiService } from '../../src/services/openapi-service.ts';
import { Router } from '@hono-enterprise/kernel';

describe('OpenApiService', () => {
  let app: IApplication;
  let router: IRouterApi;

  beforeEach(() => {
    router = new Router();
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
});
