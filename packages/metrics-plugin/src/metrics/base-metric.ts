/**
 * Base metric class with shared label validation.
 *
 * @module
 */
import type { IMetric, MetricConfig, MetricType } from '@hono-enterprise/common';

/**
 * Abstract base class for all metric types.
 *
 * Provides common functionality: name, type, help, and label validation.
 */
export abstract class MetricBase implements IMetric {
  readonly #name: string;
  readonly #type: MetricType;
  readonly #help: string;
  readonly #labelNames: readonly string[] | undefined;

  /**
   * Creates a new metric.
   *
   * @param name - Metric name
   * @param config - The metric configuration (without name)
   * @param help - Help text (defaults to name if absent)
   */
  constructor(name: string, config: MetricConfig, help?: string) {
    this.#name = name;
    this.#type = config.type;
    this.#help = help ?? config.help ?? name;
    this.#labelNames = config.labels;
  }

  /**
   * The metric name.
   */
  get name(): string {
    return this.#name;
  }

  /**
   * The metric type.
   */
  get type(): MetricType {
    return this.#type;
  }

  /**
   * The help text.
   */
  get help(): string {
    return this.#help;
  }

  /**
   * Validates that label names match the configured labels.
   *
   * @param labels - The labels to validate
   * @throws {Error} If label names don't match the config
   */
  protected validateLabels(labels: Readonly<Record<string, string>> | undefined): void {
    if (!labels) {
      if (this.#labelNames && this.#labelNames.length > 0) {
        throw new Error(
          `Metric "${this.#name}" requires labels: ${this.#labelNames.join(', ')}`,
        );
      }
      return;
    }

    const labelNames = this.#labelNames;
    if (labelNames) {
      // Check that all provided labels are in the config
      for (const key of Object.keys(labels)) {
        if (!labelNames.includes(key)) {
          throw new Error(
            `Metric "${this.#name}" does not have a label "${key}". ` +
              `Valid labels: ${labelNames.join(', ')}`,
          );
        }
      }

      // Check that all required labels are provided
      for (const name of labelNames) {
        if (!(name in labels)) {
          throw new Error(
            `Metric "${this.#name}" is missing required label "${name}". ` +
              `Provided: ${Object.keys(labels).join(', ')}`,
          );
        }
      }
    }
  }

  /**
   * Creates a deterministic key from labels for storage/retrieval.
   *
   * @param labels - The labels to key by
   * @returns A deterministic string key
   */
  protected labelKey(labels: Readonly<Record<string, string>> | undefined): string {
    if (!labels) {
      return '';
    }
    const keys = Object.keys(labels).sort();
    return keys.map((k) => `${k}=${labels[k]}`).join('|');
  }

  /**
   * Records an observation (implemented by subclasses).
   */
  abstract observe(value?: number, labels?: Readonly<Record<string, string>>): void;
}
