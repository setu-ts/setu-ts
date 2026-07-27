/**
 * Unit tests for the health-indicator schematic (gated on health-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateHealthIndicator } from '../../../src/schematics/health-indicator.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateHealthIndicator', () => {
  it('emits a health indicator file implementing the interface', () => {
    const names = deriveNames('database');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateHealthIndicator(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/health/database.indicator.ts');
    expect(files[0].contents).toContain('implements IHealthIndicator');
  });

  it('includes the name property', () => {
    const names = deriveNames('cache');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateHealthIndicator(names, options);

    expect(files[0].contents).toContain("name = 'cache'");
  });
});
