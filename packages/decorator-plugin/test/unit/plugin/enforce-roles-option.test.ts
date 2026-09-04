import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAuthorizationService,
  ILogger,
  LogMetadata,
  MiddlewareFunction,
} from '@setu-ts/common';
import { securityMetadataOf } from '@setu-ts/common';

import { Controller, Get, Permissions, Post, Roles } from '../../../src/index.ts';
import { DecoratorPlugin } from '../../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../../fixtures/fake-context.ts';

/**
 * §3.4/§3.5: `enforceRoles` defaults ON (AI_GUIDELINES §13.4 — a
 * security-related plugin defaults to its most secure configuration); `false`
 * restores the pre-M89a behaviour byte-for-byte; and with enforcement on but
 * no authorization capability registered, `register()` warns once per
 * affected route while the route still fails closed.
 */

/** A recording logger capturing `warn` calls. */
function recordingLogger(): {
  logger: ILogger;
  warns: { message: string; metadata?: LogMetadata }[];
} {
  const warns: { message: string; metadata?: LogMetadata }[] = [];
  const logger: ILogger = {
    level: 'warn',
    fatal() {},
    error() {},
    info() {},
    debug() {},
    trace() {},
    warn(message, metadata) {
      warns.push(metadata === undefined ? { message } : { message, metadata });
    },
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

const authorization: IAuthorizationService = {
  hasRole: (...args) => args[1] === 'admin',
  hasPermission: (...args) => args[1] === 'billing:write',
  hasAnyRole: (...args) => args[1].includes('admin'),
  hasAllPermissions: (...args) => args[1].every((p) => p === 'billing:write'),
};

/** True for the authorization middleware the plugin appends (M57-branded). */
function isAuthorizationMiddleware(fn: unknown): boolean {
  return securityMetadataOf(fn as MiddlewareFunction)?.authenticated === true;
}

function asRouteDef(route: unknown): { middleware?: MiddlewareFunction[] } {
  return route as { middleware?: MiddlewareFunction[] };
}

describe('enforceRoles option (§3.4, §3.5)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('defaults ON: a decorated route carries enforcing middleware without any option', async () => {
    @Controller('/secure')
    class SecureController {
      @Get('/')
      @Roles('admin')
      list() {
        return [];
      }
    }

    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [SecureController] }).register(ctx);

    const mw = asRouteDef(routes[0].route).middleware ?? [];
    expect(mw).toHaveLength(1);
    expect(isAuthorizationMiddleware(mw[0])).toBe(true);
  });

  it('false leaves the emitted RouteDefinition byte-identical to pre-M89a', async () => {
    @Controller('/legacy')
    class LegacyController {
      @Get('/guarded')
      @Roles('admin')
      guarded() {
        return [];
      }

      @Post('/plain')
      plain() {
        return null;
      }
    }

    const { logger, warns } = recordingLogger();
    // Capability ABSENT on purpose: `false` must silence the warning too.
    const { ctx, routes } = createFakeContext({ logger });
    await DecoratorPlugin({ controllers: [LegacyController], enforceRoles: false }).register(ctx);

    expect(warns).toHaveLength(0);
    // The guarded route's middleware is exactly what composeMiddleware
    // produced — here, nothing at all, which is what every M9–M88 app saw.
    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
    expect(asRouteDef(routes[1].route).middleware).toBeUndefined();
  });

  it('warns ONCE per affected route, naming controller, handler and the restriction', async () => {
    @Controller('/no-rbac')
    class NoRbacController {
      @Get('/a')
      @Roles('admin')
      a() {
        return [];
      }

      @Get('/b')
      @Permissions('billing:write')
      b() {
        return [];
      }

      @Get('/c')
      c() {
        return [];
      }
    }

    const { logger, warns } = recordingLogger();
    const { ctx, routes } = createFakeContext({ logger });
    await DecoratorPlugin({ controllers: [NoRbacController] }).register(ctx);

    // Two warnings — only for the routes carrying a restriction; /c is silent.
    expect(warns).toHaveLength(2);
    const first = warns[0].metadata ?? {};
    expect(first.controller).toBe('NoRbacController');
    expect(first.handler).toBe('a');
    expect(first.roles).toEqual(['admin']);
    const second = warns[1].metadata ?? {};
    expect(second.handler).toBe('b');
    expect(second.permissions).toEqual(['billing:write']);
    // Both remedies are named.
    expect(String(warns[0].metadata?.hint) + warns[0].message).toContain('enforceRoles');
    expect(String(warns[0].metadata?.hint)).toContain('CAPABILITIES.AUTHORIZATION');
    // Fail closed: the middleware is STILL appended — the route answers 501,
    // it is never served unguarded.
    for (const route of routes.slice(0, 2)) {
      const mw = asRouteDef(route.route).middleware ?? [];
      expect(mw).toHaveLength(1);
      expect(isAuthorizationMiddleware(mw[0])).toBe(true);
    }
    expect(asRouteDef(routes[2].route).middleware).toBeUndefined();
  });

  it('emits no warning when the capability is present', async () => {
    @Controller('/ok')
    class OkController {
      @Get('/')
      @Roles('admin')
      list() {
        return [];
      }
    }

    const { logger, warns } = recordingLogger();
    const { ctx } = createFakeContext({ logger });
    ctx.services.register(CAPABILITIES.AUTHORIZATION, authorization);
    await DecoratorPlugin({ controllers: [OkController] }).register(ctx);

    expect(warns).toHaveLength(0);
  });

  it('declares an optional dependency edge on both enforced capabilities', () => {
    // Real dependency edges (not priority luck): a REPLACEMENT provider
    // registered at a higher priority number still lands before this plugin,
    // so the register-time warning decision sees it.
    const plugin = DecoratorPlugin({});
    expect(plugin.optionalDependencies).toEqual([
      CAPABILITIES.VALIDATION,
      CAPABILITIES.AUTHORIZATION,
    ]);
  });
});
