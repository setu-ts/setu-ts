import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateHealthIndicator } from '../../../src/schematics/health-indicator.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('health-indicator schematic', () => {
  const files = generateHealthIndicator(deriveNames('order-item'), options());
  const file = artifactOf(files, 'health-indicator');

  it('emits the indicator plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/health/order-item.indicator.ts',
      'src/health/index.ts',
    ]);
  });

  it('emits it at src/health/order-item.indicator.ts', () => {
    expect(file.path).toBe('src/health/order-item.indicator.ts');
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('health-indicator', 'order-item', ['gizmo', 'billing']);
  });

  it('registers instances, which is what HealthPluginOptions.indicators takes', () => {
    const barrel = barrelOf(
      generateHealthIndicator(deriveNames('order-item'), options()),
      'health-indicator',
    );
    // The plugin reads `.name` and binds `.check` off each entry, so a constructor
    // would not satisfy the option's own type.
    expect(barrel.contents).toContain('new OrderItemHealthIndicator()');
    expect(barrel.contents).toContain('readonly IHealthIndicator[]');
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

  it('tells the reader it is already wired, not how to wire it', () => {
    expect(file.contents).toContain('HEALTH_INDICATORS');
    expect(file.contents).toContain('needs no further wiring');
  });
});
