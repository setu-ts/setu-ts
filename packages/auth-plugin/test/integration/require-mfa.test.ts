/**
 * Integration — requireMfa() guard: 401 anonymous, 403 second-factor-required
 * without the factor, 200 with it; a self-issued JWT with amr: ['otp'] → 200
 * (pinned); Problem Details shape asserted field by field.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { AuthPlugin, requireMfa } from '../../src/index.ts';

const BASE = 'http://localhost';
const JWT_SECRET = 'require-mfa-test-secret-at-least-32-characters!';

interface MfaGuardHarness {
  readonly app: IKernelApplication;
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
}

async function buildMfaGuardApp(): Promise<MfaGuardHarness> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        jwt: { secret: JWT_SECRET },
      }),
    ],
  });

  // A route guarded by requireMfa().
  app.router.get('/mfa-protected', {
    middleware: [requireMfa()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });

  await app.start();

  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);

  return {
    app,
    sign: async (claims: Record<string, unknown>) => {
      const now = Math.floor(Date.now() / 1000);
      return await jwt.sign({
        sub: 'user1',
        exp: now + 300,
        ...claims,
      });
    },
  };
}

describe('requireMfa() guard', () => {
  let harness: MfaGuardHarness;

  afterEach(async () => {
    await harness.app.stop();
  });

  it('answers 401 for an anonymous request', async () => {
    harness = await buildMfaGuardApp();
    const response = await harness.app.fetch(new Request(`${BASE}/mfa-protected`));
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
    expect(body.detail).toBe('Authentication required');
  });

  it('answers 403 second-factor-required for a principal without otp/pop in amr', async () => {
    harness = await buildMfaGuardApp();
    const token = await harness.sign({ amr: ['pwd'] });
    const response = await harness.app.fetch(
      new Request(`${BASE}/mfa-protected`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('Forbidden');
    expect(body.detail).toBe('Second factor required');
  });

  it('answers 200 for a principal with otp in amr', async () => {
    harness = await buildMfaGuardApp();
    const token = await harness.sign({ amr: ['pwd', 'otp'] });
    const response = await harness.app.fetch(
      new Request(`${BASE}/mfa-protected`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('answers 200 for a principal with pop in amr', async () => {
    harness = await buildMfaGuardApp();
    const token = await harness.sign({ amr: ['pop'] });
    const response = await harness.app.fetch(
      new Request(`${BASE}/mfa-protected`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("a self-issued JWT with amr: ['otp'] passes the guard (pinned)", async () => {
    harness = await buildMfaGuardApp();
    const token = await harness.sign({ amr: ['otp'] });
    const response = await harness.app.fetch(
      new Request(`${BASE}/mfa-protected`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    // Deliberately: the JWT strategy copies claims from tokens the application
    // itself signed, so a self-issued JWT carrying amr: ['otp'] passes.
    expect(response.status).toBe(200);
  });

  it('answers 403 when amr is absent entirely', async () => {
    harness = await buildMfaGuardApp();
    const token = await harness.sign({});
    const response = await harness.app.fetch(
      new Request(`${BASE}/mfa-protected`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.detail).toBe('Second factor required');
  });

  it('treats a NON-ARRAY amr as absent instead of substring-matching it', async () => {
    // `claims` is `Record<string, unknown>`, so amr can arrive as a bare string.
    // Reading it as a string and calling `.includes` would let 'sotp' — or any
    // string merely containing a factor name — satisfy the guard. Each value is
    // asserted against the answer it must produce, so the enumeration cannot
    // drift from the code.
    const cases: Array<[unknown, number]> = [
      ['sotp', 403],
      ['otp', 403],
      ['pop', 403],
      [7, 403],
      [{ 0: 'otp', length: 1 }, 403],
      [['otp'], 200],
      [['pwd', 'pop'], 200],
    ];
    harness = await buildMfaGuardApp();
    for (const [amr, expected] of cases) {
      const token = await harness.sign({ amr });
      const response = await harness.app.fetch(
        new Request(`${BASE}/mfa-protected`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status, `amr=${JSON.stringify(amr)}`).toBe(expected);
    }
  });
});
