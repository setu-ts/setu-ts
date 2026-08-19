import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateHealthIndicator } from '../../../src/schematics/health-indicator.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

// A2: `health-plugin` ships with the `rest` template, so a project the CLI
// itself decided is FUNCTIONAL was getting the one class in an otherwise
// function-shaped project — and converting it by hand dropped it from the barrel
// and silently stopped the check running. Both shapes are pinned here.
const CLASS_OPTIONS = ['decorator-plugin'];

describe('health-indicator schematic', () => {
  const files = generateHealthIndicator(deriveNames('order-item'), options(CLASS_OPTIONS));
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

  it('references the factory by name, which is what HealthIndicatorEntry takes', () => {
    const barrel = barrelOf(
      generateHealthIndicator(deriveNames('order-item'), options(CLASS_OPTIONS)),
      'health-indicator',
    );
    // The barrel writes no `new`: it names the artifact's factory, which is the
    // single construction site, and declares the widened entry type.
    expect(barrel.contents).toContain('createOrderItemHealthIndicator');
    expect(barrel.contents).not.toContain('new ');
    expect(barrel.contents).toContain('readonly HealthIndicatorEntry[]');
    expect(barrel.contents).toContain(
      "import type { HealthIndicatorEntry } from '@setu-ts/health-plugin';",
    );
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on health-plugin', () => {
    expect(gateOf('health-indicator')).toBe('health-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateHealthIndicator(deriveNames('OrderItem'), options(CLASS_OPTIONS));
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

  it('emits a zero-parameter factory with a written-out return type', () => {
    // The factory is the single construction site; a written-out return type is
    // required because an inferred one is a JSR slow type.
    expect(file.contents).toContain(
      'export function createOrderItemHealthIndicator(): OrderItemHealthIndicator {',
    );
    expect(file.contents).toContain('return new OrderItemHealthIndicator();');
    expect(file.contents).toContain('export class OrderItemHealthIndicator');
  });
});

describe('health-indicator schematic — functional mode', () => {
  const files = generateHealthIndicator(deriveNames('order-item'), options());
  const file = artifactOf(files, 'health-indicator');

  it('emits a VALUE, not a class', () => {
    // `IHealthIndicator` is only an interface, so `{ name, check }` satisfies it
    // — the class was the CLI's choice, not the contract's.
    expect(file.contents).toContain('export const orderItemIndicator: IHealthIndicator = {');
    expect(file.contents).not.toContain('export class');
    expect(file.contents).not.toContain('implements IHealthIndicator');
  });

  it('names the indicator after the kebab form, as the class shape does', () => {
    expect(file.contents).toContain("name: 'order-item',");
  });

  it('keeps the committed check() signature across both shapes', () => {
    expect(file.contents).toContain('check(): Promise<HealthCheckResult>');
    expect(file.contents).toContain("status: 'up'");
  });

  it('references the factory in the barrel rather than constructing it', () => {
    const barrel = barrelOf(files, 'health-indicator');
    // The barrel writes no `new`: it names the artifact's factory, which returns
    // the value.
    expect(barrel.contents).toContain('createOrderItemIndicator');
    expect(barrel.contents).not.toContain('new ');
    expect(barrel.contents).toContain('readonly HealthIndicatorEntry[]');
  });

  it('imports the factory symbol, so the scanner admits its own output', () => {
    const barrel = barrelOf(files, 'health-indicator');
    expect(barrel.contents).toContain(
      "import { createOrderItemIndicator } from './order-item.indicator.ts';",
    );
  });

  it('emits a zero-parameter factory that returns the value', () => {
    // The factory is the single construction site; a written-out return type is
    // required because an inferred one is a JSR slow type.
    expect(file.contents).toContain(
      'export function createOrderItemIndicator(): IHealthIndicator {',
    );
    expect(file.contents).toContain('return orderItemIndicator;');
  });

  it('tells the reader it is already wired, in both shapes', () => {
    expect(file.contents).toContain('HEALTH_INDICATORS');
    expect(file.contents).toContain('needs no further wiring');
  });
});
