import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMetric } from '../../../src/schematics/metric.ts';
import { gateOf, options } from './_shared.ts';

describe('metric schematic', () => {
  const files = generateMetric(deriveNames('order-item'), options());
  const [file] = files;

  it('emits exactly one file', () => {
    expect(files).toHaveLength(1);
  });

  it('emits it at src/metrics/order-item.metric.ts', () => {
    expect(file.path).toBe('src/metrics/order-item.metric.ts');
  });

  it('produces non-empty contents ending in a newline', () => {
    expect(file.contents.length).toBeGreaterThan(0);
    expect(file.contents.endsWith('\n')).toBe(true);
  });

  it('is gated on metrics-plugin', () => {
    expect(gateOf('metric')).toBe('metrics-plugin');
  });

  it('derives identical output from any casing of the same name', () => {
    const pascal = generateMetric(deriveNames('OrderItem'), options());
    expect(pascal).toEqual(files);
  });

  it('resolves IMetricsService from the metrics capability token', () => {
    expect(file.contents).toContain('services.get<IMetricsService>(CAPABILITIES.METRICS)');
  });

  it('uses a Prometheus snake_case metric name', () => {
    expect(file.contents).toContain("export const ORDER_ITEM_TOTAL = 'order_item_total';");
  });
});
