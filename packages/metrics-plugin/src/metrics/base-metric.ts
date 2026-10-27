/**
 * Base metric class with shared label validation.
 *
 * @module
 */
import type { IMetric, MetricConfig, MetricType } from '@setu-ts/common';

interface ILabelKeyNode {
  readonly children: Map<string, ILabelKeyNode>;
  key?: string;
}

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
  readonly #labelKeys: ILabelKeyNode = { children: new Map() };

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
    this.#labelNames = config.labels === undefined ? undefined : [...config.labels];
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
        throw new Error(`Metric "${this.#name}" requires labels: ${this.#labelNames.join(', ')}`);
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
   * Copies the caller's labels once per observation. Validation, the series key
   * and the stored labels all read this copy, so an accessor returning a
   * different value on each read cannot file a series under one label set and
   * export it under another.
   *
   * @param labels - The caller's labels
   * @returns A private copy, or `undefined` when unlabeled (null included)
   */
  protected snapshotLabels(
    labels: Readonly<Record<string, string>> | undefined,
  ): Readonly<Record<string, string>> | undefined {
    return labels ? { ...labels } : undefined;
  }

  /**
   * Creates a deterministic key from labels for storage/retrieval.
   *
   * @param labels - The labels to key by
   * @param observed - Only observations retain combinations; getters cannot grow the cache
   * @returns A deterministic string key
   */
  protected labelKey(
    labels: Readonly<Record<string, string>> | undefined,
    observed: boolean = false,
  ): string {
    // `!labels`, not `=== undefined`: a JavaScript caller may pass null.
    if (!labels) return '';
    const names = Object.keys(labels);
    if (names.length === 0) {
      return '';
    }
    const configured = this.#labelNames;
    if (
      configured !== undefined &&
      names.length === configured.length &&
      configured.every((name) => Object.hasOwn(labels, name))
    ) {
      // Each value is read exactly once: a getter returning different values
      // on each read must not cache a key for a series it did not observe.
      const values = configured.map((name) => labels[name]!);
      let node = this.#labelKeys;
      for (const value of values) {
        let child = node.children.get(value);
        if (child === undefined) {
          if (!observed) return snapshotKey(configured, values);
          child = { children: new Map() };
          node.children.set(value, child);
        }
        node = child;
      }
      if (node.key !== undefined) return node.key;
      const key = snapshotKey(configured, values);
      node.key = key;
      return key;
    }
    // JSON.stringify of sorted entries ensures injectivity:
    // - Distinct label-sets → distinct keys (no collision from |, =, or \ in values)
    // - Same label-set → same key (stable)
    // - Order-independent (entries sorted before stringify)
    return JSON.stringify(Object.entries(labels).sort());
  }

  /**
   * Records an observation (implemented by subclasses).
   */
  abstract observe(value?: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * Builds the label key from values already read, byte-identical to
 * `JSON.stringify(Object.entries(labels).sort())` for the same label set. The
 * default sort compares each pair as the string `name,value`, so the input
 * order matters only when two pairs stringify equally, which needs a comma in a
 * label name; then the configured order decides, the same on every call.
 */
function snapshotKey(names: readonly string[], values: readonly string[]): string {
  return JSON.stringify(names.map((name, index) => [name, values[index]!]).sort());
}
