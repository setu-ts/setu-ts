/**
 * Unit tests for the controller schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateController } from '../../../src/schematics/controller.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateController', () => {
  it('emits a controller file with decorator imports', () => {
    const names = deriveNames('user');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateController(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/controllers/user.controller.ts');
    expect(files[0].contents).toContain('@Controller');
    expect(files[0].contents).toContain('@Get');
    expect(files[0].contents).toContain('UserController');
  });

  it('uses the correct path based on kebab name', () => {
    const names = deriveNames('post-article');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateController(names, options);

    expect(files[0].path).toBe('src/controllers/post-article.controller.ts');
  });

  it('includes the GET handler method', () => {
    const names = deriveNames('product');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateController(names, options);

    expect(files[0].contents).toContain('GET()');
  });
});
