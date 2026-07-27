/**
 * Unit tests for the metric schematic (gated on metrics-plugin).
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateMetric } from '../../../src/schematics/metric.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('generateMetric', () => {
  it('emits a metric registration file', () => {
    const names = deriveNames('request');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateMetric(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/metrics/request.metric.ts');
    expect(files[0].contents).toContain('registerRequestMetric');
  });

  it('imports Counter from common', () => {
    const names = deriveNames('request');
    const options = { runtime: {} as unknown, plugins: new Set<string>() };
    const files = generateMetric(names, options);

    expect(files[0].contents).toContain("from '@hono-enterprise/common'");
  });
});
