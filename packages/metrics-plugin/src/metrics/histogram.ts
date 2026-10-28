/**
 * Histogram implementation — bucketed observation distribution.
 *
 * @module
 */
import type { MetricConfig } from '@setu-ts/common';
import { MetricBase } from './base-metric.ts';

/**
 * Default histogram buckets for durations in seconds.
 */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * A histogram metric — bucketed observations with sum and count.
 *
 * `observe()` records a sample value into the appropriate bucket.
 */
interface HistogramData {
  /**
   * Cumulative count per distinct boundary, in ascending order, then `+Inf`
   * last. A typed array, not a `Map`: an observation increments a run of
   * slots instead of one `Map` read and write per bucket.
   */
  counts: Float64Array;
  sum: number;
  count: number;
  labels?: Readonly<Record<string, string>>;
}

export class Histogram extends MetricBase {
  readonly #buckets: readonly number[];
  /** The distinct boundaries — a repeated one is one `le` bucket, counted once. */
  readonly #bounds: readonly number[];
  readonly #bucketCounts = new Map<string, HistogramData>();

  /**
   * Creates a new histogram.
   *
   * @param name - Metric name
   * @param config - The metric configuration
   * @param buckets - Bucket boundaries (uses default if absent)
   */
  constructor(name: string, config: MetricConfig, buckets?: readonly number[]) {
    super(name, config);
    const rawBuckets = buckets ?? config.buckets ?? DEFAULT_BUCKETS;
    // Ensure buckets are sorted
    if (rawBuckets.length > 0) {
      const sorted = [...rawBuckets].sort((a, b) => a - b);
      if (sorted[0] < 0) {
        throw new Error(`Histogram "${this.name}" cannot have negative bucket boundaries`);
      }
      this.#buckets = sorted;
    } else {
      this.#buckets = rawBuckets;
    }
    this.#bounds = [...new Set(this.#buckets)];
  }

  /**
   * The bucket boundaries.
   */
  get buckets(): readonly number[] {
    return this.#buckets;
  }

  /**
   * Records an observation.
   *
   * @param value - The observed value
   * @param labels - Label values keyed by label name
   */
  observe(value: number, labels?: Readonly<Record<string, string>>): void {
    const snapshot = this.snapshotLabels(labels);
    const key = this.seriesKey(snapshot);

    let data = this.#bucketCounts.get(key);
    if (data === undefined) {
      data = { counts: new Float64Array(this.#bounds.length + 1), sum: 0, count: 0 };
      if (snapshot) {
        data.labels = snapshot;
      }
      this.#bucketCounts.set(key, data);
    }

    data.sum += value;
    data.count++;

    // Cumulative: every bucket whose boundary is >= value, i.e. the run from
    // the first such boundary to the end. `!(value <= bound)` rather than
    // `value > bound`, so a NaN reaches no finite bucket, as before.
    const bounds = this.#bounds;
    const counts = data.counts;
    let index = 0;
    while (index < bounds.length && !(value <= bounds[index]!)) index++;
    for (; index < bounds.length; index++) counts[index]!++;
    // +Inf always counts the observation.
    counts[bounds.length]!++;
  }

  /**
   * Gets the bucket counts for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns A map of bucket boundaries to counts
   */
  getBucketCounts(labels?: Readonly<Record<string, string>>): ReadonlyMap<number, number> {
    const key = this.labelKey(labels);
    const data = this.#bucketCounts.get(key);
    if (!data) {
      return new Map();
    }
    return this.#bucketMap(data.counts);
  }

  /**
   * Gets all bucket counts for all observed label sets.
   *
   * @returns A map of label keys to their bucket counts, sum, and count
   */
  getAllBucketCounts(): ReadonlyMap<
    string,
    {
      buckets: ReadonlyMap<number, number>;
      sum: number;
      count: number;
      labels?: Readonly<Record<string, string>>;
    }
  > {
    const result = new Map<
      string,
      {
        buckets: ReadonlyMap<number, number>;
        sum: number;
        count: number;
        labels?: Readonly<Record<string, string>>;
      }
    >();
    for (const [key, data] of this.#bucketCounts.entries()) {
      const entry: {
        buckets: ReadonlyMap<number, number>;
        sum: number;
        count: number;
        labels?: Readonly<Record<string, string>>;
      } = {
        buckets: this.#bucketMap(data.counts),
        sum: data.sum,
        count: data.count,
      };
      if (data.labels) {
        entry.labels = data.labels;
      }
      result.set(key, entry);
    }
    return result;
  }

  /**
   * Gets the sum for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The sum of all observations
   */
  getSum(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    const data = this.#bucketCounts.get(key);
    return data?.sum ?? 0;
  }

  /**
   * Gets the count for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The count of all observations
   */
  getCount(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    const data = this.#bucketCounts.get(key);
    return data?.count ?? 0;
  }

  /**
   * The read shape callers have always received: boundary → cumulative count
   * in ascending order, `+Inf` last, as a fresh `Map` they may keep.
   */
  #bucketMap(counts: Float64Array): Map<number, number> {
    const bounds = this.#bounds;
    const map = new Map<number, number>();
    for (let index = 0; index < bounds.length; index++) {
      map.set(bounds[index]!, counts[index]!);
    }
    map.set(Number.POSITIVE_INFINITY, counts[bounds.length]!);
    return map;
  }
}
