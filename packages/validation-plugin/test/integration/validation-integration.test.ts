/**
 * Integration tests for ValidationPlugin.
 *
 * Covers the full plugin → service → middleware lifecycle with a fake
 * plugin context and request context.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPluginContext, IRuntimeServices, IValidationService } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

import { ValidationPlugin } from '../../src/plugin/validation-plugin.ts';
import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter, nestjsFormatter } from '../../src/formatters/default-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakePluginContext(): {
  ctx: IPluginContext;
  registeredServices: Map<string, unknown>;
} {
  const registeredServices = new Map<string, unknown>();

  const ctx: IPluginContext = {
    runtime: {} as IRuntimeServices,
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

describe('ValidationPlugin — full lifecycle', () => {
  it('registers and resolves IValidationService', () => {
    const plugin = ValidationPlugin();
    const { ctx, registeredServices } = createFakePluginContext();

    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION);
    expect(service).toBeInstanceOf(ValidationService);
  });

  it('service middleware validates request data end-to-end', () => {
    const plugin = ValidationPlugin();
    const { ctx, registeredServices } = createFakePluginContext();
    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    const schema = {
      safeParse(data: unknown) {
        if (typeof data === 'object' && data !== null && 'name' in data) {
          return { success: true as const, data };
        }
        return {
          success: false as const,
          error: { issues: [{ path: ['name'], message: 'Required' }] },
        };
      },
    };

    const result = service.validate(schema, { name: 'Alice' });
    expect(result.success).toBe(true);

    const failResult = service.validate(schema, {});
    expect(failResult.success).toBe(false);
  });
});

describe('ValidationPlugin — error format flows through middleware', () => {
  it('nestjs format produces statusCode in middleware response', async () => {
    const plugin = ValidationPlugin({ errorFormat: 'nestjs' });
    const { ctx, registeredServices } = createFakePluginContext();
    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    const schema = {
      safeParse() {
        return {
          success: false as const,
          error: { issues: [{ path: ['email'], message: 'Invalid' }] },
        };
      },
    };

    const { ctx: reqCtx, responseSnapshot } = createFakeContext({
      request: { body: { email: 'bad' } },
    });
    const middleware = service.middleware(schema, 'body');

    await middleware(reqCtx, async () => {});

    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
    const body = JSON.parse(snap.body!);
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
  });

  it('rfc7807 format produces type/instance in middleware response', async () => {
    const plugin = ValidationPlugin({ errorFormat: 'rfc7807' });
    const { ctx, registeredServices } = createFakePluginContext();
    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    const schema = {
      safeParse() {
        return {
          success: false as const,
          error: { issues: [{ path: ['email'], message: 'Invalid' }] },
        };
      },
    };

    const { ctx: reqCtx, responseSnapshot } = createFakeContext({
      request: { body: { email: 'bad' }, path: '/api/v1/users' },
    });
    const middleware = service.middleware(schema, 'body');

    await middleware(reqCtx, async () => {});

    const snap = responseSnapshot();
    expect(snap.status).toBe(400);
    // RFC 7807 §3 requires this media type for a Problem Details body.
    expect(snap.headers.get('content-type')).toBe('application/problem+json');
    const body = JSON.parse(snap.body!);
    expect(body.type).toBe('https://hono-enterprise.dev/errors/validation');
    expect(body.instance).toBe('/api/v1/users');
    expect('message' in body).toBe(false);
  });

  it('default format produces message in middleware response', async () => {
    const plugin = ValidationPlugin();
    const { ctx, registeredServices } = createFakePluginContext();
    plugin.register!(ctx);

    const service = registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    const schema = {
      safeParse() {
        return {
          success: false as const,
          error: { issues: [{ path: ['x'], message: 'fail' }] },
        };
      },
    };

    const { ctx: reqCtx, responseSnapshot } = createFakeContext({
      request: { body: {} },
    });
    const middleware = service.middleware(schema, 'body');

    await middleware(reqCtx, async () => {});

    const snap = responseSnapshot();
    const body = JSON.parse(snap.body!);
    expect(body.message).toBe('Validation failed with 1 issue(s).');
  });
});

describe('resolveFormatter — all formatters produce valid output', () => {
  const issues = [{ path: 'email', message: 'Invalid', code: 'invalid_type' }];

  it('defaultFormatter output is valid JSON-serializable', () => {
    const result = defaultFormatter(issues);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('nestjsFormatter output is valid JSON-serializable', () => {
    const result = nestjsFormatter(issues);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('rfc7807Formatter output is valid JSON-serializable', () => {
    const ctx2 = createFakeContext({ request: { path: '/test' } }).ctx;
    const result = rfc7807Formatter(issues, ctx2);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  // Retro review (Part 3): `whitelist` / `forbidNonWhitelisted` were stored and
  // read by nothing — their own JSDoc admitted they could not be enforced. They
  // now call the schema's `.strip()` / `.strict()` once at registration time.
  describe('unknown-property policy', () => {
    /** Records which unknown-key configuration the plugin asked for. */
    function policySchema() {
      const calls: string[] = [];
      const base = {
        calls,
        safeParse() {
          return { success: true as const, data: {} };
        },
        strip() {
          calls.push('strip');
          return base;
        },
        strict() {
          calls.push('strict');
          return base;
        },
      };
      return base;
    }

    function serviceWith(options?: Parameters<typeof ValidationPlugin>[0]) {
      const plugin = ValidationPlugin(options);
      const { ctx, registeredServices } = createFakePluginContext();
      plugin.register!(ctx);
      return registeredServices.get(CAPABILITIES.VALIDATION) as IValidationService;
    }

    it('applies strip() when whitelist is set', () => {
      const schema = policySchema();
      serviceWith({ whitelist: true }).middleware(schema, 'body');
      expect(schema.calls).toEqual(['strip']);
    });

    it('applies strict() when forbidNonWhitelisted is set', () => {
      const schema = policySchema();
      serviceWith({ forbidNonWhitelisted: true }).middleware(schema, 'body');
      expect(schema.calls).toEqual(['strict']);
    });

    it('prefers strict() over strip() when both are set', () => {
      const schema = policySchema();
      serviceWith({ whitelist: true, forbidNonWhitelisted: true })
        .middleware(schema, 'body');
      expect(schema.calls).toEqual(['strict']);
    });

    it('leaves the schema untouched when neither option is set', () => {
      const schema = policySchema();
      serviceWith().middleware(schema, 'body');
      expect(schema.calls).toEqual([]);
    });

    it('uses a schema that cannot be configured unchanged', async () => {
      // A non-Zod schema exposes only safeParse; the policy is best-effort.
      const plain = {
        safeParse() {
          return { success: true as const, data: { ok: true } };
        },
      };
      const middleware = serviceWith({ forbidNonWhitelisted: true }).middleware(plain, 'body');
      const { ctx: reqCtx } = createFakeContext({ request: { body: { ok: true } } });
      let ran = false;
      await middleware(reqCtx, () => {
        ran = true;
        return Promise.resolve();
      });
      expect(ran).toBe(true);
    });
  });
});
