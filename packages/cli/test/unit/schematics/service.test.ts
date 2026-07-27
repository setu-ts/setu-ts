/**
 * Unit tests for the service schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateService } from '../../../src/schematics/service.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateService', () => {
  it('emits a service file with correct class name', () => {
    const names = deriveNames('auth');
    const options = { runtime: {} as IRuntimeServices, plugins: new Set<string>() };
    const files = generateService(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/services/auth.service.ts');
    expect(files[0].contents).toContain('AuthService');
  });

  it('includes a default get method', () => {
    const names = deriveNames('user');
    const options = { runtime: {} as IRuntimeServices, plugins: new Set<string>() };
    const files = generateService(names, options);

    expect(files[0].contents).toContain('get()');
  });
});
