/**
 * Unit tests for the health-indicator schematic (gated on health-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateHealthIndicator } from '../../../src/schematics/health-indicator.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateHealthIndicator', () => {
  it('emits a health indicator implementing IHealthIndicator', () => {
    const names = deriveNames('health');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateHealthIndicator(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/health/health.indicator.ts');
    expect(files[0].contents).toContain('IHealthIndicator');
    expect(files[0].contents).toContain('HealthIndicator');
  });

  it('returns the correct health status shape', () => {
    const names = deriveNames('cache');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateHealthIndicator(names, options);

    expect(files[0].contents).toContain('healthy: true');
    expect(files[0].contents).toContain('status');
  });
});
