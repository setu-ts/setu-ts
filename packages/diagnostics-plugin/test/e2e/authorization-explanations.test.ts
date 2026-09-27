/**
 * End-to-end canary for authorization decision explanations (M98h): a REAL
 * Deno socket, the REAL kernel application, the REAL AuthPlugin (RBAC + the
 * `authorizationDiagnostics` option) driving the real collector, the REAL
 * runtime-owned diagnostics listener, and the SIGNED native client.
 *
 * The test plants canaries in the JWT claims, the principal, the request
 * path and an error message that a naive observer might capture. It asserts
 * every canary is ABSENT from the authorization batch the signed client
 * receives — while the useful, approved aliases, the positive reasons and the
 * boolean result remain present, so suppressing every record cannot make it
 * pass. It also proves a CUSTOM replacement of the authorization provider
 * latches the source to `unsupported` (custom-provider), and that a
 * JWT-only application (no RBAC) that opted into observation answers
 * `unsupported` (rbac-not-configured).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthorizationService, IJwtService, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { authMiddleware, AuthPlugin, requireAnyRole, requireRole } from '@setu-ts/auth-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import type { IDiagnosticsClient } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const SUB_CANARY = 'user-CANARY-sub-0001';
const CLAIM_CANARY = 'claim-CANARY-0002';
const PATH_CANARY = '/secret-path-CANARY-0003';

function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

interface App {
  app: Awaited<ReturnType<typeof createApplication>>;
  client: IDiagnosticsClient;
  jwt: IJwtService;
  httpPort: number;
}

async function startAuthorizationApplication(): Promise<App> {
  const httpPort = freePort();
  const connectorPort = freePort();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      AuthPlugin({
        jwt: { secret: 'e2e-authorization-secret' },
        rbac: {
          roles: {
            admin: { permissions: ['*'], inherits: ['user'] },
            user: { permissions: ['users:read'] },
          },
        },
        authorizationDiagnostics: {
          enabled: true,
          roles: { admin: 'A', user: 'U' },
          permissions: { 'users:read': 'P' },
          policyRevision: 'rev-1',
        },
      }),
      {
        name: 'guarded-routes',
        version: '1.0.0',
        dependencies: ['auth-plugin'],
        register(ctx) {
          ctx.middleware.add(authMiddleware(), { name: 'auth', priority: 100 });
          const ok = (reqCtx: IRequestContext) => reqCtx.response.json({ ok: true });
          ctx.router.get('/admin', { middleware: [requireRole('admin')], handler: ok });
          ctx.router.get('/any-role', {
            middleware: [requireAnyRole(['admin', 'user'])],
            handler: ok,
          });
        },
      },
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  const client = createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${connectorPort}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle: crypto.subtle,
    fetch,
    timing: { setTimeout, clearTimeout },
  });
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  return { app, client, jwt, httpPort };
}

describe('Authorization decision explanations (M98h) — end to end', () => {
  it('observes positive reasons for real guarded requests, with every canary absent', async () => {
    const { app, client, jwt, httpPort } = await startAuthorizationApplication();
    try {
      // A principal that HOLDS the admin role, with canaries planted in the
      // claims and the subject.
      const adminToken = await jwt.sign({
        sub: SUB_CANARY,
        roles: ['admin'],
        permissions: ['users:read'],
        [CLAIM_CANARY]: 'planted',
      });
      // A principal that holds only `user`.
      const userToken = await jwt.sign({
        sub: 'plain-user',
        roles: ['user'],
        permissions: ['users:read'],
      });

      // Admin passes the role guard: a positive `direct-role` decision.
      const adminResp = await fetch(`http://127.0.0.1:${httpPort}/admin`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminResp.status).toBe(200);
      // The user principal is refused by the role guard: a `not-held` decision.
      const deniedResp = await fetch(`http://127.0.0.1:${httpPort}/admin`, {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(deniedResp.status).toBe(403);
      // A compound any-role guard: the user principal satisfies it.
      const anyRoleResp = await fetch(`http://127.0.0.1:${httpPort}/any-role`, {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(anyRoleResp.status).toBe(200);

      const batch = await client.authorization(0);
      expect(batch.state).toBe('ready');
      expect(batch.instanceId).not.toBe('');
      expect(batch.decisions.length).toBeGreaterThanOrEqual(3);

      // Positive reasons are present: the approved aliases and the reasons the
      // evaluator actually used.
      const reasons = batch.decisions.map((decision) => decision.reason);
      expect(reasons).toContain('direct-role');
      expect(reasons).toContain('not-held');
      const someSteps = batch.decisions.flatMap((decision) => decision.steps);
      const someAliases = someSteps.map((step) => step.ruleAlias);
      expect(someAliases).toContain('A');
      // The policy revision the option named is carried on the decisions.
      expect(batch.decisions.some((decision) => decision.policyRevision === 'rev-1')).toBe(true);

      // Canary absence at the CLIENT DTO layer: the subject, the planted claim
      // and the secret path never enter an authorization observation.
      const serialized = JSON.stringify(batch);
      expect(serialized.includes('CANARY')).toBe(false);
      expect(serialized.includes(SUB_CANARY)).toBe(false);
      expect(serialized.includes(CLAIM_CANARY)).toBe(false);
      expect(serialized.includes(PATH_CANARY)).toBe(false);
      expect(serialized.includes('Bearer')).toBe(false);
    } finally {
      client.close();
      await app.stop();
    }
  });

  it('a JWT-only application (no RBAC) that opted in answers unsupported with rbac-not-configured', async () => {
    const httpPort = freePort();
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        AuthPlugin({
          jwt: { secret: 'jwt-only-e2e-secret' },
          authorizationDiagnostics: { enabled: true, roles: {}, permissions: {} },
        }),
      ],
      diagnostics: {},
    });
    await app.start({ port: httpPort, hostname: '127.0.0.1' });
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${connectorPort}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    try {
      const batch = await client.authorization(0);
      expect(batch.state).toBe('unsupported');
      expect(batch.coverage).toBe('rbac-not-configured');
      expect(batch.decisions).toHaveLength(0);
      expect(batch.next).toBe(0);
    } finally {
      client.close();
      await app.stop();
    }
  });

  it('a custom authorization provider latches the source to unsupported (custom-provider)', async () => {
    const httpPort = freePort();
    const connectorPort = freePort();
    // A replacement authorization service that grants everything: the guards
    // serve through it, but the first-party collector can no longer explain
    // its decisions and must latch unsupported rather than guess.
    const customAuthorization: IAuthorizationService = {
      hasRole: () => true,
      hasPermission: () => true,
      hasAnyRole: () => true,
      hasAllPermissions: () => true,
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        AuthPlugin({
          jwt: { secret: 'replacement-e2e-secret' },
          rbac: {
            roles: { admin: { permissions: ['users:read'] } },
          },
          authorizationDiagnostics: {
            enabled: true,
            roles: { admin: 'A' },
            permissions: { 'users:read': 'P' },
          },
        }),
        {
          name: 'custom-authorization-replacement',
          version: '1.0.0',
          dependencies: ['auth-plugin'],
          register(ctx) {
            // Overrides the first-party RbacService during startup, before the
            // registry seals: the guards now resolve the custom provider.
            ctx.services.register(
              CAPABILITIES.AUTHORIZATION,
              customAuthorization,
              { override: true },
            );
            ctx.middleware.add(authMiddleware(), { name: 'auth', priority: 100 });
            ctx.router.get('/admin', {
              middleware: [requireRole('admin')],
              handler: (reqCtx: IRequestContext) => reqCtx.response.json({ ok: true }),
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start({ port: httpPort, hostname: '127.0.0.1' });
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${connectorPort}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    try {
      // The guard enforces through the CUSTOM provider: it allows, so the
      // route serves even though the first-party RBAC would need a JWT role.
      const token = await jwt.sign({ sub: 'anonymous' });
      const response = await fetch(`http://127.0.0.1:${httpPort}/admin`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      // The source re-verifies its provider at read time, sees the
      // replacement, and latches: a custom provider's decisions are never
      // explained from booleans.
      const batch = await client.authorization(0);
      expect(batch.state).toBe('unsupported');
      expect(batch.coverage).toBe('custom-provider');
      expect(batch.decisions).toHaveLength(0);
      expect(JSON.stringify(batch).includes('CANARY')).toBe(false);
    } finally {
      client.close();
      await app.stop();
    }
  });
});
