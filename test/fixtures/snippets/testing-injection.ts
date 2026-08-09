// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Testing injection from docs/getting-started.md - must compile against the workspace.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('My Application', () => {
  it('handles GET /hello', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/hello', async (ctx) => {
      return ctx.response.json({ message: 'Hello, World!' });
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/hello',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ message: 'Hello, World!' });
  });
});
