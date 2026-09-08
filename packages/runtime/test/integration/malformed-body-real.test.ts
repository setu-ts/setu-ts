/**
 * X37-1 end to end on the SERVED path: a malformed JSON request body answers
 * `400` in the configured error format, not a masked `500`.
 *
 * The read is lazy (M87) and happens inside the handler, so the parse failure
 * surfaces as a throw from the handler and is answered by `errorHandler` —
 * the ordinary throw path (§3.4). This file binds a REAL socket, because the
 * producer that mattered is `runtime`'s `IRequest.json()` on the HTTP path:
 * the negative control (§6, control 1) is that the kernel's `inject` can
 * answer `400` while every served request still answers `500` when only the
 * kernel side delegates. `inject`-based coverage lives in the kernel package.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { HandlerResult, IPluginContext, IRequestContext } from '@setu-ts/common';

const PORT = 18791;

async function boot(): Promise<ReturnType<typeof createApplication>> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      {
        name: 'echo-route',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.middleware.add(errorHandler({ format: 'rfc9457' }), {
            name: 'errors',
            priority: 10,
          });
          ctx.router.post('/echo', {
            handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
              const body = await reqCtx.request.json<Record<string, unknown>>();
              return reqCtx.response.json(body);
            },
          });
        },
      },
    ],
  });
  await app.start({ port: PORT });
  return app;
}

describe('malformed JSON body on the served path (X37-1)', () => {
  it('answers 400 Problem Details over a real socket', async () => {
    const app = await boot();
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');

      const problem = await response.json() as Record<string, unknown>;
      expect(problem.status).toBe(400);
      expect(problem.title).toBe('Bad Request');
      expect(problem.detail).toBe('The request body could not be parsed as JSON.');
      // No `message` member: the body is a Problem Details document, and the
      // underlying SyntaxError never reaches the caller (§3.7).
      expect(problem).not.toHaveProperty('message');
    } finally {
      await app.stop();
    }
  });

  it('a valid JSON body is still served — the parse itself is unchanged', async () => {
    const app = await boot();
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });
});
