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

import { csrfTokenField, SessionPlugin } from '../../src/index.ts';

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
