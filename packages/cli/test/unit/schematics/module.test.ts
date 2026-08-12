/**
 * Unit tests for the `module` aggregate schematic.
 *
 * Ungated since M65, and the only schematic emitting a whole domain unit in
 * either style — so both arms are pinned, including the barrel properties the
 * class arm shares with every other seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateModule } from '../../../src/schematics/module.ts';
import { gateOf, options } from './_shared.ts';
import { deriveNames } from '../../../src/utils/names.ts';

/** Returns the emitted file at a path, failing the test when it is absent. */
function fileAt(files: readonly { path: string; contents: string }[], path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no emitted file at ${path}`);
  return found.contents;
}

const CLASS_PLUGINS = ['decorator-plugin', 'di-plugin'];

describe('generateModule', () => {
  const names = deriveNames('user-profile');

  it('is ungated, so the default composition can generate a domain unit', () => {
    // Gating it on `decorator-plugin` — as it was before M65 — would leave the
    // functional default with no aggregate schematic at all.
    expect(gateOf('module')).toBeUndefined();
  });

  describe('in a functional project', () => {
    const files = generateModule(names, options());

    it('emits the service, its test, the module barrel, and a registered route', () => {
      expect(files.map((file) => file.path)).toEqual([
        'src/modules/user-profile/user-profile.service.ts',
        'src/modules/user-profile/user-profile.service.test.ts',
        'src/modules/user-profile/index.ts',
        'src/routes/user-profile.routes.ts',
        'src/routes/index.ts',
      ]);
    });

    it('exports a plain function rather than a class', () => {
      const source = fileAt(files, 'src/modules/user-profile/user-profile.service.ts');
      expect(source).toContain('export function listUserProfile');
      expect(source).not.toContain('@Injectable');
    });

    it('registers ctx-first handlers through the router API', () => {
      const source = fileAt(files, 'src/routes/user-profile.routes.ts');
      expect(source).toContain('export function registerUserProfileRoutes(router: IRouterApi)');
      expect(source).toContain("router.group('/user-profile'");
      // The write answers a real 201, which a decorated handler can only do
      // through `@Ctx()` — here the context is simply the handler's argument.
      expect(source).toContain('status(201)');
    });

    it('marks only the routes barrel managed', () => {
      // The module's own files are the developer's; the barrel is CLI-owned, and
      // that exemption is the only reason a second module does not refuse.
      expect(files.filter((f) => f.managed === true).map((f) => f.path))
        .toEqual(['src/routes/index.ts']);
    });

    it('lists the existing route modules alongside the new one', () => {
      const files = generateModule(
        deriveNames('user'),
        options([], [], { route: ['gizmo', 'billing'] }),
      );
      const barrel = fileAt(files, 'src/routes/index.ts');
      for (const call of ['registerGizmoRoutes', 'registerBillingRoutes', 'registerUserRoutes']) {
        expect(barrel).toContain(`${call}(router);`);
      }
    });

    it('lists a regenerated module exactly once', () => {
      const files = generateModule(deriveNames('user'), options([], [], { route: ['user'] }));
      const barrel = fileAt(files, 'src/routes/index.ts');
      expect(barrel.match(/registerUserRoutes\(router\);/g)?.length).toBe(1);
    });

    it('emits a service test in the repo test style, never Deno.test', () => {
      const source = fileAt(files, 'src/modules/user-profile/user-profile.service.test.ts');
      expect(source).toContain("import { describe, it } from '@std/testing/bdd';");
      expect(source).toContain("import { expect } from '@std/expect';");
      expect(source).not.toContain('Deno.test');
    });

    it('re-exports the function from the per-module barrel', () => {
      expect(fileAt(files, 'src/modules/user-profile/index.ts'))
        .toContain('export { listUserProfile }');
    });
  });

  describe('in a class-based project', () => {
    const files = generateModule(names, options(CLASS_PLUGINS));

    it('emits five files under the module directory', () => {
      expect(files.map((f) => f.path)).toEqual([
        'src/modules/user-profile/user-profile.service.ts',
        'src/modules/user-profile/user-profile.controller.ts',
        'src/modules/user-profile/user-profile.service.test.ts',
        'src/modules/user-profile/index.ts',
        'src/modules/index.ts',
      ]);
    });

    it('marks only the aggregate barrel managed', () => {
      expect(files.filter((f) => f.managed === true).map((f) => f.path))
        .toEqual(['src/modules/index.ts']);
    });

    it('injects the service into the controller by an explicit token', () => {
      // `emitDecoratorMetadata` is absent repo-wide and Deno does not support it,
      // so the parameter type cannot be read and the token is mandatory.
      const source = fileAt(files, 'src/modules/user-profile/user-profile.controller.ts');
      expect(source).toContain("@Inject('user-profile-service')");
      expect(source).toContain("@Controller('/user-profile')");
    });

    it('takes the request context through @Ctx(), never positionally', () => {
      // The plugin builds a handler's argument list from parameter metadata
      // ALONE, so a bare `ctx` parameter arrives `undefined` and the first
      // `ctx.response` throws — a 500 on every request, which is what shipped
      // from M34 until M58. `@Ctx()` is the metadata that fills the slot; the
      // e2e that boots the app is the real proof.
      const source = fileAt(files, 'src/modules/user-profile/user-profile.controller.ts');
      expect(source).toContain('@Ctx() ctx: IRequestContext');
      expect(source).toContain('ctx.response.status(201)');
    });

    it('registers the service under the token the controller injects', () => {
      const source = fileAt(files, 'src/modules/user-profile/user-profile.service.ts');
      expect(source).toContain("@Injectable({ token: 'user-profile-service' })");
      expect(source).toContain('export class UserProfileService');
    });

    it('emits a service test in the repo test style, never Deno.test', () => {
      const source = fileAt(files, 'src/modules/user-profile/user-profile.service.test.ts');
      expect(source).toContain("import { describe, it } from '@std/testing/bdd';");
      expect(source).not.toContain('Deno.test');
    });

    it('re-exports both classes from the per-module barrel', () => {
      const source = fileAt(files, 'src/modules/user-profile/index.ts');
      expect(source).toContain('export { UserProfileController }');
      expect(source).toContain('export { UserProfileService }');
    });

    it('lists the existing modules alongside the new one in the barrel', () => {
      const files = generateModule(
        deriveNames('user'),
        options(CLASS_PLUGINS, ['billing', 'order']),
      );
      const barrel = fileAt(files, 'src/modules/index.ts');
      expect(barrel).toContain('BillingController');
      expect(barrel).toContain('OrderController');
      expect(barrel).toContain('UserController');
    });

    it('lists a regenerated module exactly once', () => {
      const files = generateModule(deriveNames('user'), options(CLASS_PLUGINS, ['user']));
      const barrel = fileAt(files, 'src/modules/index.ts');
      expect(barrel.match(/from '\.\/user\/user\.controller\.ts'/g)?.length).toBe(1);
    });

    it('produces a barrel identical to the one the templates scaffold', () => {
      // Both go through renderModuleBarrel, so the scaffolded seam and every
      // regeneration of it cannot drift in shape.
      const barrel = fileAt(
        generateModule(deriveNames('user'), options(CLASS_PLUGINS)),
        'src/modules/index.ts',
      );
      expect(barrel).toContain('export const MODULE_CONTROLLERS: readonly Constructor[] = [');
      expect(barrel).toContain('export const MODULE_SERVICES: readonly Constructor[] = [');
    });

    it('treats an absent modules option as no modules', () => {
      // `modules` is optional on the published interface, so a harness predating
      // it may omit the field entirely.
      const files = generateModule(deriveNames('user'), {
        runtime: 'deno',
        plugins: new Set(['decorator-plugin']),
        now: () => 0,
      });
      expect(fileAt(files, 'src/modules/index.ts')).toContain('UserController');
    });
  });
});
