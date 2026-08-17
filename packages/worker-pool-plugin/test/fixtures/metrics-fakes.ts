/**
 * A recording `IMetricsService` double for the worker-pool collector tests.
 *
 * It reproduces the two contract properties the collector actually depends on,
 * rather than being a bag of stubs: `counter`/`gauge` are **get-or-create**
 * (the same name returns the same instrument, as `MetricsService` does), and
 * `inc` ACCUMULATES per label set while `set` REPLACES. A double that reset on
 * every call, or handed back a fresh instrument each time, would make a
 * double-counting bug pass.
 *
 * The real `MetricsService` is still exercised end to end by
 * `test/integration/worker-pool-metrics-app.test.ts`, so this fake is never
 * the only path the suite runs (CLAUDE.md's contract-violating-double rule).
 *
 * @module
 */
import type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricOptions,
  MetricType,
} from '@setu-ts/common';

/** Serializes a label set to a stable key (label names sorted). */
export function labelKey(labels?: Readonly<Record<string, string>>): string {
  if (labels === undefined) {
    return '';
  }
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(',');
}

/** One recorded instrument and its per-label-set values. */
export class RecordedMetric implements ICounter, IGauge {
  readonly values = new Map<string, number>();
  /** Every write in order, for assertions about call counts. */
  readonly writes: { readonly labels: string; readonly value: number }[] = [];

  constructor(
    readonly name: string,
    readonly type: MetricType,
    readonly help: string,
    readonly labels: readonly string[],
  ) {}

  observe(value = 1, labels?: Readonly<Record<string, string>>): void {
    this.set(value, labels);
  }

  set(value: number, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);
    this.values.set(key, value);
    this.writes.push({ labels: key, value });
  }

  inc(value = 1, labels?: Readonly<Record<string, string>>): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
    this.writes.push({ labels: key, value });
  }

  dec(value = 1, labels?: Readonly<Record<string, string>>): void {
    this.inc(-value, labels);
  }

  /** Reads one label set's current value (`0` when never written). */
  valueFor(labels?: Readonly<Record<string, string>>): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  /** Sums every label set — used to compare a counter against `stats()`. */
  total(): number {
    let sum = 0;
    for (const value of this.values.values()) {
      sum += value;
    }
    return sum;
  }
}

/** Recording `IMetricsService` with real get-or-create semantics. */
export class RecordingMetrics implements IMetricsService {
  readonly metrics = new Map<string, RecordedMetric>();

  counter(name: string, options?: MetricOptions): ICounter {
    return this.#getOrCreate(name, 'counter', options);
  }

  gauge(name: string, options?: MetricOptions): IGauge {
    return this.#getOrCreate(name, 'gauge', options);
  }

  histogram(name: string, options?: MetricOptions): IHistogram {
    const metric = this.#getOrCreate(name, 'histogram', options);
    return Object.assign(metric, { buckets: options?.buckets ?? [] }) as unknown as IHistogram;
  }

  summary(name: string, options?: MetricOptions): ISummary {
    const metric = this.#getOrCreate(name, 'summary', options);
    return Object.assign(metric, { quantiles: options?.quantiles ?? [] }) as unknown as ISummary;
  }

  get(name: string): IMetric | undefined {
    return this.metrics.get(name);
  }

  /** Reads a recorded instrument by name, failing loudly when absent. */
  require(name: string): RecordedMetric {
    const metric = this.metrics.get(name);
    if (metric === undefined) {
      throw new Error(`No metric named '${name}' was created`);
    }
    return metric;
  }

  #getOrCreate(name: string, type: MetricType, options?: MetricOptions): RecordedMetric {
    const existing = this.metrics.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created = new RecordedMetric(name, type, options?.help ?? name, options?.labels ?? []);
    this.metrics.set(name, created);
    return created;
  }
}
