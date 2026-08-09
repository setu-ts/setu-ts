import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveNames } from '../../../src/utils/names.ts';
import { generateMetric } from '../../../src/schematics/metric.ts';
import { artifactOf, assertSeamContract, barrelOf, gateOf, options } from './_shared.ts';

describe('metric schematic', () => {
  const files = generateMetric(deriveNames('order-item'), options());
  const file = artifactOf(files, 'metric');

  it('emits the metric plus its seam barrel', () => {
    expect(files.map((f) => f.path)).toEqual([
      'src/metrics/order-item.metric.ts',
      'src/metrics/index.ts',
    ]);
  });

  it('satisfies the seam contract', () => {
    assertSeamContract('metric', 'order-item', ['gizmo', 'billing']);
  });

  // `MetricsPluginOptions.customMetrics` takes `NamedMetricConfig`, not a factory, so the
  // module carries BOTH: the config is how the metric exists at boot (visible in
  // /metrics before anything samples it), the accessor is how code increments it.
  it('emits the NamedMetricConfig the plugin option actually takes', () => {
    expect(file.contents).toContain('export const ORDER_ITEM_METRIC: NamedMetricConfig = {');
    expect(file.contents).toContain("type: 'counter',");
    expect(file.contents).toContain(
      `import type { NamedMetricConfig } from '@setu-ts/metrics-plugin';`,
    );
    expect(barrelOf(files, 'metric').contents).toContain('ORDER_ITEM_METRIC');
    expect(barrelOf(files, 'metric').contents).toContain('readonly NamedMetricConfig[]');
  });

  it('reads help and labels from the declaration, so they have one home', () => {
    expect(file.contents).toContain('metrics.counter(ORDER_ITEM_TOTAL, ORDER_ITEM_METRIC)');
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
