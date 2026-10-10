/**
 * A thrown `authorize()` denial answers the SAME body a guard's refusal does
 * (M110a §3.5, §3.9), under a non-default error format.
 *
 * Both bodies come from one owner — `authorizationFailureInit` — through two
 * different paths: the guard writes through the request-scoped responder, the
 * thrown error is answered by `errorHandler` from its status hint. Compared
 * byte for byte after normalising only `instance`, which echoes the path.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthorizationPolicyService, IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';

import { AuthPlugin, definePolicy, requireRole } from '../../src/index.ts';

const SECRET = 'policy-refusal-parity-secret-at-least-32-chars';

const docPolicy = definePolicy({ name: 'doc', abilities: { edit: () => false } });

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(): Promise<{ readonly app: IKernelApplication; readonly token: string }> {
  const built = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        jwt: { secret: SECRET },
        rbac: { roles: { admin: {} } },
        policies: [docPolicy],
      }),
    ],
  });
  built.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 50 });
  built.router.post('/guarded', {
    middleware: [requireRole('admin')],
    handler: (ctx) => ctx.response.json({ ran: true }),
  });
  built.router.post('/thrown', {
    handler: async (ctx) => {
      const policies = ctx.services.get<IAuthorizationPolicyService>(
        CAPABILITIES.AUTHORIZATION_POLICIES,
      );
      await policies.authorize(ctx.request.user ?? null, docPolicy, 'edit');
      return ctx.response.json({ ran: true });
    },
  });
  await built.start();
  app = built;
  const jwt = built.services.get<IJwtService>(CAPABILITIES.JWT);
  return {
    app: built,
    token: await jwt.sign({ sub: 'ann', roles: [], exp: Math.floor(Date.now() / 1000) + 300 }),
  };
}

async function refusal(
  target: IKernelApplication,
  path: string,
  token?: string,
): Promise<{ readonly status: number; readonly type: string | null; readonly body: string }> {
  const response = await target.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    }),
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  // `instance` echoes the request path, the one field that legitimately differs.
  expect(parsed.instance).toBe(path);
  const { instance: _instance, ...rest } = parsed;
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: JSON.stringify(rest),
  };
}

describe('authorize() denial ↔ guard refusal parity (rfc9457)', () => {
  it('a signed-in denial matches requireRole’s 403 byte for byte', async () => {
    const started = await start();
    const thrown = await refusal(started.app, '/thrown', started.token);
    const guarded = await refusal(started.app, '/guarded', started.token);
    expect(thrown.status).toBe(403);
    expect(thrown).toEqual(guarded);
    expect(JSON.parse(thrown.body)).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Insufficient privileges',
    });
  });

  it('an anonymous denial matches requireRole’s 401 byte for byte', async () => {
    const started = await start();
    const thrown = await refusal(started.app, '/thrown');
    const guarded = await refusal(started.app, '/guarded');
    expect(thrown.status).toBe(401);
    expect(thrown).toEqual(guarded);
    expect(thrown.type).toContain('application/problem+json');
  });
});
