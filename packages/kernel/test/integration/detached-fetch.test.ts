/**
 * `app.fetch` works when detached from the application.
 *
 * The Workers entry the framework documents is `export default { fetch:
 * app.fetch }`, and Cloudflare calls it as `exported.fetch(request, env, ctx)`.
 * Measured on workerd before the fix: every request answered 500 with
 * "Cannot read private member #registry from an object whose class did not
 * declare it", because `this` was the exported object rather than the app.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

async function started() {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/', (ctx) => ctx.response.json({ ok: true }));
  await app.start();
  return app;
}

describe('a detached app.fetch', () => {
  it('serves through a Workers-style exported object', async () => {
    const app = await started();
    try {
      // Called with `this` bound to the exported object, as Cloudflare does.
      const exported = { fetch: app.fetch };
      const response = await exported.fetch(new Request('http://localhost/'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });

  it('serves when called as a bare function', async () => {
    const app = await started();
    try {
      const { fetch } = app;
      const response = await fetch(new Request('http://localhost/'));
      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      await app.stop();
    }
  });
});
