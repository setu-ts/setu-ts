/**
 * Unit tests for the middleware schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMiddleware } from '../../../src/schematics/middleware.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMiddleware', () => {
  it('emits a middleware file with factory function', () => {
    const names = deriveNames('auth');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateMiddleware(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/middleware/auth.middleware.ts');
    expect(files[0].contents).toContain('AuthMiddleware');
    expect(files[0].contents).toContain('async (');
    expect(files[0].contents).toContain('ctx');
    expect(files[0].contents).toContain('next');
  });

  it('calls next() in the middleware', () => {
    const names = deriveNames('logging');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateMiddleware(names, options);

    expect(files[0].contents).toContain('await next()');
  });
});
