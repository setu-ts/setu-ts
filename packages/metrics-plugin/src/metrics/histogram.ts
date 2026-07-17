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
export class Histogram extends MetricBase {
  readonly #buckets: readonly number[];
  readonly #bucketCounts = new Map<string, Map<number, number>>();
  readonly #sums = new Map<string, number>();
  readonly #counts = new Map<string, number>();

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
      this.#bucketCounts.set(key, bucketCounts);
      this.#sums.set(key, 0);
      this.#counts.set(key, 0);
    }

    const bucketCounts = this.#bucketCounts.get(key)!;
    let sum = this.#sums.get(key)!;
    let count = this.#counts.get(key)!;

    // Update sum and count
    sum += value;
    count++;

    // Find all buckets where value <= bound (cumulative counts)
    for (const bound of this.#buckets) {
      const current = bucketCounts.get(bound) ?? 0;
      if (value <= bound) {
        bucketCounts.set(bound, current + 1);
      }
    }

    // Update +Inf bucket (always incremented for values > all buckets)
    const infCount = bucketCounts.get(Number.POSITIVE_INFINITY) ?? 0;
    bucketCounts.set(Number.POSITIVE_INFINITY, infCount + 1);

    this.#sums.set(key, sum);
    this.#counts.set(key, count);
  }

  /**
   * Gets the bucket counts for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns A map of bucket boundaries to counts
   */
  getBucketCounts(labels?: Readonly<Record<string, string>>): ReadonlyMap<number, number> {
    const key = this.labelKey(labels);
    const bucketCounts = this.#bucketCounts.get(key);
    if (!bucketCounts) {
      return new Map();
    }
    return new Map(bucketCounts);
  }

  /**
   * Gets the sum for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The sum of all observations
   */
  getSum(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    return this.#sums.get(key) ?? 0;
  }

  /**
   * Gets the count for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The count of all observations
   */
  getCount(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    return this.#counts.get(key) ?? 0;
  }
}
