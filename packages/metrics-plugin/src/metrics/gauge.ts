/**
 * Gauge implementation — arbitrary set/inc/dec values.
 *
 * @module
 */
import type { MetricConfig } from '@hono-enterprise/common';
import { MetricBase } from './base-metric.ts';

/**
 * A gauge metric — arbitrary values that can go up or down.
 *
 * `set()` sets the value, `inc()`/`dec()` adjust it.
 */
interface GaugeValue {
  value: number;
  labels?: Readonly<Record<string, string>>;
}

export class Gauge extends MetricBase {
  readonly #values = new Map<string, GaugeValue>();

  /**
   * Creates a new gauge.
   *
   * @param name - Metric name
   * @param config - The metric configuration
   */
  constructor(name: string, config: MetricConfig) {
    super(name, config);
  }

  /**
   * Sets the gauge to a specific value.
   *
   * @param value - The new value
   * @param labels - Label values keyed by label name
   */
  set(value: number, labels?: Readonly<Record<string, string>>): void {
    this.validateLabels(labels);
    const key = this.labelKey(labels);
    const entry: GaugeValue = { value };
    if (labels) {
      entry.labels = labels;
    }
    this.#values.set(key, entry);
  }

  /**
   * Increments the gauge.
   *
   * @param value - The value to add (default 1)
   * @param labels - Label values keyed by label name
   */
  inc(value: number = 1, labels?: Readonly<Record<string, string>>): void {
    this.validateLabels(labels);
    const key = this.labelKey(labels);
    const current = this.#values.get(key)?.value ?? 0;
    const entry: GaugeValue = { value: current + value };
    if (labels) {
      entry.labels = labels;
    }
    this.#values.set(key, entry);
  }

  /**
   * Decrements the gauge.
   *
   * @param value - The value to subtract (default 1)
   * @param labels - Label values keyed by label name
   */
  dec(value: number = 1, labels?: Readonly<Record<string, string>>): void {
    this.validateLabels(labels);
    const key = this.labelKey(labels);
    const current = this.#values.get(key)?.value ?? 0;
    const entry: GaugeValue = { value: current - value };
    if (labels) {
      entry.labels = labels;
    }
    this.#values.set(key, entry);
  }

  /**
   * Records an observation — equivalent to `set()` for gauges.
   *
   * @param value - The new value
   * @param labels - Label values keyed by label name
   */
  observe(value: number, labels?: Readonly<Record<string, string>>): void {
    this.set(value, labels);
  }

  /**
   * Gets the current value for a label set.
   *
   * @param labels - Label values keyed by label name
   * @returns The current value
   */
  getValue(labels?: Readonly<Record<string, string>>): number {
    const key = this.labelKey(labels);
    return this.#values.get(key)?.value ?? 0;
  }

  /**
   * Gets all values.
   *
   * @returns A map of label keys to values
   */
  get values(): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const [key, entry] of this.#values.entries()) {
      result.set(key, entry.value);
    }
    return result;
  }

  /**
   * Gets all value entries with labels.
   *
   * @returns A map of label keys to value entries
   */
  get valueEntries(): ReadonlyMap<string, GaugeValue> {
    return new Map(this.#values);
  }
}
