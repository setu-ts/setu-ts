/**
 * The health-indicator seam: the barrel writes no `new` and references each
 * artifact's factory by name.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  FUNCTIONAL_HEALTH_SEAM,
  HEALTH_SEAM,
  indicatorClassFactorySymbol,
  indicatorValueFactorySymbol,
} from '../../../src/seams/health.ts';
import { deriveNames } from '../../../src/utils/names.ts';

describe('health seam', () => {
  it('class-based: the barrel references the factory, declares the entry type, and writes no new', () => {
    const barrel = HEALTH_SEAM.renderBarrel({
      'health-indicator': ['order-item', 'billing'],
    });
    expect(barrel).toContain('createOrderItemHealthIndicator');
    expect(barrel).toContain('createBillingHealthIndicator');
    expect(barrel).not.toContain('new ');
    expect(barrel).toContain('readonly HealthIndicatorEntry[]');
    expect(barrel).toContain("import type { HealthIndicatorEntry } from '@setu-ts/health-plugin';");
  });

  it('functional: the barrel references the factory and writes no new', () => {
    const barrel = FUNCTIONAL_HEALTH_SEAM.renderBarrel({
      'health-indicator': ['order-item'],
    });
    expect(barrel).toContain('createOrderItemIndicator');
    expect(barrel).not.toContain('new ');
    expect(barrel).toContain('readonly HealthIndicatorEntry[]');
    expect(barrel).toContain("import type { HealthIndicatorEntry } from '@setu-ts/health-plugin';");
  });

  it('importSymbols returns the factory symbol in each mode', () => {
    const names = deriveNames('order-item');
    expect(HEALTH_SEAM.importSymbols(names)).toEqual(['createOrderItemHealthIndicator']);
    expect(FUNCTIONAL_HEALTH_SEAM.importSymbols(names)).toEqual(['createOrderItemIndicator']);
  });

  it('the factory symbol helpers agree with importSymbols', () => {
    const names = deriveNames('order-item');
    expect(HEALTH_SEAM.importSymbols(names)[0]).toBe(indicatorClassFactorySymbol(names));
    expect(FUNCTIONAL_HEALTH_SEAM.importSymbols(names)[0]).toBe(indicatorValueFactorySymbol(names));
  });

  it('keeps names sorted regardless of input order', () => {
    const barrel = HEALTH_SEAM.renderBarrel({
      'health-indicator': ['zeta', 'alpha'],
    });
    const alpha = barrel.indexOf('createAlphaHealthIndicator');
    const zeta = barrel.indexOf('createZetaHealthIndicator');
    expect(alpha).toBeGreaterThan(-1);
    expect(zeta).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(zeta);
  });

  it('renders an empty-family barrel that still declares the export', () => {
    const empty = HEALTH_SEAM.renderBarrel({});
    expect(empty).toContain('export const HEALTH_INDICATORS');
    expect(empty).toContain('readonly HealthIndicatorEntry[]');
    expect(empty).not.toContain('new ');
  });
});
