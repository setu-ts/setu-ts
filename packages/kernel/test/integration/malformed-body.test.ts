/**
 * X37-1 through `inject()`: a malformed JSON body answers `400` in the
 * configured error format, and a handler that catches its own rejection
 * keeps full control (§3.4).
 *
 * The kernel's `inject` is one of THREE `IRequest.json()` producers; this
 * file pins the in-process one. The served-path half lives in
 * `runtime`'s `malformed-body-real.test.ts`, and the reason both exist is
 * the package-list correction's whole argument: fixing the kernel's parse
 * alone would leave every SERVED request answering `500` while this path
 * answered `400` — a test proving the opposite of production.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { errorHandler } from '@setu-ts/exceptions';
import { CAPABILITIES } from '@setu-ts/common';
import type { HandlerResult, IPlugin, IPluginContext, IRequestContext } from '@setu-ts/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** The kernel's `inject` needs the mandatory `runtime` capability (M42). */
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

function boot(): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [
      runtimePlugin(),
      {
        name: 'body-routes',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.middleware.add(errorHandler({ format: 'rfc9457' }), {
            name: 'errors',
            priority: 10,
          });
          // Does NOT catch: the rejection reaches errorHandler.
          ctx.router.post('/echo', {
            handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
              const body = await reqCtx.request.json<Record<string, unknown>>();
              return reqCtx.response.json(body);
            },
          });
          // Catches the rejection through the Promise contract and answers
          // what IT chooses (§3.4).
          ctx.router.post('/tolerant', {
            handler: (reqCtx: IRequestContext): Promise<HandlerResult> =>
              reqCtx.request.json<Record<string, unknown>>().then(
                (body) => reqCtx.response.json(body),
                () => reqCtx.response.status(422).json({ error: 'unreadable body' }),
              ),
          });
        },
      },
    ],
  });
  return app;
}

describe('malformed JSON body through inject() (X37-1)', () => {
  it('answers 400 in the configured format', async () => {
    const app = boot();
    await app.start();
    try {
      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/echo',
        body: '{not-json',
      });
      expect(res.statusCode).toBe(400);
      const problem = res.json() as Record<string, unknown>;
      expect(problem).toEqual({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'The request body could not be parsed as JSON.',
        instance: '/echo',
      });
    } finally {
      await app.stop();
    }
  });

  it('a handler that catches its own rejection answers whatever it chooses', async () => {
    const app = boot();
    await app.start();
    try {
      const res = await app.inject({
        method: 'POST',
        url: 'http://localhost/tolerant',
        body: '{not-json',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'unreadable body' });
    } finally {
      await app.stop();
    }
  });

  it('a valid body still parses — and an EMPTY body keeps its {} default', async () => {
    const app = boot();
    await app.start();
    try {
      const valid = await app.inject({
        method: 'POST',
        url: 'http://localhost/echo',
        body: { ok: true },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ ok: true });

      // inject() with no body has never been a malformed body: the empty
      // string parses as `{}` exactly as before this milestone.
      const empty = await app.inject({ method: 'POST', url: 'http://localhost/echo' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({});
    } finally {
      await app.stop();
    }
  });
});
