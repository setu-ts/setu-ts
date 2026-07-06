/**
 * E2E application test for ValidationPlugin.
 *
 * Uses createApplication() with a runtime-provider test plugin and
 * ValidationPlugin, registers routes with validateBody/validateQuery,
 * and drives passing and failing requests through the real registry/pipeline.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IPlugin,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
} from '@hono-enterprise/common';

import { createApplication, type IKernelApplication } from '@hono-enterprise/kernel';
import { validateBody, validateQuery, ValidationPlugin } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Test runtime plugin (provides CAPABILITIES.RUNTIME)
// ---------------------------------------------------------------------------

function createTestRuntimePlugin(
  opts: { env?: Record<string, string | undefined> } = {},
): IPlugin {
  const runtime: IRuntimeServices = {
    platform: () => 'deno',
    version: () => '2.0.0-test',
    hostname: () => 'test-host',
    uuid: () => `test-uuid-${Math.random().toString(36).slice(2)}`,
    randomBytes: (length: number) => new Uint8Array(length),
    get subtle(): SubtleCrypto {
      throw new Error('not available in test');
    },
    now: () => 0,
    hrtime: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    env: opts.env ?? {},
    exit: () => {
      throw new Error('fake exit');
    },
  };

  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe('ValidationPlugin E2E — with real application', () => {
  it('passing request: validateBody stores validated data and handler runs', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        ValidationPlugin({ errorFormat: 'default' }),
      ],
    });

    await app.start();

    const kernelApp = app as IKernelApplication;
    kernelApp.router.post('/users', {
      middleware: [
        validateBody({
          safeParse(data: unknown) {
            if (
              typeof data === 'object' &&
              data !== null &&
              'name' in data &&
              typeof (data as Record<string, unknown>).name === 'string'
            ) {
              return { success: true as const, data };
            }
            return {
              success: false as const,
              error: {
                issues: [{ path: ['name'], message: 'Must be a non-empty string' }],
              },
            };
          },
        }),
      ],
      handler: (ctx: IRequestContext) => {
        const body = ctx.state.get('validated:body');
        return ctx.response.json({ received: body });
      },
    });

    const resp = await kernelApp.inject({
      method: 'POST',
      url: 'http://localhost/users',
      body: { name: 'Alice' },
    });

    expect(resp.statusCode).toBe(200);
    const json = resp.json<{ received: { name: string } }>();
    expect(json.received.name).toBe('Alice');

    await app.stop();
  });

  it('failing request: validateBody short-circuits with 400 validation error', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        ValidationPlugin({ errorFormat: 'default' }),
      ],
    });

    await app.start();

    const kernelApp = app as IKernelApplication;
    let handlerRan = false;
    kernelApp.router.post('/users', {
      middleware: [
        validateBody({
          safeParse(data: unknown) {
            if (
              typeof data === 'object' &&
              data !== null &&
              'name' in data &&
              typeof (data as Record<string, unknown>).name === 'string'
            ) {
              return { success: true as const, data };
            }
            return {
              success: false as const,
              error: {
                issues: [{ path: ['name'], message: 'Must be a non-empty string' }],
              },
            };
          },
        }),
      ],
      handler: () => {
        handlerRan = true;
        // deno-lint-ignore no-explicit-any
        return { __handlerResult: true } as any;
      },
    });

    const resp = await kernelApp.inject({
      method: 'POST',
      url: 'http://localhost/users',
      body: { name: 123 },
    });

    expect(resp.statusCode).toBe(400);
    expect(handlerRan).toBe(false);
    const json = resp.json<{ message: string; errors: Array<{ field: string }> }>();
    expect(json.message).toContain('Validation failed');
    expect(json.errors[0].field).toBe('name');

    await app.stop();
  });

  it('rfc7807 format: E2E response has type/instance, no message', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        ValidationPlugin({ errorFormat: 'rfc7807' }),
      ],
    });

    await app.start();

    const kernelApp = app as IKernelApplication;
    kernelApp.router.post('/items', {
      middleware: [
        validateBody({
          safeParse() {
            return {
              success: false as const,
              error: {
                issues: [{ path: ['id'], message: 'Required' }],
              },
            };
          },
        }),
      ],
      handler: () => {
        // deno-lint-ignore no-explicit-any
        return { __handlerResult: true } as any;
      },
    });

    const resp = await kernelApp.inject({
      method: 'POST',
      url: 'http://localhost/items',
      body: {},
    });

    expect(resp.statusCode).toBe(400);
    const json = resp.json<{
      type: string;
      instance: string;
      errors: Array<{ field: string }>;
    }>();
    expect(json.type).toBe('https://hono-enterprise.dev/errors/validation');
    expect(json.instance).toBe('/items');
    const hasMessage = 'message' in json;
    expect(hasMessage).toBe(false);

    await app.stop();
  });

  it('validateQuery helper works through real pipeline', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        ValidationPlugin(),
      ],
    });

    await app.start();

    const kernelApp = app as IKernelApplication;
    kernelApp.router.get('/search', {
      middleware: [
        validateQuery({
          safeParse(data: unknown) {
            if (
              typeof data === 'object' &&
              data !== null &&
              'q' in data &&
              typeof (data as Record<string, unknown>).q === 'string'
            ) {
              return { success: true as const, data };
            }
            return {
              success: false as const,
              error: {
                issues: [{ path: ['q'], message: 'Query parameter required' }],
              },
            };
          },
        }),
      ],
      handler: (ctx: IRequestContext) => {
        const query = ctx.state.get('validated:query');
        return ctx.response.json({ query });
      },
    });

    const resp = await kernelApp.inject({
      method: 'GET',
      url: 'http://localhost/search?q=hello',
    });

    expect(resp.statusCode).toBe(200);
    const json = resp.json<{ query: Record<string, string> }>();
    expect(json.query.q).toBe('hello');

    await app.stop();
  });

  it('invalid JSON body returns 400 without throwing', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin(),
        ValidationPlugin(),
      ],
    });

    await app.start();

    const kernelApp = app as IKernelApplication;
    kernelApp.router.post('/data', {
      middleware: [validateBody({ safeParse: () => ({ success: true as const, data: {} }) })],
      handler: (ctx: IRequestContext) => ctx.response.json({ ok: true }),
    });

    // Send raw invalid JSON as body string
    const resp = await kernelApp.inject({
      method: 'POST',
      url: 'http://localhost/data',
      body: '{bad json}',
    });

    expect(resp.statusCode).toBe(400);

    await app.stop();
  });
});
