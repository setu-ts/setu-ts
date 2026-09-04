import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { Constructor, IJwtService, MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { authMiddleware, AuthPlugin, requireRole } from '@setu-ts/auth-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

import {
  Controller,
  Get,
  Post,
  Public,
  Roles,
  UseGuards,
  UseInterceptors,
  ValidateBody,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

// Real Zod, guarded: the 400-ordering arm needs a real schema. That arm is
// skipped wholesale where the npm specifier cannot load (the
// decorator-validation precedent) so the rest of the suite still runs.
const zodModule = await import('npm:zod@^3.24.0').catch(() => undefined);
const z = zodModule?.z;

/**
 * X18-3 end to end: a decorated route and a `@UseGuards(requireRole(...))`
 * route expressing ONE restriction two ways, in ONE application, must refuse
 * identically. §2.2 forbids sharing the guard functions, so the shared
 * implementation is the CAPABILITY (`IAuthorizationService`) and the shared
 * `respondWithError` seam — this test is the only thing that can catch the
 * two paths drifting, so it is not optional (the plan's §8).
 *
 * The error format is the NON-default `'rfc9457'`, so the byte-identity claim
 * covers the configured formatter rather than the fallback body.
 */

const JWT_SECRET = 'x'.repeat(40);

interface TestApp {
  readonly app: ReturnType<typeof createApplication>;
  readonly viewerToken: string;
  readonly adminToken: string;
}

async function startApp(controllers: readonly Constructor[]): Promise<TestApp> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: JWT_SECRET }, rbac: { roles: { admin: {}, viewer: {} } } }),
      ValidationPlugin(),
      OpenApiPlugin({
        title: 'Roles API',
        version: '1.0.0',
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        deriveSecurity: { scheme: 'bearerAuth' },
      }),
      DecoratorPlugin({ controllers: [...controllers] }),
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
    priority: 0,
    name: 'error-handler',
  });
  app.middleware.add(authMiddleware(), { priority: 100, name: 'auth' });
  await app.start();

  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  return {
    app,
    viewerToken: await jwt.sign({ sub: 'viewer-1', roles: ['viewer'] }),
    adminToken: await jwt.sign({ sub: 'admin-1', roles: ['admin'] }),
  };
}

describe('decorated @Roles enforced through a real kernel app (X18-3)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('refuses a viewer with 403 and admits one on the route that allows them', async () => {
    @Controller('/admin-area')
    class AdminAreaController {
      @Get('/admin-only')
      @Roles('admin')
      adminOnly() {
        return { secret: true };
      }

      @Get('/viewer-ok')
      @Roles('viewer')
      viewerOk() {
        return { ok: true };
      }
    }

    const { app, viewerToken } = await startApp([AdminAreaController]);
    try {
      const refused = await app.inject({
        method: 'GET',
        url: 'http://localhost/admin-area/admin-only',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(refused.statusCode).toBe(403);
      // Field-by-field against the RFC 9457 shape: required fields present,
      // `message` absent.
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Forbidden');
      expect(body.status).toBe(403);
      expect(body.detail).toBe('Role "admin" is required');
      expect('message' in body).toBe(false);

      const admitted = await app.inject({
        method: 'GET',
        url: 'http://localhost/admin-area/viewer-ok',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(admitted.statusCode).toBe(200);
      expect((await admitted.json()) as Record<string, unknown>).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });

  it('THE CONTROL: the @UseGuards(requireRole(...)) spelling refuses byte-identically', async () => {
    @Controller('/control')
    class ControlController {
      @Get('/decorated')
      @Roles('admin')
      decorated() {
        return { secret: true };
      }

      @Get('/guarded')
      @UseGuards(requireRole('admin'))
      guarded() {
        return { secret: true };
      }
    }

    const { app, viewerToken } = await startApp([ControlController]);
    try {
      const decorated = await app.inject({
        method: 'GET',
        url: 'http://localhost/control/decorated',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      const guarded = await app.inject({
        method: 'GET',
        url: 'http://localhost/control/guarded',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(decorated.statusCode).toBe(403);
      expect(guarded.statusCode).toBe(403);
      // Byte-identical AFTER removing `instance`: the responder echoes the
      // request path there, which differs for ANY two distinct routes — a
      // requireRole-vs-requireRole pair differs the same way. Everything the
      // mechanism decides (type, title, status, detail) must match exactly,
      // compared on the raw body string with only that field lifted.
      const withoutInstance = (raw: string | null): string => {
        const { instance: _ignored, ...rest } = JSON.parse(raw ?? '{}') as Record<string, unknown>;
        return JSON.stringify(rest);
      };
      expect(withoutInstance(guarded.body)).toBe(withoutInstance(decorated.body));
    } finally {
      await app.stop();
    }
  });

  it('refuses an anonymous caller with 401 before anything else', async () => {
    @Controller('/anon')
    class AnonController {
      @Get('/restricted')
      @Roles('admin')
      restricted() {
        return { secret: true };
      }
    }

    const { app } = await startApp([AnonController]);
    try {
      const refused = await app.inject({
        method: 'GET',
        url: 'http://localhost/anon/restricted',
      });
      expect(refused.statusCode).toBe(401);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body.title).toBe('Unauthorized');
      expect(body.detail).toBe('Authentication required');
    } finally {
      await app.stop();
    }
  });

  it('runs authorization before an interceptor that would short-circuit', async () => {
    let interceptorRan = false;
    let handlerRan = false;
    const shortCircuit: MiddlewareFunction = (ctx) => {
      interceptorRan = true;
      return ctx.response.json({ bypassed: true });
    };

    @Controller('/short-circuit')
    class ShortCircuitController {
      @Get('/restricted')
      @Roles('admin')
      @UseInterceptors(shortCircuit)
      restricted() {
        handlerRan = true;
        return { secret: true };
      }
    }

    const { app, viewerToken } = await startApp([ShortCircuitController]);
    try {
      const refused = await app.inject({
        method: 'GET',
        url: 'http://localhost/short-circuit/restricted',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(refused.statusCode).toBe(403);
      expect(await refused.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Role "admin" is required',
        instance: '/short-circuit/restricted',
      });
      expect(interceptorRan).toBe(false);
      expect(handlerRan).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('deriveSecurity sees the M57 brand: the document names the requirement', async () => {
    @Controller('/documented')
    class DocumentedController {
      @Get('/restricted')
      @Roles('admin')
      restricted() {
        return { secret: true };
      }
    }

    const { app } = await startApp([DocumentedController]);
    try {
      const response = await app.inject({
        method: 'GET',
        url: 'http://localhost/openapi.json',
      });
      const spec = (await response.json()) as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      // Before M89a `security` was ABSENT here: the route was documented as
      // unprotected while its declaration promised the opposite.
      expect(spec.paths['/documented/restricted']?.get?.security).toEqual([{ bearerAuth: [] }]);
    } finally {
      await app.stop();
    }
  });

  it('@Public with an enforced role keeps the derived OpenAPI requirement', async () => {
    @Controller('/mixed-documentation')
    class MixedDocumentationController {
      @Get('/restricted')
      @Public()
      @Roles('admin')
      restricted() {
        return { secret: true };
      }
    }

    const { app } = await startApp([MixedDocumentationController]);
    try {
      const response = await app.inject({
        method: 'GET',
        url: 'http://localhost/openapi.json',
      });
      const spec = (await response.json()) as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(spec.paths['/mixed-documentation/restricted']?.get?.security).toEqual([
        { bearerAuth: [] },
      ]);
    } finally {
      await app.stop();
    }
  });
});

// The 400 arm needs a real Zod schema; skipped wholesale where the npm
// specifier cannot load, exactly like the decorator-validation suite — the
// other tests here do not need zod and always run.
const describeZod = z === undefined ? describe.skip : describe;

describeZod('refusal ordering 401 → 403 → 400 (real zod schema)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('authorization precedes validation', async () => {
    const Schema = z!.object({ name: z!.string() });

    @Controller('/ordered')
    class OrderedController {
      @Post('/items')
      @Roles('admin')
      @ValidateBody(Schema)
      create() {
        return { created: true };
      }
    }

    const { app, viewerToken, adminToken } = await startApp([OrderedController]);
    try {
      // No principal → 401, not 400 and not 403.
      const anon = await app.inject({
        method: 'POST',
        url: 'http://localhost/ordered/items',
        body: { name: 42 },
      });
      expect(anon.statusCode).toBe(401);

      // Wrong role → 403 even with an invalid body: the caller was never
      // entitled to submit anything, so no 400 describing the body's fields.
      const forbidden = await app.inject({
        method: 'POST',
        url: 'http://localhost/ordered/items',
        headers: { authorization: `Bearer ${viewerToken}` },
        body: { name: 42 },
      });
      expect(forbidden.statusCode).toBe(403);

      // Right role, invalid body → the 400 now has its chance.
      const badRequest = await app.inject({
        method: 'POST',
        url: 'http://localhost/ordered/items',
        headers: { authorization: `Bearer ${adminToken}` },
        body: { name: 42 },
      });
      expect(badRequest.statusCode).toBe(400);
    } finally {
      await app.stop();
    }
  });
});
