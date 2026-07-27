/**
 * Unit tests for the middleware schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMiddleware } from '../../../src/schematics/middleware.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMiddleware', () => {
  it('emits a middleware factory', () => {
    const names = deriveNames('auth');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMiddleware(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/middleware/auth.middleware.ts');
    expect(files[0].contents).toContain('AuthMiddleware');
  });

  it('calls next in middleware', () => {
    const names = deriveNames('cache');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMiddleware(names, options);

    expect(files[0].contents).toContain('next()');
  });
});
