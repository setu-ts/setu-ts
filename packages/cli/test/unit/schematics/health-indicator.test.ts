import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateHealthIndicator } from '../../../src/schematics/health-indicator.ts';
import { gateOf, options } from './_shared.ts';

describe('health-indicator schematic', () => {
  const files = generateHealthIndicator(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/health/order-item.indicator.ts', () => {
    expect(file.path).toBe('src/health/order-item.indicator.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on health-plugin', () => {
    expect(gateOf('health-indicator')).toBe('health-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateHealthIndicator(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('implements IHealthIndicator with the committed check() method', () => {
    expect(file.contents).toContain('implements IHealthIndicator');
    expect(file.contents).toContain('check(): Promise<HealthCheckResult>');
  });

  it('reports a HealthStatus from the committed union', () => {
    expect(file.contents).toContain("status: 'up'");
  });

  it('names the indicator after the kebab form', () => {
    expect(file.contents).toContain("readonly name = 'order-item';");
  });
});
