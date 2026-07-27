/**
 * Unit tests for the route schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateRoute } from '../../../src/schematics/route.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateRoute', () => {
  it('emits a routes file with registration function', () => {
    const names = deriveNames('user');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateRoute(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/routes/user.routes.ts');
    expect(files[0].contents).toContain('registerUserRoutes');
    expect(files[0].contents).toContain('ctx.router.get');
  });

  it('registers route at the kebab path', () => {
    const names = deriveNames('post-article');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateRoute(names, options);

    expect(files[0].contents).toContain('/post-article');
  });
});
