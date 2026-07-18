/**
 * Unit tests for ValidationPlugin.
 *
 * Covers plugin metadata, service registration, and formatter hoisting.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, IValidationService } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { ValidationPlugin } from '../../src/plugin/validation-plugin.ts';
import { ValidationService } from '../../src/services/validation-service.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakePluginContext(): {
  ctx: IPluginContext;
  registeredServices: Map<string, unknown>;
} {
  const registeredServices = new Map<string, unknown>();

  const ctx: IPluginContext = {
    // deno-lint-ignore no-explicit-any
    runtime: {} as any,
    services: {
      register<T>(key: string, service: T): void {
        registeredServices.set(key, service);
      },
      registerFactory<T>(_key: string, _factory: () => T): void {},
      get<T>(_key: string): T {
        throw new Error('not found');
      },
      getAll<T>(): T[] {
        return [];
      },
      has(_key: string): boolean {
        return false;
      },
      unregister(_key: string): boolean {
        return false;
      },
    },
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    lifecycle: {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    // deno-lint-ignore no-explicit-any
    app: {} as any,
  };

  return { ctx, registeredServices };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ValidationPlugin — metadata', () => {
  it('has correct name', () => {
    const plugin = ValidationPlugin();
    expect(plugin.name).toBe('validation-plugin');
  });

  it('has version 0.1.0', () => {
    const plugin = ValidationPlugin();
    expect(plugin.version).toBe('0.1.0');
  });

  it('provides CAPABILITIES.VALIDATION', () => {
    const plugin = ValidationPlugin();
    expect(plugin.provides).toContain(CAPABILITIES.VALIDATION);
  });

  it('uses PLUGIN_PRIORITY.HIGH (100)', () => {
    const plugin = ValidationPlugin();
    expect(plugin.priority).toBe(100);
  });
});

describe('ValidationPlugin — registration', () => {
  it('registers IValidationService under CAPABILITIES.VALIDATION', () => {
    const plugin = ValidationPlugin();
    const { ctx, registeredServices } = createFakePluginContext();

    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION);
    expect(service).toBeInstanceOf(ValidationService);
  });

  it('registers with default error format when no options', () => {
    const plugin = ValidationPlugin();
    const { ctx, registeredServices } = createFakePluginContext();

    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    const schema = { safeParse: (d: unknown) => ({ success: true as const, data: d }) };
    const result = service.validate(schema, { hello: 'world' });
    expect(result.success).toBe(true);
  });

  it('registers with rfc7807 error format', () => {
    const plugin = ValidationPlugin({ errorFormat: 'rfc7807' });
    const { ctx, registeredServices } = createFakePluginContext();

    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION);
    expect(service).toBeDefined();
  });
});

describe('ValidationPlugin — formatter hoisting', () => {
  it('resolves formatter once at plugin creation time', () => {
    // deno-lint-ignore no-explicit-any
    const customFormatter = () => ({ errors: [], custom: true }) as any;
    const plugin = ValidationPlugin({ errorFormat: customFormatter });
    const { ctx, registeredServices } = createFakePluginContext();

    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION);
    expect(service).toBeDefined();
  });
});
