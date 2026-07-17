/**
 * Summary implementation — per-quantile observations with bounded window.
 *
 * @module
 */
import type { MetricConfig } from '@hono-enterprise/common';
import { MetricBase } from './base-metric.ts';

/**
 * Default summary quantiles.
 */
const DEFAULT_QUANTILES = [0.5, 0.9, 0.99];

/**
 * Default maximum samples for the sliding window.
 */
const DEFAULT_MAX_SAMPLES = 512;

/**
 * A summary metric — quantile observations with bounded sample window.
 *
 * `observe()` records a sample; quantiles are computed from the window.
 */
interface SummaryData {
  samples: number[];
  sum: number;
  count: number;
  labels?: Readonly<Record<string, string>>;
}

export class Summary extends MetricBase {
  readonly #quantiles: readonly number[];
  readonly #maxSamples: number;
  readonly #data = new Map<string, SummaryData>();

  /**
   * Creates a new summary.
   *
   * @param name - Metric name
   * @param config - The metric configuration
   * @param quantiles - Quantiles to compute (defaults to [0.5, 0.9, 0.99])
   * @param maxSamples - Maximum samples to retain (defaults to 512)
   */
  constructor(
    name: string,
    config: MetricConfig,
    quantiles?: readonly number[],
    maxSamples?: number,
  ) {
    super(name, config);
    this.#quantiles = quantiles ?? DEFAULT_QUANTILES;
    this.#maxSamples = maxSamples ?? DEFAULT_MAX_SAMPLES;

    // Validate quantiles
    for (const q of this.#quantiles) {
      if (q < 0 || q > 1) {
        throw new Error(`Summary "${this.name}" has invalid quantile ${q} (must be 0-1)`);
      }
    }
  }

  /**
   * The quantiles.
   */
  get quantiles(): readonly number[] {
    return this.#quantiles;
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
    if (!this.#data.has(key)) {
      const data: SummaryData = { samples: [], sum: 0, count: 0 };
      if (labels) {
        data.labels = { ...labels }; // Defensive shallow copy
      }
      this.#data.set(key, data);
    }

    const data = this.#data.get(key)!;
    const samples = data.samples;
    let sum = data.sum;
    let count = data.count;

    // Add sample to window (bounded)
    samples.push(value);
    if (samples.length > this.#maxSamples) {
      samples.shift(); // Remove oldest sample
    }

    // Update sum and count
    sum += value;
    count++;

    data.sum = sum;
    data.count = count;
  }

  /**
   * Computes a quantile value from samples.
   *
   * @param samples - Sorted samples
   * @param quantile - The quantile to compute (0-1)
   * @returns The quantile value
   */
  private computeQuantile(samples: number[], quantile: number): number {
    if (samples.length === 0) {
      return NaN;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;

    // Use linear interpolation
    const pos = quantile * (n - 1);
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);

    if (lower === upper) {
      return sorted[lower];
    }

    const fraction = pos - lower;
    return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
  }

  /**
   * Gets the quantile values for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns A map of quantiles to values
   */
  getQuantiles(labels?: Readonly<Record<string, string>>): ReadonlyMap<number, number> {
    const key = this.labelKey(labels);
    const data = this.#data.get(key);

    if (!data || data.samples.length === 0) {
      return new Map();
    }

    const result = new Map<number, number>();
    for (const q of this.#quantiles) {
      result.set(q, this.computeQuantile(data.samples, q));
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
    const data = this.#data.get(key);
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
    const data = this.#data.get(key);
    return data?.count ?? 0;
  }

  /**
   * Gets the current sample window size.
   *
   * @param labels - Label values keyed by label name
   * @returns The number of samples in the window
   */
  getSampleCount(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    const data = this.#data.get(key);
    return data?.samples.length ?? 0;
  }

  /**
   * Gets all quantile data for all observed label sets.
   *
   * @returns A map of label keys to their quantiles, sum, and count
   */
  getAllQuantiles(): ReadonlyMap<
    string,
    {
      quantiles: ReadonlyMap<number, number>;
      sum: number;
      count: number;
      labels?: Readonly<Record<string, string>>;
    }
  > {
    const result = new Map<
      string,
      {
        quantiles: ReadonlyMap<number, number>;
        sum: number;
        count: number;
        labels?: Readonly<Record<string, string>>;
      }
    >();
    for (const [key, data] of this.#data.entries()) {
      if (data.samples.length > 0) {
        const quantiles = new Map<number, number>();
        for (const q of this.#quantiles) {
          quantiles.set(q, this.computeQuantile(data.samples, q));
        }
        const entry: {
          quantiles: ReadonlyMap<number, number>;
          sum: number;
          count: number;
          labels?: Readonly<Record<string, string>>;
        } = {
          quantiles,
          sum: data.sum,
          count: data.count,
        };
        if (data.labels) {
          entry.labels = data.labels;
        }
        result.set(key, entry);
      }
    }
    return result;
  }
}
