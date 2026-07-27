/**
 * Unit tests for the metric schematic (gated on metrics-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMetric } from '../../../src/schematics/metric.ts';
import { createFakeRuntime } from '../../../test/fixtures/fake-runtime.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMetric', () => {
  it('emits a metric registration using IMetricsService', () => {
    const names = deriveNames('request');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMetric(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/metrics/request.metric.ts');
    expect(files[0].contents).toContain('Counter');
    expect(files[0].contents).toContain('registerRequestMetric');
  });

  it('uses the correct metric name format', () => {
    const names = deriveNames('api-call');
    const options = { runtime: createFakeRuntime(), plugins: new Set<string>() };
    const files = generateMetric(names, options);

    expect(files[0].contents).toContain('ApiCallMetric');
  });
});
