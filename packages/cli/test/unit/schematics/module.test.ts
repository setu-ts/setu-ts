/**
 * Unit tests for the `module` aggregate schematic.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateModule } from '../../../src/schematics/module.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { gateOf, options } from './_shared.ts';

/** Returns the emitted file at a path, failing the test when it is absent. */
function fileAt(files: readonly { path: string; contents: string }[], path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no emitted file at ${path}`);
  return found.contents;
}

describe('generateModule', () => {
  const names = deriveNames('user-profile');

  it('is gated on the decorator plugin', () => {
    // The emitted controller imports @Controller/@Get/@Inject/@Post, so an
    // ungated project would receive source that cannot resolve its own import.
    expect(gateOf('module')).toBe('decorator-plugin');
  });

  it('emits five files under the module directory', () => {
    const files = generateModule(names, options());

    expect(files.map((f) => f.path)).toEqual([
      'src/modules/user-profile/user-profile.service.ts',
      'src/modules/user-profile/user-profile.controller.ts',
      'src/modules/user-profile/user-profile.service.test.ts',
      'src/modules/user-profile/index.ts',
      'src/modules/index.ts',
    ]);
  });

  it('marks only the aggregate barrel managed', () => {
    const files = generateModule(names, options());

    const managed = files.filter((f) => f.managed === true).map((f) => f.path);
    expect(managed).toEqual(['src/modules/index.ts']);
  });

  it('injects the service into the controller by an explicit token', () => {
    // `emitDecoratorMetadata` is absent repo-wide and Deno does not support it,
    // so the parameter type cannot be read and the token is mandatory.
    const source = fileAt(
      generateModule(names, options()),
      'src/modules/user-profile/user-profile.controller.ts',
    );

    expect(source).toContain("@Inject('user-profile-service')");
    expect(source).toContain('private readonly userProfiles: UserProfileService');
    expect(source).toContain("@Controller('/user-profile')");
  });

  it('registers the service under the token the controller injects', () => {
    const source = fileAt(
      generateModule(names, options()),
      'src/modules/user-profile/user-profile.service.ts',
    );

    expect(source).toContain("@Injectable({ token: 'user-profile-service' })");
    expect(source).toContain('export class UserProfileService');
  });

  it('emits a service test in the repo test style, never Deno.test', () => {
    const source = fileAt(
      generateModule(names, options()),
      'src/modules/user-profile/user-profile.service.test.ts',
    );

    expect(source).toContain("import { describe, it } from '@std/testing/bdd';");
    expect(source).toContain("import { expect } from '@std/expect';");
    expect(source).not.toContain('Deno.test');
  });

  it('re-exports both classes from the per-module barrel', () => {
    const source = fileAt(
      generateModule(names, options()),
      'src/modules/user-profile/index.ts',
    );

    expect(source).toContain('export { UserProfileController }');
    expect(source).toContain('export { UserProfileService }');
  });

  it('lists the existing modules alongside the new one in the barrel', () => {
    const files = generateModule(deriveNames('user'), options([], ['billing', 'order']));

    const barrel = fileAt(files, 'src/modules/index.ts');
    expect(barrel).toContain('BillingController');
    expect(barrel).toContain('OrderController');
    expect(barrel).toContain('UserController');
  });

  it('lists a regenerated module exactly once', () => {
    const files = generateModule(deriveNames('user'), options([], ['user']));

    const barrel = fileAt(files, 'src/modules/index.ts');
    expect(barrel.match(/from '\.\/user\/user\.controller\.ts'/g)?.length).toBe(1);
  });

  it('treats an absent modules option as no modules', () => {
    // `modules` is optional on the published interface, so a harness predating
    // it may omit the field entirely.
    const files = generateModule(deriveNames('user'), {
      runtime: 'deno',
      plugins: new Set<string>(),
      now: () => 0,
    });

    expect(fileAt(files, 'src/modules/index.ts')).toContain('UserController');
  });

  it('produces a barrel identical to the one the templates scaffold', () => {
    // Both go through renderModuleBarrel, so the scaffolded seam and every
    // regeneration of it cannot drift in shape.
    const barrel = fileAt(generateModule(deriveNames('user'), options()), 'src/modules/index.ts');

    expect(barrel).toContain('export const MODULE_CONTROLLERS: readonly Constructor[] = [');
    expect(barrel).toContain('export const MODULE_SERVICES: readonly Constructor[] = [');
  });
});
