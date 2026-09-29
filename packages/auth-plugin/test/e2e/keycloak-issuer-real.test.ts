/**
 * Outside-issuer verification against a REAL Keycloak realm.
 *
 * Guarded on `KEYCLOAK_URL` (for example `http://localhost:8180`); the realm is
 * imported from `test/fixtures/keycloak/setu-realm.json`. Uses the default
 * fetch seam, OIDC discovery, and the realm's real key set — which carries an
 * RSA encryption key beside the signing key.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireAuth } from '../../src/index.ts';
import { encodeBase64Url } from '../../src/utils/base64url.ts';

const BASE = Deno.env.get('KEYCLOAK_URL');
const REALM = `${BASE}/realms/setu`;

async function clientToken(clientId: string, secret: string): Promise<string> {
  const response = await fetch(`${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    }),
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function adminToken(): Promise<string> {
  const response = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: 'admin',
    }),
  });
  if (!response.ok) throw new Error(`admin token failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function kidOf(token: string): string {
  const header = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  return header.kid;
}

async function buildApp(): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        issuers: [{
          name: 'keycloak',
          issuer: REALM,
          audience: 'setu-api',
          keys: { discovery: true },
          keySet: { minRefreshIntervalMs: 1 },
          toPrincipal: (claims) => ({ id: String(claims.azp) }),
        }],
      }),
    ],
  });
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json(ctx.request.user),
  });
  await app.start();
  return app;
}

async function me(app: IKernelApplication, token: string) {
  return await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('Keycloak issuer (real)', { ignore: BASE === undefined }, () => {
  it('authenticates a client-credentials token for the configured audience', async () => {
    const app = await buildApp();
    try {
      const response = await me(
        app,
        await clientToken('setu-api-client', 'setu-api-client-secret'),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 'setu-api-client' });
    } finally {
      await app.stop();
    }
  });

  it("refuses a token minted for another client's audience", async () => {
    const app = await buildApp();
    try {
      const response = await me(app, await clientToken('other-client', 'other-client-secret'));
      expect(response.statusCode).toBe(401);
    } finally {
      await app.stop();
    }
  });

  it('refuses a real token re-signed with HS256 using the realm public key', async () => {
    const app = await buildApp();
    try {
      const real = await clientToken('setu-api-client', 'setu-api-client-secret');
      const jwks = await (await fetch(`${REALM}/protocol/openid-connect/certs`)).json() as {
        keys: Array<Record<string, unknown>>;
      };
      const signing = jwks.keys.find((key) => key.kid === kidOf(real))!;
      const hmac = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(String(signing.n)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const header = encodeBase64Url(
        new TextEncoder().encode(JSON.stringify({ alg: 'HS256', kid: signing.kid })),
      );
      const payload = real.split('.')[1];
      const signature = await crypto.subtle.sign(
        'HMAC',
        hmac,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      const forged = `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
      expect((await me(app, forged)).statusCode).toBe(401);
    } finally {
      await app.stop();
    }
  });

  it('picks up a key rotated in through the admin API', async () => {
    const app = await buildApp();
    const admin = await adminToken();
    const headers = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    let componentUrl: string | null = null;
    try {
      const before = await clientToken('setu-api-client', 'setu-api-client-secret');
      expect((await me(app, before)).statusCode).toBe(200);

      const realm = await (await fetch(`${BASE}/admin/realms/setu`, { headers })).json() as {
        id: string;
      };
      const created = await fetch(`${BASE}/admin/realms/setu/components`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `rotated-${crypto.randomUUID()}`,
          providerId: 'rsa-generated',
          providerType: 'org.keycloak.keys.KeyProvider',
          parentId: realm.id,
          config: { priority: ['1000'], enabled: ['true'], active: ['true'] },
        }),
      });
      expect(created.status).toBe(201);
      componentUrl = created.headers.get('location');
      await created.body?.cancel();

      const after = await clientToken('setu-api-client', 'setu-api-client-secret');
      expect(kidOf(after)).not.toBe(kidOf(before));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await me(app, after)).statusCode).toBe(200);
    } finally {
      if (componentUrl !== null) {
        await (await fetch(componentUrl, { method: 'DELETE', headers })).body?.cancel();
      }
      await app.stop();
    }
  });
});
