/**
 * One policy, four entry points, one answer (M110a §3.12).
 *
 * AuthPlugin's `requirePolicy` guard, DecoratorPlugin's `@Can`, the service's
 * boolean `can`, and a thrown `authorize` (answered by `errorHandler`) are
 * driven for the SAME policy, principal and target under a NON-default
 * configuration — `rfc9457`, a `before` hook, an anonymous ability. They must
 * agree on allow/deny, and the three HTTP refusals must be byte-identical
 * (after removing `instance`, which echoes the path).
 *
 * The two packages may not import each other, so `@Can` and the guard are two
 * thin middlewares over one service; this test is what catches them drifting.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAuthorizationPolicyService,
  IJwtService,
  IPrincipal,
  IRequestContext,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, definePolicy, requirePolicy } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';

import { Can, Controller, Get } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';

interface Note {
  readonly owner: string;
  readonly shared: boolean;
}

const notePolicy = definePolicy({
  name: 'note',
  abilities: {
    edit: (principal, note: Note | undefined) => note?.owner === principal.id,
    read: {
      anonymous: true,
      check: (principal, note: Note | undefined) =>
        note?.shared === true || (principal !== null && note?.owner === principal.id),
    },
  },
  before: (principal) => (principal.roles?.includes('admin') === true ? true : undefined),
});

const NOTES: Readonly<Record<string, Note>> = {
  ann: { owner: 'ann', shared: false },
  open: { owner: 'bob', shared: true },
};

const load = (ctx: IRequestContext): Note | undefined => NOTES[ctx.params.id ?? ''];

const SECRET = 'policy-parity-secret-at-least-32-characters!!';

@Controller('/decorated')
class NoteController {
  @Get('/:id/edit')
  @Can(notePolicy, 'edit', load)
  edit(): { readonly ok: boolean } {
    return { ok: true };
  }

  @Get('/:id/read')
  @Can(notePolicy, 'read', load)
  read(): { readonly ok: boolean } {
    return { ok: true };
  }
}

let app: IKernelApplication;
const tokens = new Map<string, string>();

beforeAll(async () => {
  app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: SECRET }, policies: [notePolicy] }),
      DecoratorPlugin({ controllers: [NoteController] }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 0 });
  for (const ability of ['edit', 'read'] as const) {
    app.router.get(`/guarded/:id/${ability}`, {
      middleware: [requirePolicy(notePolicy, ability, load)],
      handler: (ctx) => ctx.response.json({ ok: true }),
    });
    app.router.get(`/thrown/:id/${ability}`, {
      handler: async (ctx) => {
        const policies = ctx.services.get<IAuthorizationPolicyService>(
          CAPABILITIES.AUTHORIZATION_POLICIES,
        );
        await policies.authorize(ctx.request.user ?? null, notePolicy, ability, load(ctx));
        return ctx.response.json({ ok: true });
      },
    });
  }
  await app.start();
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  const exp = Math.floor(Date.now() / 1000) + 300;
  tokens.set('ann', await jwt.sign({ sub: 'ann', exp }));
  tokens.set('bob', await jwt.sign({ sub: 'bob', exp }));
  tokens.set('root', await jwt.sign({ sub: 'root', roles: ['admin'], exp }));
});

afterAll(async () => {
  await app.stop();
});

async function answer(
  prefix: string,
  id: string,
  ability: string,
  who: string | null,
): Promise<{ readonly status: number; readonly body: string }> {
  const path = `/${prefix}/${id}/${ability}`;
  const token = who === null ? undefined : tokens.get(who);
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    }),
  );
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status >= 400) {
    expect(parsed.instance).toBe(path);
  }
  const { instance: _instance, ...rest } = parsed;
  return { status: response.status, body: JSON.stringify(rest) };
}

const PRINCIPALS: Readonly<Record<string, IPrincipal | null>> = {
  anonymous: null,
  ann: { id: 'ann' },
  bob: { id: 'bob' },
  root: { id: 'root', roles: ['admin'] },
};

// Every (principal, note, ability) combination — expected outcome as data, so
// a regression names the cell it broke.
const CASES: readonly {
  readonly who: keyof typeof PRINCIPALS;
  readonly id: string;
  readonly ability: 'edit' | 'read';
  readonly status: number;
}[] = [
  { who: 'anonymous', id: 'ann', ability: 'edit', status: 401 },
  { who: 'anonymous', id: 'ann', ability: 'read', status: 401 },
  { who: 'anonymous', id: 'open', ability: 'read', status: 200 },
  { who: 'ann', id: 'ann', ability: 'edit', status: 200 },
  { who: 'bob', id: 'ann', ability: 'edit', status: 403 },
  { who: 'bob', id: 'ann', ability: 'read', status: 403 },
  { who: 'bob', id: 'open', ability: 'read', status: 200 },
  { who: 'root', id: 'ann', ability: 'edit', status: 200 },
];

describe('policy parity across requirePolicy, @Can, can() and authorize()', () => {
  for (const row of CASES) {
    it(`${row.who} → ${row.ability} ${row.id}: ${row.status} everywhere`, async () => {
      const who = row.who === 'anonymous' ? null : row.who;
      const guarded = await answer('guarded', row.id, row.ability, who);
      const decorated = await answer('decorated', row.id, row.ability, who);
      const thrown = await answer('thrown', row.id, row.ability, who);
      expect(guarded.status).toBe(row.status);
      expect(decorated).toEqual(guarded);
      expect(thrown).toEqual(guarded);
      const service = app.services.get<IAuthorizationPolicyService>(
        CAPABILITIES.AUTHORIZATION_POLICIES,
      );
      const allowed = await service.can(
        PRINCIPALS[row.who] ?? null,
        notePolicy,
        row.ability,
        NOTES[row.id],
      );
      expect(allowed).toBe(row.status === 200);
    });
  }
});
