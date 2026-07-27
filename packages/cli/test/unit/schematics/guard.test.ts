/**
 * Unit tests for the guard schematic (gated on auth-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateGuard } from '../../../src/schematics/guard.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateGuard', () => {
  it('emits a guard file with require function', () => {
    const names = deriveNames('admin');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateGuard(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/guards/admin.guard.ts');
    expect(files[0].contents).toContain('requireAdmin');
  });

  it('imports IRequestContext from common', () => {
    const names = deriveNames('admin');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateGuard(names, options);

    expect(files[0].contents).toContain("from '@hono-enterprise/common'");
  });
});
