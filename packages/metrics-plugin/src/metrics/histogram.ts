/**
 * Histogram implementation — bucketed observation distribution.
 *
 * @module
 */
import type { MetricConfig } from '@hono-enterprise/common';
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
  bucketCounts: Map<number, number>;
  sum: number;
  count: number;
  labels?: Readonly<Record<string, string>>;
}

export class Histogram extends MetricBase {
  readonly #buckets: readonly number[];
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
    this.validateLabels(labels);
    const key = this.labelKey(labels);

    // Initialize per-label-set storage
    if (!this.#bucketCounts.has(key)) {
      const bucketCounts = new Map<number, number>();
      // Initialize all buckets to 0
      for (const bound of this.#buckets) {
        bucketCounts.set(bound, 0);
      }
      bucketCounts.set(Number.POSITIVE_INFINITY, 0);
      const data: HistogramData = { bucketCounts, sum: 0, count: 0 };
      if (labels) {
        data.labels = { ...labels }; // Defensive shallow copy
      }
      this.#bucketCounts.set(key, data);
    }

    const data = this.#bucketCounts.get(key)!;
    let sum = data.sum;
    let count = data.count;

    const bucketCounts = data.bucketCounts;

    // Update sum and count
    sum += value;
    count++;

    // Find all buckets where value <= bound (cumulative counts)
    for (const bound of this.#buckets) {
      if (value <= bound) {
        bucketCounts.set(bound, bucketCounts.get(bound)! + 1);
      }
    }

    // Update +Inf bucket (always incremented for values > all buckets)
    bucketCounts.set(Number.POSITIVE_INFINITY, bucketCounts.get(Number.POSITIVE_INFINITY)! + 1);

    data.sum = sum;
    data.count = count;
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
    return new Map(data.bucketCounts);
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
        buckets: new Map(data.bucketCounts),
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
}
