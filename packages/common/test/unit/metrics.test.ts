/**
 * Unit tests for the metrics contracts in @hono-enterprise/common.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricOptions,
} from '../../src/index.ts';

Deno.test('metrics types — types compile-resolve from the barrel', () => {
  // This test exists to ensure the types compile-resolve from the barrel.
  // If the imports above fail, this file won't compile.
  const _types: Array<unknown> = [];
  // Force type references at runtime (no-op, just for type checking)
  void _types;
});

Deno.test('metrics types — stub satisfies IMetricsService', () => {
  const stub: IMetricsService = {
    counter(_name: string, _options?: MetricOptions): ICounter {
      return {
        name: 'test_counter',
        type: 'counter',
        help: 'test',
        observe(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
        inc(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
      };
    },
    gauge(_name: string, _options?: MetricOptions): IGauge {
      return {
        name: 'test_gauge',
        type: 'gauge',
        help: 'test',
        observe(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
        set(_value: number, _labels?: Readonly<Record<string, string>>): void {},
        inc(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
        dec(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
      };
    },
    histogram(_name: string, _options?: MetricOptions): IHistogram {
      return {
        name: 'test_histogram',
        type: 'histogram',
        help: 'test',
        observe(_value: number, _labels?: Readonly<Record<string, string>>): void {},
        buckets: [1, 2, 3],
      };
    },
    summary(_name: string, _options?: MetricOptions): ISummary {
      return {
        name: 'test_summary',
        type: 'summary',
        help: 'test',
        observe(_value: number, _labels?: Readonly<Record<string, string>>): void {},
        quantiles: [0.5, 0.9, 0.99],
      };
    },
    get(_name: string): IMetric | undefined {
      return undefined;
    },
  };

  assertEquals(typeof stub.counter, 'function');
  assertEquals(typeof stub.gauge, 'function');
  assertEquals(typeof stub.histogram, 'function');
  assertEquals(typeof stub.summary, 'function');
  assertEquals(typeof stub.get, 'function');
});

Deno.test('metrics types — ICounter extends IMetric with value-first observe', () => {
  const counter: ICounter = {
    name: 'test',
    type: 'counter',
    help: 'test',
    observe(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
    inc(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
  };

  // Value-first signature: observe(123) should work
  counter.observe(123);
  counter.inc(456);

  assertEquals(counter.name, 'test');
  assertEquals(counter.type, 'counter');
});

Deno.test('metrics types — IGauge extends IMetric with value-first observe', () => {
  const gauge: IGauge = {
    name: 'test',
    type: 'gauge',
    help: 'test',
    observe(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
    set(_value: number, _labels?: Readonly<Record<string, string>>): void {},
    inc(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
    dec(_value?: number, _labels?: Readonly<Record<string, string>>): void {},
  };

  // Value-first signature
  gauge.observe(123);
  gauge.set(456);
  gauge.inc(1);
  gauge.dec(1);

  assertEquals(gauge.type, 'gauge');
});

Deno.test('metrics types — IHistogram extends IMetric with value-first observe', () => {
  const histogram: IHistogram = {
    name: 'test',
    type: 'histogram',
    help: 'test',
    observe(_value: number, _labels?: Readonly<Record<string, string>>): void {},
    buckets: [0.1, 0.5, 1],
  };

  // Value-first signature: observe requires a value
  histogram.observe(123);

  assertEquals(histogram.buckets.length, 3);
});

Deno.test('metrics types — ISummary extends IMetric with value-first observe', () => {
  const summary: ISummary = {
    name: 'test',
    type: 'summary',
    help: 'test',
    observe(_value: number, _labels?: Readonly<Record<string, string>>): void {},
    quantiles: [0.5, 0.9, 0.99],
  };

  // Value-first signature: observe requires a value
  summary.observe(123);

  assertEquals(summary.quantiles.length, 3);
});
