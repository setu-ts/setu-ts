import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MiddlewareFunction } from '@setu-ts/common';
import { securityMetadataOf } from '@setu-ts/common';

import { Controller, Get, Public, Roles } from '../../../src/index.ts';
import { DecoratorPlugin } from '../../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../../fixtures/fake-context.ts';

/**
 * §3.7: `@Public()` stays documentation in this milestone. Its JSDoc used to
 * claim it bypassed authentication and authorization and took precedence over
 * `@Roles`/`@Permissions` — nothing read `isPublic` except the OpenAPI schema
 * builder (`security: []`). It is inert in the FAIL-CLOSED direction, so this
 * milestone corrects the docs instead of enforcing a bypass. These tests pin
 * the behaviour so a later milestone making `@Public` exempt has a failing
 * test to update.
 */

function asRouteDef(route: unknown): { middleware?: MiddlewareFunction[]; schema?: unknown } {
  return route as { middleware?: MiddlewareFunction[]; schema?: unknown };
}

/** True for the authorization middleware the plugin appends (M57-branded). */
function isAuthorizationMiddleware(fn: unknown): boolean {
  return securityMetadataOf(fn as MiddlewareFunction)?.authenticated === true;
}

describe('@Public contributes no middleware (§3.7)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('a @Public route carries no enforcement middleware', async () => {
    @Controller('/open')
    class OpenController {
      @Get('/')
      @Public()
      open() {
        return [];
      }
    }

    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [OpenController] }).register(ctx);

    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
    // Its one real effect: the OpenAPI marker, unchanged from before M89a.
    expect(
      (asRouteDef(routes[0].route).schema as { security?: unknown } | undefined)?.security,
    ).toEqual([]);
  });

  it('@Public does NOT exempt a route from @Roles enforcement (fail closed)', async () => {
    @Controller('/mixed')
    class MixedController {
      @Get('/')
      @Public()
      @Roles('admin')
      both() {
        return [];
      }
    }

    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [MixedController] }).register(ctx);

    const mw = asRouteDef(routes[0].route).middleware ?? [];
    expect(mw).toHaveLength(1);
    expect(isAuthorizationMiddleware(mw[0])).toBe(true);
  });
});
