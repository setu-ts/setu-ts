/**
 * `@RequirePolicy` and class-form policies through a REAL kernel application with the
 * real AuthPlugin, ValidationPlugin and OpenApiPlugin (M110a §3.10–§3.11).
 *
 * Pinned here: a `@Policy` class receives an injected dependency; `@RequirePolicy`
 * runs after `@Roles` and BEFORE validation (anonymous 401 → missing role 403
 * → denied policy 403 even with a bad body → allowed policy with a bad body
 * 400); repeated `@RequirePolicy` is all-of; the OpenAPI `@Public` marker yields to a
 * `@RequirePolicy` that requires a principal; and every register-time refusal.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { Constructor, IJwtService, IPrincipal, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, definePolicy } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

import {
  Ability,
  Controller,
  Get,
  Inject,
  Injectable,
  Patch,
  Policy,
  Public,
  RequirePolicy,
  Roles,
  ValidateBody,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';

// Real Zod, guarded (the roles-enforced precedent): only the 400-ordering arm
// needs it, and it is skipped where the npm specifier cannot load.
const zodModule = await import('npm:zod@^3.24.0').catch(() => undefined);
const z = zodModule?.z;

const SECRET = 'x'.repeat(40);

interface Doc {
  readonly id: string;
  readonly owner: string;
}

/** The dependency the class policy injects — proves construction goes through DI. */
@Injectable({ token: 'doc-ownership' })
class DocOwnership {
  owns(principal: IPrincipal, doc: Doc | undefined): boolean {
    return doc?.owner === principal.id;
  }
}

@Policy('doc')
@Inject('doc-ownership')
class DocPolicy {
  constructor(private readonly ownership: DocOwnership) {}

  @Ability()
  edit(principal: IPrincipal, doc: Doc | undefined): boolean {
    return this.ownership.owns(principal, doc);
  }

  @Ability({ anonymous: true })
  view(_principal: IPrincipal | null, _doc: Doc | undefined): boolean {
    return true;
  }
}

/** A functional policy registered through AuthPlugin, used by `@RequirePolicy` too. */
const auditPolicy = definePolicy({
  name: 'audit',
  abilities: { touch: (principal) => principal.id !== 'carol' },
});

/** The document's owner is its id, so a path chooses who owns it. */
const loadDoc = (ctx: IRequestContext): Doc => ({
  id: ctx.params.id ?? '',
  owner: ctx.params.id ?? '',
});

const editSchema = z?.object({ title: z.string() });

@Controller('/docs')
class DocController {
  @Patch('/:id')
  @Roles('editor')
  @RequirePolicy(DocPolicy, 'edit', loadDoc)
  @ValidateBody(editSchema ?? {})
  edit(): { readonly edited: boolean } {
    return { edited: true };
  }

  @Get('/:id/audit')
  @RequirePolicy(DocPolicy, 'edit', loadDoc)
  @RequirePolicy(auditPolicy, 'touch')
  audit(): { readonly audited: boolean } {
    return { audited: true };
  }

  @Get('/:id')
  @Public()
  @RequirePolicy(DocPolicy, 'view', loadDoc)
  view(): { readonly viewed: boolean } {
    return { viewed: true };
  }

  @Get('/:id/secret')
  @Public()
  @RequirePolicy(DocPolicy, 'edit', loadDoc)
  secret(): { readonly secret: boolean } {
    return { secret: true };
  }
}

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop().catch(() => {});
  app = undefined;
});

function build(
  decorator: Parameters<typeof DecoratorPlugin>[0],
  withAuth = true,
): IKernelApplication {
  const built = createApplication({
    plugins: [
      RuntimePlugin(),
      ...(withAuth
        ? [AuthPlugin({
          jwt: { secret: SECRET },
          rbac: { roles: { editor: {} } },
          policies: [auditPolicy],
        })]
        : []),
      ValidationPlugin(),
      OpenApiPlugin({
        title: 'Docs',
        version: '1.0.0',
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        deriveSecurity: { scheme: 'bearerAuth' },
      }),
      DecoratorPlugin(decorator),
    ],
  });
  built.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 0 });
  return built;
}

async function start(): Promise<{
  readonly app: IKernelApplication;
  readonly token: (sub: string, roles?: readonly string[]) => Promise<string>;
}> {
  const built = build({
    controllers: [DocController],
    services: [DocOwnership],
    policies: [DocPolicy],
  });
  await built.start();
  app = built;
  const jwt = built.services.get<IJwtService>(CAPABILITIES.JWT);
  return {
    app: built,
    token: (sub, roles = []) =>
      jwt.sign({ sub, roles: [...roles], exp: Math.floor(Date.now() / 1000) + 300 }),
  };
}

async function send(
  target: IKernelApplication,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await target.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  await response.body?.cancel();
  return response.status;
}

describe('@RequirePolicy through a real application', () => {
  it('evaluates a class policy through its injected dependency', async () => {
    const { app: started, token } = await start();
    expect(await send(started, 'GET', '/docs/ann/audit', await token('ann'))).toBe(200);
    expect(await send(started, 'GET', '/docs/ann/audit', await token('bob'))).toBe(403);
    expect(await send(started, 'GET', '/docs/ann/audit')).toBe(401);
  });

  it('requires every @RequirePolicy on a route (all-of)', async () => {
    const { app: started, token } = await start();
    // carol OWNS /docs/carol, so the first requirement (DocPolicy.edit) allows
    // her; only the second (auditPolicy.touch, which refuses carol) can refuse.
    expect(await send(started, 'GET', '/docs/carol/audit', await token('carol'))).toBe(403);
    expect(await send(started, 'GET', '/docs/ann/audit', await token('ann'))).toBe(200);
  });

  it('serves an anonymous ability publicly', async () => {
    const { app: started } = await start();
    expect(await send(started, 'GET', '/docs/ann')).toBe(200);
  });

  it('runs after @Roles and before validation', {
    ignore: z === undefined,
  }, async () => {
    const { app: started, token } = await start();
    const bad = { title: 42 };
    const good = { title: 'ok' };
    expect(await send(started, 'PATCH', '/docs/ann', undefined, bad)).toBe(401);
    expect(await send(started, 'PATCH', '/docs/ann', await token('ann'), bad)).toBe(403);
    // Has the role, fails the policy: 403 even though the body is invalid —
    // the policy runs first.
    expect(await send(started, 'PATCH', '/docs/ann', await token('bob', ['editor']), bad)).toBe(
      403,
    );
    expect(await send(started, 'PATCH', '/docs/ann', await token('ann', ['editor']), bad)).toBe(
      400,
    );
    expect(await send(started, 'PATCH', '/docs/ann', await token('ann', ['editor']), good)).toBe(
      200,
    );
  });

  it('documents a @RequirePolicy requiring a principal as secured, despite @Public', async () => {
    const { app: started } = await start();
    const response = await started.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
    const spec = response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(spec.paths['/docs/{id}/secret']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/docs/{id}']?.get?.security).toEqual([]);
  });
});

describe('@RequirePolicy and policies — refused at register()', () => {
  async function refusal(
    decorator: Parameters<typeof DecoratorPlugin>[0],
    withAuth = true,
  ): Promise<string> {
    const built = build(decorator, withAuth);
    const error = await built.start().then(() => undefined, (e: unknown) => e);
    app = built;
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  it('refuses a @RequirePolicy route with no policy service', async () => {
    @Controller('/a')
    class A {
      @Get('/')
      @RequirePolicy(auditPolicy, 'touch')
      index(): string {
        return 'a';
      }
    }
    expect(await refusal({ controllers: [A] }, false)).toContain(
      'Route GET /a (A.index) is decorated with @RequirePolicy, but no CAPABILITIES.AUTHORIZATION_POLICIES',
    );
  });

  it('refuses a @RequirePolicy naming a class policy that was never listed', async () => {
    @Controller('/b')
    class B {
      @Get('/')
      @RequirePolicy(DocPolicy, 'edit')
      index(): string {
        return 'b';
      }
    }
    expect(await refusal({ controllers: [B] })).toContain(
      '@RequirePolicy("doc", "edit"), but no such policy ability is registered',
    );
  });

  it('refuses a @RequirePolicy naming an ordinary method of a policy class', async () => {
    @Policy('helpers')
    class Helpers {
      @Ability()
      ok(): boolean {
        return true;
      }

      plain(): boolean {
        return true;
      }
    }
    @Controller('/c')
    class C {
      @Get('/')
      @RequirePolicy(Helpers, 'plain')
      index(): string {
        return 'c';
      }
    }
    expect(await refusal({ controllers: [C], policies: [Helpers] })).toContain(
      '@RequirePolicy("helpers", "plain")',
    );
  });

  it('refuses listed policies with no policy service', async () => {
    expect(await refusal({ policies: [DocPolicy as Constructor] }, false)).toContain(
      'policies lists DocPolicy, but no CAPABILITIES.AUTHORIZATION_POLICIES provider',
    );
  });

  it('refuses a policy class whose name collides with a functional policy', async () => {
    @Policy('audit')
    class AuditClass {
      @Ability()
      touch(): boolean {
        return true;
      }
    }
    expect(await refusal({ policies: [AuditClass] })).toContain('"audit" is already registered');
  });
});
