/**
 * Tests for barrel exports.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as healthPlugin from '../../src/index.ts';

describe('Barrel exports', () => {
  it('should export HealthPlugin', () => {
    expect(healthPlugin.HealthPlugin).toBeDefined();
    expect(typeof healthPlugin.HealthPlugin).toBe('function');
  });

  it('should export HealthService', () => {
    expect(healthPlugin.HealthService).toBeDefined();
    expect(typeof healthPlugin.HealthService).toBe('function');
  });

  it('should export createHttpIndicator', () => {
    expect(healthPlugin.createHttpIndicator).toBeDefined();
    expect(typeof healthPlugin.createHttpIndicator).toBe('function');
  });

  it('should have all expected exports', () => {
    const expectedExports = [
      'HealthPlugin',
      'HealthService',
      'createHttpIndicator',
    ];

    for (const exportName of expectedExports) {
      expect(healthPlugin, `Should export ${exportName}`).toHaveProperty(exportName);
    }
  });
});
