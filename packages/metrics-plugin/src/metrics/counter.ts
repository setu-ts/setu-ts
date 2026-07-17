/**
 * Counter implementation — monotonically increasing values.
 *
 * @module
 */
import type { MetricConfig } from '@hono-enterprise/common';
import { MetricBase } from './base-metric.ts';

/**
 * A counter metric — monotonically increasing.
 *
 * `inc()` adds a non-negative value (default 1) to the counter.
 */
export class Counter extends MetricBase {
  readonly #values = new Map<string, number>();

  /**
   * Creates a new counter.
   *
   * @param name - Metric name
   * @param config - The metric configuration
   */
  constructor(name: string, config: MetricConfig) {
    super(name, config);
  }

  /**
   * Increments the counter.
   *
   * @param value - The value to add (default 1)
   * @param labels - Label values keyed by label name
   */
  inc(value: number = 1, labels?: Readonly<Record<string, string>>): void {
    if (value < 0) {
      throw new Error(`Counter "${this.name}" cannot be decremented`);
    }
    this.validateLabels(labels);
    const key = this.labelKey(labels);
    const current = this.#values.get(key) ?? 0;
    this.#values.set(key, current + value);
  }

  /**
   * Records an observation — equivalent to `inc()` for counters.
   *
   * @param value - The value to add (default 1)
   * @param labels - Label values keyed by label name
   */
  observe(value: number = 1, labels?: Readonly<Record<string, string>>): void {
    this.inc(value, labels);
  }

  /**
   * Gets the current value for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The current value
   */
  getValue(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    return this.#values.get(key) ?? 0;
  }

  /**
   * Gets all values.
   *
   * @returns A map of label keys to values
   */
  get values(): ReadonlyMap<string, number> {
    return new Map(this.#values);
  }
}
