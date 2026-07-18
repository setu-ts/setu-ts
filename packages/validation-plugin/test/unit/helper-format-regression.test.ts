/**
 * Regression test: helper honors configured errorFormat.
 *
 * When ValidationPlugin is registered with errorFormat: 'rfc7807', the
 * validateBody helper must produce rfc7807-shaped responses (type/instance),
 * NOT the default shape.
 *
 * This proves the helper delegates to the service's middleware (which uses
 * the formatter resolved at plugin registration time) rather than a fallback.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, IValidationService } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { ValidationPlugin } from '../../src/plugin/validation-plugin.ts';
import { validateBody } from '../../src/middleware/validation-middleware.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a failing schema that always fails validation. */
function createFailingSchema() {
  return {
    safeParse(_data: unknown) {
      return {
        success: false as const,
        error: { issues: [{ path: ['email'], message: 'Invalid email', code: 'invalid_type' }] },
      };
    },
  };
}

/** Create a minimal plugin context and register the plugin. */
function registerPlugin(options?: Parameters<typeof ValidationPlugin>[0]): IValidationService {
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

  const plugin = ValidationPlugin(options);
  plugin.register!(ctx);
  return registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('helper-format-regression — validateBody honors plugin errorFormat', () => {
  it('validateBody produces rfc7807 response when plugin registered with rfc7807', async () => {
    // Register plugin with rfc7807 format
    const service = registerPlugin({ errorFormat: 'rfc7807' });

    // Create context with the registered service
    const servicesMap = new Map([[CAPABILITIES.VALIDATION, service]]);
    const { ctx, responseSnapshot } = createFakeContext({
      services: servicesMap,
      request: { body: { email: 'bad' }, path: '/api/users' },
    });

    const schema = createFailingSchema();
    const mw = validateBody(schema);

    await mw(ctx, async () => {});

    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
    const body = JSON.parse(snap.body!);

    // RFC 7807 shape: has type, title, status, detail, instance — NO message
    expect(body.type).toBe('https://hono-enterprise.dev/errors/validation');
    expect(body.title).toBe('Validation Error');
    expect(body.status).toBe(400);
    expect(typeof body.detail).toBe('string');
    expect(body.instance).toBe('/api/users');
    expect('message' in body).toBe(false);
  });

  it('validateBody produces default response when plugin registered with default format', async () => {
    const service = registerPlugin({ errorFormat: 'default' });

    const servicesMap = new Map([[CAPABILITIES.VALIDATION, service]]);
    const { ctx, responseSnapshot } = createFakeContext({
      services: servicesMap,
      request: { body: { email: 'bad' } },
    });

    const schema = createFailingSchema();
    const mw = validateBody(schema);

    await mw(ctx, async () => {});

    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
    const body = JSON.parse(snap.body!);

    // Default shape: has message
    expect(body.message).toBe('Validation failed with 1 issue(s).');
    expect('type' in body).toBe(false);
    expect('instance' in body).toBe(false);
  });
});
