/**
 * AuthPlugin's policy wiring through a REAL kernel application (M110a §3.1,
 * §3.8): the capability is always provided, the `policies` option is refused
 * at construction, and a route guarded by `requirePolicy` round-trips — a
 * target loaded per request, the owner allowed, a stranger refused, an
 * anonymous request refused with 401, an anonymous ability served.
 *
 * Driven with `app.fetch`, which goes through the real response mapper.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAuthorizationPolicyService,
  IJwtService,
  ILogger,
  PolicyDefinition,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import {
  AuthPlugin,
  AuthPluginConfigurationError,
  definePolicy,
  requirePolicy,
} from '../../src/index.ts';

const BASE = 'http://localhost';
const SECRET = 'policy-plugin-test-secret-at-least-32-chars!';

interface Doc {
  readonly id: string;
  readonly owner: string;
  readonly published: boolean;
}

const DOCS: ReadonlyMap<string, Doc> = new Map([
  ['d1', { id: 'd1', owner: 'ann', published: false }],
  ['d2', { id: 'd2', owner: 'bob', published: true }],
]);

const docPolicy = definePolicy({
  name: 'doc',
  abilities: {
    edit: (principal, doc: Doc | undefined) => doc?.owner === principal.id,
    view: {
      anonymous: true,
      check: (principal, doc: Doc | undefined) =>
        doc?.published === true || (principal !== null && doc?.owner === principal.id),
    },
    explode: () => {
      throw new Error('policy backend down');
    },
  },
});

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(
  options: { readonly logger?: ILogger } = {},
): Promise<{ readonly app: IKernelApplication; readonly token: (sub: string) => Promise<string> }> {
  const built = createApplication({
    plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET }, policies: [docPolicy] })],
  });
  if (options.logger !== undefined) {
    built.services.register(CAPABILITIES.LOGGER, options.logger);
  }
  const load = (ctx: { readonly params: Readonly<Record<string, string>> }): Doc | undefined =>
    DOCS.get(ctx.params.id ?? '');
  built.router.patch('/docs/:id', {
    middleware: [requirePolicy(docPolicy, 'edit', load)],
    handler: (ctx) => ctx.response.json({ edited: ctx.params.id }),
  });
  built.router.get('/docs/:id', {
    middleware: [requirePolicy(docPolicy, 'view', load)],
    handler: (ctx) => ctx.response.json({ viewed: ctx.params.id }),
  });
  built.router.post('/explode', {
    middleware: [requirePolicy(docPolicy, 'explode')],
    handler: (ctx) => ctx.response.json({ ran: true }),
  });
  await built.start();
  app = built;
  const jwt = built.services.get<IJwtService>(CAPABILITIES.JWT);
  return {
    app: built,
    token: (sub) => jwt.sign({ sub, exp: Math.floor(Date.now() / 1000) + 300 }),
  };
}

async function call(
  target: IKernelApplication,
  method: string,
  path: string,
  token?: string,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await target.fetch(
    new Request(`${BASE}${path}`, {
      method,
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('AuthPlugin — authorization policies capability', () => {
  it('is provided and registered with neither policies nor rbac configured', async () => {
    const built = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: SECRET } })],
    });
    await built.start();
    app = built;
    const plugin = AuthPlugin({ jwt: { secret: SECRET } });
    expect(plugin.provides).toContain(CAPABILITIES.AUTHORIZATION_POLICIES);
    expect(plugin.provides).not.toContain(CAPABILITIES.AUTHORIZATION);
    const service = built.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    expect(service.describe('doc', 'edit')).toBeUndefined();
  });

  it('holds the configured policies', async () => {
    const started = await start();
    const service = started.app.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    expect(service.describe('doc', 'view')).toEqual({ anonymous: true });
    expect(await service.can({ id: 'ann' }, docPolicy, 'edit', DOCS.get('d1'))).toBe(true);
  });
});

describe('AuthPlugin — the policies option is refused at construction', () => {
  const allow = (): boolean => true;
  const REFUSED: readonly {
    readonly label: string;
    readonly policies: unknown;
    readonly says: RegExp;
  }[] = [
    { label: 'a non-array', policies: docPolicy, says: /policies must be an array/ },
    {
      label: 'a malformed policy',
      policies: [{ name: 'Bad', abilities: { a: allow } }],
      says: /kebab-case/,
    },
    {
      label: 'two policies sharing a name',
      policies: [docPolicy, { name: 'doc', abilities: { a: allow } }],
      says: /two authorization policies are named "doc"/,
    },
  ];
  for (const row of REFUSED) {
    it(`refuses ${row.label}`, () => {
      const call = (): unknown =>
        AuthPlugin({ policies: row.policies as readonly PolicyDefinition[] });
      expect(call).toThrow(AuthPluginConfigurationError);
      expect(call).toThrow(row.says);
    });
  }
});

describe('requirePolicy through a real application', () => {
  it('allows the owner to edit their document', async () => {
    const { app: started, token } = await start();
    expect(await call(started, 'PATCH', '/docs/d1', await token('ann'))).toEqual({
      status: 200,
      body: { edited: 'd1' },
    });
  });

  it('refuses a signed-in stranger with 403 and runs no handler', async () => {
    const { app: started, token } = await start();
    expect(await call(started, 'PATCH', '/docs/d1', await token('bob'))).toEqual({
      status: 403,
      body: { error: 'Forbidden', detail: 'Insufficient privileges' },
    });
  });

  it('refuses an anonymous edit with 401', async () => {
    const { app: started } = await start();
    expect(await call(started, 'PATCH', '/docs/d1')).toEqual({
      status: 401,
      body: { error: 'Unauthorized', detail: 'Authentication required' },
    });
  });

  it('serves an anonymous view of a published document and refuses an unpublished one', async () => {
    const { app: started, token } = await start();
    expect((await call(started, 'GET', '/docs/d2')).status).toBe(200);
    expect((await call(started, 'GET', '/docs/d1')).status).toBe(401);
    expect((await call(started, 'GET', '/docs/d1', await token('ann'))).status).toBe(200);
  });

  it('denies a throwing policy with 403 and reports it once through the registered logger', async () => {
    const lines: { readonly message: string; readonly meta: unknown }[] = [];
    const noop = (): void => {};
    const logger = {
      debug: noop,
      info: noop,
      warn: noop,
      trace: noop,
      fatal: noop,
      error: (message: string, meta?: unknown) => lines.push({ message, meta }),
      child: () => logger,
    } as unknown as ILogger;
    const { app: started, token } = await start({ logger });
    const result = await call(started, 'POST', '/explode', await token('ann'));
    expect(result).toEqual({
      status: 403,
      body: { error: 'Forbidden', detail: 'Insufficient privileges' },
    });
    const policyLines = lines.filter((line) => line.message.startsWith('Authorization policy'));
    expect(policyLines).toHaveLength(1);
    expect(policyLines[0]?.meta).toMatchObject({
      policy: 'doc',
      ability: 'explode',
      stage: 'check',
    });
  });
});
