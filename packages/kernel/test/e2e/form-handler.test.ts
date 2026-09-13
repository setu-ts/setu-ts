/**
 * M94b e2e: a real handler in a running kernel application reads an
 * UNKNOWN-SHAPED urlencoded form through `FormBody.entries()` and echoes it.
 *
 * This is the application path §4 names for that member: a handler cannot
 * know a form's field names ahead of time, and the hand-rolled
 * `new URLSearchParams(await text())` iteration this accessor retires is
 * precisely the enumeration it replaces. It is pinned by a real handler in a
 * running application, not by a unit test of its own — the distinction the
 * dead-surface rule turns on.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  FormBody,
  HandlerResult,
  IPlugin,
  IPluginContext,
  IRequest,
  IRequestContext,
} from '@setu-ts/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** Reads the form off a request (the served/injected accessor is always present). */
function readForm(request: IRequest): Promise<FormBody> {
  const read = request.formData;
  if (read === undefined) {
    return Promise.reject(new Error('the request must provide formData()'));
  }
  return read.call(request);
}

function boot(): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [
      runtimePlugin(),
      {
        name: 'form-routes',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.router.post('/register', {
            handler: async (c: IRequestContext): Promise<HandlerResult> => {
              const form = await readForm(c.request);
              const pairs = Array.from(form.entries()).map(([name, value]) => [
                name,
                typeof value === 'string' ? value : '<file>',
              ]);
              return c.response.json({ count: pairs.length, pairs });
            },
          });
        },
      },
    ],
  });
  return app;
}

describe('a handler reads an unknown-shaped form through entries() (M94b)', () => {
  it('echoes every pair in wire order, without knowing the field names', async () => {
    const app = boot();
    await app.start();
    try {
      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // No schema, no known fields — the handler enumerates whatever came.
        body: 'b=2&a=1&c=3&a=4',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        count: 4,
        pairs: [['b', '2'], ['a', '1'], ['c', '3'], ['a', '4']],
      });
    } finally {
      await app.stop();
    }
  });

  it('an empty form enumerates as zero pairs, not an error', async () => {
    const app = boot();
    await app.start();
    try {
      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 0, pairs: [] });
    } finally {
      await app.stop();
    }
  });
});
