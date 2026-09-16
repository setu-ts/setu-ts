/**
 * The X47-2 guard: `csrfTokenField(ctx)` must render the field name the
 * plugin's configured `csrf.fieldName` actually verifies, driven through a
 * REAL kernel application over BOTH entry points under a non-default
 * configuration — the repo's own one-capability-one-implementation rule, whose
 * prescribed guard is exactly this file.
 *
 * Before M95c the helper resolved the name from its own (empty) options while
 * the verifier read the plugin's resolved config, so the README's own recipe —
 * render with the helper bare, post the form — 403'd on EVERY post. The
 * default-config block at the bottom keeps the check honest: there both names
 * behave as they do today, so the custom-name assertions above discriminate
 * rather than passing on the default.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { CSRF_CONFIG_STATE_KEY, csrfTokenField, SessionPlugin } from '../../src/index.ts';

const SECRET = 'csrf-field-name-integration-at-least-32-chars';

/**
 * The README's recipe: a safe GET that renders the helper's field, and the
 * POST the rendered form submits.
 */
async function buildApp(csrf: { fieldName?: string } = {}) {
  const app = createApplication({
    plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, csrf })],
  });

  app.router.get('/form', (ctx) => {
    return ctx.response.html(
      `<form method="post" action="/submit">${csrfTokenField(ctx)}<button>Go</button></form>`,
    );
  });

  app.router.post('/submit', (ctx) => {
    return ctx.response.json({ ok: true });
  });

  // Plugins register during start(); without it the registry is empty. No
  // port → no socket binds.
  await app.start();

  return app;
}

/** The `name=value` part of the first `Set-Cookie`, ready to send back. */
function cookieOf(headers: Headers): string {
  const raw = headers.get('set-cookie');
  expect(raw).not.toBe(null);
  return (raw as string).split(';')[0];
}

describe('csrfTokenField honours the plugin’s configured csrf.fieldName', () => {
  it('renders and verifies the configured name; the default name is refused', async () => {
    const app = await buildApp({ fieldName: 'xsrf' });

    const form = await app.inject({ method: 'GET', url: '/form' });
    expect(form.statusCode).toBe(200);
    // The rendered field carries the CONFIGURED name — this is the sentence
    // that failed before the fix (`name="_csrf"` while the verifier read
    // `xsrf`).
    expect(form.body).not.toBe(null);
    expect(form.body).toContain('name="xsrf"');
    const token = /name="xsrf" value="([^"]+)"/.exec(form.body as string)?.[1];
    expect(typeof token).toBe('string');

    const cookie = cookieOf(form.headers);

    // A POST under the rendered name verifies — the README's recipe works.
    const good = await app.inject({
      method: 'POST',
      url: '/submit',
      headers: { cookie },
      body: new URLSearchParams({ xsrf: token as string }),
    });
    expect(good.statusCode).toBe(200);
    expect(good.json<{ ok: boolean }>().ok).toBe(true);

    // The same token under the DEFAULT name is a mismatch — 403, and the
    // short-circuit means the handler never runs.
    const evil = await app.inject({
      method: 'POST',
      url: '/submit',
      headers: { cookie },
      body: new URLSearchParams({ _csrf: token as string }),
    });
    expect(evil.statusCode).toBe(403);
  });

  it('keeps the default configuration byte-for-byte: _csrf renders and verifies', async () => {
    const app = await buildApp();

    const form = await app.inject({ method: 'GET', url: '/form' });
    expect(form.statusCode).toBe(200);
    expect(form.body).not.toBe(null);
    expect(form.body).toContain('name="_csrf"');
    const token = /name="_csrf" value="([^"]+)"/.exec(form.body as string)?.[1];
    expect(typeof token).toBe('string');

    const cookie = cookieOf(form.headers);

    const good = await app.inject({
      method: 'POST',
      url: '/submit',
      headers: { cookie },
      body: new URLSearchParams({ _csrf: token as string }),
    });
    expect(good.statusCode).toBe(200);

    const evil = await app.inject({
      method: 'POST',
      url: '/submit',
      headers: { cookie },
      body: new URLSearchParams({ xsrf: token as string }),
    });
    expect(evil.statusCode).toBe(403);
  });
});

describe('the published CSRF config cannot poison the verifier', () => {
  it('a handler mutating it leaves every LATER request verified', async () => {
    // The middleware resolves its config ONCE at registration and every request
    // shares it. Publishing that object put the verifier's own configuration in
    // reach of any handler holding the context: before this was a per-request
    // copy, one `GET /poison` turned the 403 below into a 200 for the rest of
    // the process — measured, with a fresh `ctx.state` map on each request.
    const app = createApplication({
      plugins: [RuntimePlugin(), SessionPlugin({ secret: SECRET, csrf: {} })],
    });

    app.router.get('/poison', (ctx) => {
      const published = ctx.state.get(CSRF_CONFIG_STATE_KEY) as {
        ignoreMethods?: Set<string>;
        fieldName: string;
      };
      // Only `fieldName` is published, so the set the verifier reads is not
      // reachable from here at all — this is the assertion that keeps it so.
      expect(published.ignoreMethods).toBeUndefined();
      expect(Object.isFrozen(published)).toBe(true);
      // And the object that IS published refuses a write rather than silently
      // detaching from what the verifier checks (ESM is strict mode).
      expect(() => {
        (published as { fieldName: string }).fieldName = 'hijacked';
      }).toThrow();
      return ctx.response.json({ fieldName: published.fieldName });
    });

    app.router.post('/submit', (ctx) => ctx.response.json({ ok: true }));
    await app.start();

    const before = await app.inject({
      method: 'POST',
      url: '/submit',
      body: new URLSearchParams({}),
    });
    expect(before.statusCode).toBe(403);

    const poison = await app.inject({ method: 'GET', url: '/poison' });
    expect(poison.statusCode).toBe(200);
    expect(poison.json<{ fieldName: string }>().fieldName).toBe('_csrf');

    // A later, unrelated request with its own state map.
    const after = await app.inject({
      method: 'POST',
      url: '/submit',
      body: new URLSearchParams({}),
    });
    expect(after.statusCode).toBe(403);
  });
});
