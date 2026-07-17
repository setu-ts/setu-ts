/**
 * Metrics registry — the central store for all metric instances.
 *
 * @module
 */
import type { MetricConfig } from '@hono-enterprise/common';

/**
 * A metric instance in the registry.
 */
export interface RegisteredMetric {
  /** The metric name. */
  readonly name: string;
  /** The metric config. */
  readonly config: MetricConfig;
  /** The metric instance. */
  readonly instance: unknown;
}

/**
 * The metrics registry — a name-keyed store for metric instances.
 *
 * Provides insert / get / iterate operations with duplicate-name validation.
 */
export class MetricsRegistry {
  readonly #metrics = new Map<string, RegisteredMetric>();

  /**
   * Inserts a metric into the registry.
   *
   * @param name - The metric name
   * @param config - The metric config
   * @param instance - The metric instance
   * @throws {Error} If the name already exists with a conflicting type
   */
  insert(name: string, config: MetricConfig, instance: unknown): void {
    const existing = this.#metrics.get(name);
    if (existing) {
      if (existing.config.type !== config.type) {
        throw new Error(
          `Metric "${name}" already registered with type "${existing.config.type}", ` +
            `cannot register with type "${config.type}"`,
        );
      }
      // Same name + same type is idempotent — no-op
      return;
    }
    this.#metrics.set(name, { name, config, instance });
  }

  /**
   * Gets a metric by name.
   *
   * @param name - The metric name
   * @returns The registered metric, or undefined if not found
   */
  get(name: string): RegisteredMetric | undefined {
    return this.#metrics.get(name);
  }

  /**
   * Checks if a metric exists.
   *
   * @param name - The metric name
   * @returns True if the metric exists
   */
  has(name: string): boolean {
    return this.#metrics.has(name);
  }

  /**
   * Iterates over all registered metrics.
   *
   * @yields Each registered metric
   */
  *entries(): IterableIterator<RegisteredMetric> {
    yield* this.#metrics.values();
  }

  /**
   * Returns all metric names.
   *
   * @returns Array of metric names
   */
  get names(): readonly string[] {
    return Array.from(this.#metrics.keys());
  }

  /**
   * Returns the metric count.
   *
   * @returns The number of registered metrics
   */
  get size(): number {
    return this.#metrics.size;
  }

  /**
   * Clears all metrics from the registry.
   */
  clear(): void {
    this.#metrics.clear();
  }
}
