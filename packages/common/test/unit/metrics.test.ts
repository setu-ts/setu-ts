/**
 * Unit tests for the metrics contracts in @setu-ts/common.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricOptions,
} from '../../src/index.ts';

describe('metrics contracts', () => {
  it('a stub satisfies IMetricsService and every instrument it returns', () => {
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

    expect(stub.counter('c').type).toBe('counter');
    expect(stub.gauge('g').type).toBe('gauge');
    expect(stub.histogram('h').type).toBe('histogram');
    expect(stub.summary('s').type).toBe('summary');
    expect(stub.get('missing')).toBeUndefined();
  });

  it('ICounter carries the IMetric fields and a value-first observe/inc', () => {
    const observed: number[] = [];
    const incremented: number[] = [];
    const counter: ICounter = {
      name: 'test',
      type: 'counter',
      help: 'test',
      observe(value?: number): void {
        observed.push(value ?? 1);
      },
      inc(value?: number): void {
        incremented.push(value ?? 1);
      },
    };

    counter.observe(123);
    counter.inc(456);
    counter.inc();

    expect(counter.name).toBe('test');
    expect(counter.type).toBe('counter');
    expect(observed).toEqual([123]);
    expect(incremented).toEqual([456, 1]);
  });

  it('IGauge adds set/dec on top of the counter surface', () => {
    const calls: string[] = [];
    const gauge: IGauge = {
      name: 'test',
      type: 'gauge',
      help: 'test',
      observe(value?: number): void {
        calls.push(`observe:${value}`);
      },
      set(value: number): void {
        calls.push(`set:${value}`);
      },
      inc(value?: number): void {
        calls.push(`inc:${value ?? 1}`);
      },
      dec(value?: number): void {
        calls.push(`dec:${value ?? 1}`);
      },
    };

    gauge.observe(123);
    gauge.set(456);
    gauge.inc(1);
    gauge.dec(1);

    expect(gauge.type).toBe('gauge');
    expect(calls).toEqual(['observe:123', 'set:456', 'inc:1', 'dec:1']);
  });

  it('IHistogram requires a value on observe and exposes its buckets', () => {
    const observed: number[] = [];
    const histogram: IHistogram = {
      name: 'test',
      type: 'histogram',
      help: 'test',
      observe(value: number): void {
        observed.push(value);
      },
      buckets: [0.1, 0.5, 1],
    };

    histogram.observe(123);

    expect(histogram.buckets).toEqual([0.1, 0.5, 1]);
    expect(observed).toEqual([123]);
  });

  it('ISummary requires a value on observe and exposes its quantiles', () => {
    const observed: number[] = [];
    const summary: ISummary = {
      name: 'test',
      type: 'summary',
      help: 'test',
      observe(value: number): void {
        observed.push(value);
      },
      quantiles: [0.5, 0.9, 0.99],
    };

    summary.observe(123);

    expect(summary.quantiles).toEqual([0.5, 0.9, 0.99]);
    expect(observed).toEqual([123]);
  });
});
