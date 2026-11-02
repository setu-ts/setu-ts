/**
 * Resource-server behaviour at the real kernel surface (M132): the RFC 9728
 * document, challenges on every 401 producer, a scope 403 end to end, and the
 * two compositions that must NOT gain a Bearer challenge.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService, MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import {
  AuthPlugin,
  AuthorizationDeniedError,
  requireAuth,
  requireScopes,
} from '../../src/index.ts';
import type { TrustedIssuer } from '../../src/index.ts';
// The decorated @Roles path is driven through the REAL plugin rather than a
// stand-in, so the 401 it produces is the one DecoratorPlugin actually writes.
import { Controller, Get, Roles } from '../../../decorator-plugin/src/index.ts';
import { DecoratorPlugin } from '../../../decorator-plugin/src/plugin/decorator-plugin.ts';

const JWT_SECRET = 'x'.repeat(40);
const SESSION_SECRET = 'resource-server-session-secret-at-least-32';
const RESOURCE = 'https://api.test/mcp';
const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
const METADATA_URL = 'https://api.test/.well-known/oauth-protected-resource/mcp';
const ISSUER: TrustedIssuer = {
  name: 'idp',
  issuer: 'https://idp.test',
  audience: 'api',
  keys: { jwksUri: 'https://idp.test/jwks' },
  toPrincipal: () => ({ id: 'outside' }),
};

@Controller('/admin')
class AdminController {
  @Get('/only')
  @Roles('admin')
  only(): { readonly secret: boolean } {
    return { secret: true };
  }
}

const resourceServer = {
  resource: RESOURCE,
  authorizationServers: ['https://as.test'],
  scopesSupported: ['tools:read'],
  resourceName: 'Tools API',
};

/** Sets a challenge the application chose, to prove it is never overwritten. */
const appChallenge: MiddlewareFunction = async (ctx, next) => {
  ctx.response.header('WWW-Authenticate', 'Custom realm="app"');
  await next();
};

function buildMainApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        jwt: { secret: JWT_SECRET },
        rbac: { roles: { admin: {} } },
        issuers: [ISSUER],
        resourceServer,
      }),
      DecoratorPlugin({ controllers: [AdminController] }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ id: ctx.request.user!.id }),
  });
  app.router.get('/scoped', {
    middleware: [requireScopes('tools:read')],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  app.router.get('/thrown', {
    handler: () => {
      throw new AuthorizationDeniedError('authentication-required', 'doc', 'edit');
    },
  });
  app.router.get('/app-challenge', {
    middleware: [appChallenge, requireAuth()],
    handler: () => ctxOk(),
  });
  app.router.get('/account', {
    middleware: [requireAuth({ signInPage: '/login' })],
    handler: () => ctxOk(),
  });
  return app;
}

/** A handler body the tests never expect on a refused route. */
function ctxOk(): never {
  throw new Error('handler must not run on a refused request');
}

describe('resource-server integration', () => {
  let app: IKernelApplication;
  let jwt: IJwtService;

  beforeAll(async () => {
    app = buildMainApp();
    await app.start();
    jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('serves the RFC 9728 document field by field without following Host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `http://localhost${METADATA_PATH}`,
      headers: { host: 'evil.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: ['https://as.test'],
      scopes_supported: ['tools:read'],
      resource_name: 'Tools API',
      bearer_methods_supported: ['header'],
    });
  });

  it('challenges an anonymous 401 on requireAuth with the metadata URL', async () => {
    const response = await app.inject({ method: 'GET', url: 'http://localhost/me' });

    expect(response.statusCode).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`,
    );
  });

  it('reports invalid_token when a Bearer credential was presented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/me',
      headers: { authorization: 'Bearer not-a-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`,
    );
  });

  it('challenges a decorated @Roles 401', async () => {
    const response = await app.inject({ method: 'GET', url: 'http://localhost/admin/only' });

    expect(response.statusCode).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`,
    );
  });

  it('challenges a thrown AuthorizationDeniedError through the error handler', async () => {
    const response = await app.inject({ method: 'GET', url: 'http://localhost/thrown' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401, detail: 'Authentication required' });
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`,
    );
  });

  it('never overwrites a challenge the application set itself', async () => {
    const response = await app.inject({ method: 'GET', url: 'http://localhost/app-challenge' });

    expect(response.statusCode).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Custom realm="app"');
  });

  it('leaves a sign-in redirect untouched', async () => {
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/account',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.get('location')).toBe('/login?returnTo=%2Faccount');
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('answers 403 insufficient_scope with only the route-required scopes', async () => {
    const token = await jwt.sign({ sub: 'u1', scope: 'tools:write' });
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/scoped',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: 'Insufficient privileges' });
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="tools:read", ` +
        `resource_metadata="${METADATA_URL}"`,
    );
  });

  it('admits a token that holds the required scope', async () => {
    const token = await jwt.sign({ sub: 'u1', scope: 'tools:read' });
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/scoped',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('resource-server compositions without a Bearer strategy', () => {
  it('adds no Bearer challenge to a cookie-only app (O7)', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SessionPlugin({ secret: SESSION_SECRET }),
        AuthPlugin({ session: { toPrincipal: () => null } }),
      ],
    });
    app.router.get('/me', {
      middleware: [requireAuth()],
      handler: () => ctxOk(),
    });
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/me' });
      expect(response.statusCode).toBe(401);
      expect(response.headers.has('www-authenticate')).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('reports invalid_token through a configured jwt header and scheme', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({ jwt: { secret: JWT_SECRET, header: 'x-access-token', scheme: 'Token' } }),
      ],
    });
    app.router.get('/me', {
      middleware: [requireAuth()],
      handler: () => ctxOk(),
    });
    await app.start();
    try {
      const invalid = await app.inject({
        method: 'GET',
        url: 'http://localhost/me',
        headers: { 'x-access-token': 'Token not-a-token' },
      });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');

      const absent = await app.inject({ method: 'GET', url: 'http://localhost/me' });
      expect(absent.headers.get('www-authenticate')).toBe('Bearer');
    } finally {
      await app.stop();
    }
  });

  it('still challenges when the global auth middleware is disabled', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        AuthPlugin({
          jwt: { secret: JWT_SECRET },
          middleware: false,
          resourceServer: { resource: RESOURCE },
        }),
      ],
    });
    app.router.get('/me', {
      middleware: [requireAuth()],
      handler: () => ctxOk(),
    });
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/me' });
      expect(response.statusCode).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${METADATA_URL}"`,
      );
    } finally {
      await app.stop();
    }
  });
});
