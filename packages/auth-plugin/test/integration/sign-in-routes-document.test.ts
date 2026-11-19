/**
 * The sign-in routes are browser redirects and a form post, so the REAL
 * `OpenApiPlugin` leaves them out of the document while the application's own
 * routes stay in it. The RFC 9728 metadata route is found from a `401`'s
 * challenge, not the document, so it is left out too.
 *
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import { BASE, buildSignInApp } from '../fixtures/sign-in-app.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe('sign-in routes in the OpenAPI document', () => {
  it('lists no /auth path and keeps the application routes', async () => {
    const harness = await buildSignInApp({
      plugins: [OpenApiPlugin({ title: 'Sign-in', version: '1.0.0' })],
    });
    app = harness.app;

    // The routes exist and still answer: the login redirects to the provider.
    const login = await app.fetch(new Request(`${BASE}/auth/idp/login`));
    expect(login.status).toBe(302);

    const response = await app.inject({ method: 'GET', url: `${BASE}/openapi.json` });
    const spec = response.json() as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths);
    expect(paths.filter((path) => path.startsWith('/auth'))).toEqual([]);
    expect(paths).toContain('/me');
  });

  it('lists no /.well-known path while the metadata route still answers and is named', async () => {
    const built = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({
          jwt: { secret: 'x'.repeat(40) },
          resourceServer: {
            resource: 'https://api.test/mcp',
            authorizationServers: ['https://as.test'],
          },
        }),
        OpenApiPlugin({ title: 'Resource', version: '1.0.0' }),
      ],
    });
    built.router.get('/me', {
      middleware: [requireAuth()],
      handler: (ctx) => ctx.response.json({ id: ctx.request.user!.id }),
    });
    await built.start();
    app = built;

    const response = await built.inject({ method: 'GET', url: `${BASE}/openapi.json` });
    const paths = Object.keys((response.json() as { paths: Record<string, unknown> }).paths);
    expect(paths.filter((path) => path.startsWith('/.well-known'))).toEqual([]);
    expect(paths).toContain('/me');

    const metadata = await built.inject({
      method: 'GET',
      url: `${BASE}/.well-known/oauth-protected-resource/mcp`,
    });
    expect(metadata.statusCode).toBe(200);
    expect((metadata.json() as { resource: string }).resource).toBe('https://api.test/mcp');
    const refused = await built.inject({ method: 'GET', url: `${BASE}/me` });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
