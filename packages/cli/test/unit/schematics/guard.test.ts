/**
 * Unit tests for the guard schematic (gated on auth-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateGuard } from '../../../src/schematics/guard.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateGuard', () => {
  it('emits a guard file requiring auth-plugin', () => {
    const names = deriveNames('auth');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateGuard(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/guards/auth.guard.ts');
    expect(files[0].contents).toContain('IRequestContext');
    expect(files[0].contents).toContain('requireAuth');
  });

  it('exports the correct require function', () => {
    const names = deriveNames('cache');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateGuard(names, options);

    expect(files[0].contents).toContain('requireCache');
  });
});
