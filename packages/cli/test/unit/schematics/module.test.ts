import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { generateModule } from '../../../src/schematics/module.ts';
import { gateOf, options } from './_shared.ts';
import { deriveNames } from '../../../src/utils/names.ts';

describe('generateModule', () => {
  it('is available in the functional default', () => {
    expect(gateOf('module')).toBeUndefined();
    const files = generateModule(deriveNames('user-profile'), options());

    expect(files.map((file) => file.path)).toEqual([
      'src/modules/user-profile/user-profile.service.ts',
      'src/modules/user-profile/user-profile.service.test.ts',
      'src/modules/user-profile/index.ts',
      'src/routes/user-profile.routes.ts',
      'src/routes/index.ts',
    ]);
    expect(files[0].contents).toContain('export function listUserProfile');
    expect(files[3].contents).toContain('registerUserProfileRoutes');
    expect(files[3].contents).toContain('status(201)');
    expect(files[4].managed).toBe(true);
  });

  it('preserves class modules when both opt-in packages are installed', () => {
    const files = generateModule(
      deriveNames('user-profile'),
      options(['decorator-plugin', 'di-plugin']),
    );

    expect(files.map((file) => file.path)).toContain(
      'src/modules/user-profile/user-profile.controller.ts',
    );
    const controller = files.find((file) => file.path.endsWith('.controller.ts'));
    expect(controller?.contents).toContain("@Inject('user-profile-service')");
    expect(controller?.contents).toContain('@Ctx() ctx: IRequestContext');
    expect(controller?.contents).toContain('status(201)');
  });
});
