/**
 * The startup refusal and the seal, through a REAL `start()` (M110a §3.7).
 *
 * A functional guard is a value the application builds, so no `register()`
 * sees it; AuthPlugin's `onBootstrap` hook scans the routes instead and fails
 * `start()` before the server listens. The residuals are pinned too: a route
 * added after `start()` is not scanned and fails closed per request.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthorizationPolicyService, IJwtService, IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';

import { AuthPlugin, definePolicy, requirePolicy } from '../../src/index.ts';

const SECRET = 'policy-startup-scan-secret-at-least-32-chars';

const docPolicy = definePolicy({ name: 'doc', abilities: { edit: () => true } });
const unregistered = definePolicy({ name: 'invoice', abilities: { approve: () => true } });

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop().catch(() => {});
  app = undefined;
});

describe('AuthPlugin startup scan', () => {
  it('fails start() for a guard naming an unregistered policy, naming route and names', async () => {
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET }, policies: [docPolicy] })],
    });
    built.router.post('/invoices/:id/approve', {
      middleware: [requirePolicy(unregistered, 'approve')],
      handler: (ctx) => ctx.response.json({ approved: true }),
    });
    await expect(built.start()).rejects.toThrow(
      'route POST /invoices/:id/approve uses requirePolicy("invoice", "approve"), but no such ' +
        'policy ability is registered',
    );
  });

  it('starts when every guard names a registered ability', async () => {
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET }, policies: [docPolicy] })],
    });
    built.router.post('/docs', {
      middleware: [requirePolicy(docPolicy, 'edit')],
      handler: (ctx) => ctx.response.json({}),
    });
    await expect(built.start()).resolves.toBeUndefined();
    app = built;
  });

  it('accepts a policy another plugin defines during its own register()', async () => {
    const contributor: IPlugin = {
      name: 'invoice-policies',
      version: '0.0.0',
      dependencies: [CAPABILITIES.AUTHORIZATION_POLICIES],
      register(ctx) {
        ctx.services.get<IAuthorizationPolicyService>(CAPABILITIES.AUTHORIZATION_POLICIES)
          .define(unregistered);
      },
    };
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET } }), contributor],
    });
    built.router.post('/approve', {
      middleware: [requirePolicy(unregistered, 'approve')],
      handler: (ctx) => ctx.response.json({}),
    });
    await expect(built.start()).resolves.toBeUndefined();
    app = built;
  });

  it('seals the registry once started', async () => {
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET } })],
    });
    await built.start();
    app = built;
    const service = built.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    expect(() => service.define(docPolicy)).toThrow(/once the application has started/);
    expect(service.describe('doc', 'edit')).toBeUndefined();
  });

  it('does not scan a route added after start(); it fails closed per request', async () => {
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET } })],
    });
    built.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 50 });
    await built.start();
    app = built;
    let handlerRan = false;
    built.router.post('/late', {
      middleware: [requirePolicy(unregistered, 'approve')],
      handler: (ctx) => {
        handlerRan = true;
        return ctx.response.json({});
      },
    });
    const jwt = built.services.get<IJwtService>(CAPABILITIES.JWT);
    const token = await jwt.sign({ sub: 'ann', exp: Math.floor(Date.now() / 1000) + 300 });
    const response = await built.fetch(
      new Request('http://localhost/late', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(500);
    await response.body?.cancel();
    expect(handlerRan).toBe(false);
  });
});
