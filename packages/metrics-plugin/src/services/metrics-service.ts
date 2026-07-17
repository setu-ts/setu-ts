/**
 * Metrics service — the main entry point for recording and exposing metrics.
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
  MetricConfig,
  MetricOptions,
} from '@hono-enterprise/common';
import { Counter } from '../metrics/counter.ts';
import { Gauge } from '../metrics/gauge.ts';
import { Histogram } from '../metrics/histogram.ts';
import { Summary } from '../metrics/summary.ts';
import { MetricsRegistry } from '../registry/metrics-registry.ts';
import type { MetricSnapshot, MetricValue } from '../interfaces/index.ts';
import { renderPrometheus } from '../renderers/prometheus-renderer.ts';

/**
 * Default histogram buckets.
 */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Default summary quantiles.
 */
const DEFAULT_QUANTILES = [0.5, 0.9, 0.99];

/**
 * Options for MetricsService.
 */
export interface MetricsServiceOptions {
  /** Default histogram buckets. */
  readonly defaultBuckets?: readonly number[];
  /** Default summary quantiles. */
  readonly defaultQuantiles?: readonly number[];
}

/**
 * The metrics service — provides factory methods for creating metrics
 * and rendering them in Prometheus format.
 */
export class MetricsService implements IMetricsService {
  readonly #registry = new MetricsRegistry();
  readonly #defaultBuckets: readonly number[];
  readonly #defaultQuantiles: readonly number[];

  constructor(options?: MetricsServiceOptions) {
    this.#defaultBuckets = options?.defaultBuckets ?? DEFAULT_BUCKETS;
    this.#defaultQuantiles = options?.defaultQuantiles ?? DEFAULT_QUANTILES;
  }

  /**
   * Gets or creates a counter.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The counter instance
   */
  counter(name: string, options?: MetricOptions): ICounter {
    const existing = this.#registry.get(name);
    if (existing) {
      if (existing.config.type !== 'counter') {
        throw new Error(
          `Metric "${name}" already registered as "${existing.config.type}", ` +
            `cannot register as counter`,
        );
      }
      return existing.instance as ICounter;
    }

    const config: MetricConfig = {
      type: 'counter',
      help: options?.help ?? name,
      labels: options?.labels,
    } as MetricConfig;

    const counter = new Counter(name, config);
    this.#registry.insert(name, config, counter);
    return counter;
  }

  /**
   * Gets or creates a gauge.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The gauge instance
   */
  gauge(name: string, options?: MetricOptions): IGauge {
    const existing = this.#registry.get(name);
    if (existing) {
      if (existing.config.type !== 'gauge') {
        throw new Error(
          `Metric "${name}" already registered as "${existing.config.type}", ` +
            `cannot register as gauge`,
        );
      }
      return existing.instance as IGauge;
    }

    const config: MetricConfig = {
      type: 'gauge',
      help: options?.help ?? name,
      labels: options?.labels,
    } as MetricConfig;

    const gauge = new Gauge(name, config);
    this.#registry.insert(name, config, gauge);
    return gauge;
  }

  /**
   * Gets or creates a histogram.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The histogram instance
   */
  histogram(name: string, options?: MetricOptions): IHistogram {
    const existing = this.#registry.get(name);
    if (existing) {
      if (existing.config.type !== 'histogram') {
        throw new Error(
          `Metric "${name}" already registered as "${existing.config.type}", ` +
            `cannot register as histogram`,
        );
      }
      return existing.instance as IHistogram;
    }

    const buckets = options?.buckets ?? this.#defaultBuckets;
    const config: MetricConfig = {
      type: 'histogram',
      help: options?.help ?? name,
      labels: options?.labels,
      buckets,
    } as MetricConfig;

    const histogram = new Histogram(name, config, buckets);
    this.#registry.insert(name, config, histogram);
    return histogram;
  }

  /**
   * Gets or creates a summary.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The summary instance
   */
  summary(name: string, options?: MetricOptions): ISummary {
    const existing = this.#registry.get(name);
    if (existing) {
      if (existing.config.type !== 'summary') {
        throw new Error(
          `Metric "${name}" already registered as "${existing.config.type}", ` +
            `cannot register as summary`,
        );
      }
      return existing.instance as ISummary;
    }

    const quantiles = options?.quantiles ?? this.#defaultQuantiles;
    const maxSamples = options?.maxSamples;
    const config: MetricConfig = {
      type: 'summary',
      help: options?.help ?? name,
      labels: options?.labels,
    } as MetricConfig;

    const summary = new Summary(name, config, quantiles, maxSamples);
    this.#registry.insert(name, config, summary);
    return summary;
  }

  /**
   * Gets a metric by name.
   *
   * @param name - Metric name
   * @returns The metric, or undefined if not found
   */
  get(name: string): IMetric | undefined {
    const entry = this.#registry.get(name);
    return entry?.instance as IMetric | undefined;
  }

  /**
   * Registers a metric directly (for declarative registration).
   *
   * @param name - Metric name
   * @param config - Metric configuration
   * @returns The created metric
   */
  register(name: string, config: MetricConfig): IMetric {
    const existing = this.#registry.get(name);
    if (existing) {
      if (existing.config.type !== config.type) {
        throw new Error(
          `Metric "${name}" already registered as "${existing.config.type}", ` +
            `cannot register as "${config.type}"`,
        );
      }
      return existing.instance as IMetric;
    }

    let metric: IMetric;
    switch (config.type) {
      case 'counter':
        metric = new Counter(name, config);
        break;
      case 'gauge':
        metric = new Gauge(name, config);
        break;
      case 'histogram':
        metric = new Histogram(name, config, config.buckets);
        break;
      case 'summary':
        metric = new Summary(name, config, undefined, undefined);
        break;
      default:
        throw new Error(`Unknown metric type: ${config.type}`);
    }

    this.#registry.insert(name, config, metric);
    return metric;
  }

  /**
   * Gets all registered metric names.
   *
   * @returns Array of metric names
   */
  get names(): readonly string[] {
    return this.#registry.names;
  }

  /**
   * Takes a snapshot of all metrics for rendering.
   *
   * @returns Array of metric snapshots
   */
  snapshot(): readonly MetricSnapshot[] {
    const snapshots: MetricSnapshot[] = [];

    for (const entry of this.#registry.entries()) {
      const metric = entry.instance as IMetric;
      const labelNames = entry.config.labels ?? [];

      let values: ReadonlyMap<string, MetricValue>;

      if (metric instanceof Counter) {
        // Convert number values to MetricValue
        const map = new Map<string, MetricValue>();
        for (const [key, val] of metric.values.entries()) {
          map.set(key, { value: val });
        }
        values = map;
      } else if (metric instanceof Gauge) {
        // Convert number values to MetricValue
        const map = new Map<string, MetricValue>();
        for (const [key, val] of metric.values.entries()) {
          map.set(key, { value: val });
        }
        values = map;
      } else if (metric instanceof Histogram) {
        values = this.#snapshotHistogram(metric);
      } else if (metric instanceof Summary) {
        values = this.#snapshotSummary(metric);
      } else {
        values = new Map();
      }

      snapshots.push({
        name: metric.name,
        type: metric.type,
        help: metric.help,
        labels: labelNames,
        values,
      });
    }

    return snapshots;
  }

  /**
   * Creates a snapshot for a histogram metric.
   */
  #snapshotHistogram(_metric: IMetric & IHistogram): ReadonlyMap<string, MetricValue> {
    // For now, return empty - the actual implementation would need
    // to track all observed label sets
    return new Map();
  }

  /**
   * Creates a snapshot for a summary metric.
   */
  #snapshotSummary(_metric: IMetric & ISummary): ReadonlyMap<string, MetricValue> {
    const result = new Map<string, MetricValue>();

    // Similar to histogram, we need to track all observed label sets
    return result;
  }

  /**
   * Renders all metrics in Prometheus text format.
   *
   * @returns The Prometheus exposition format string
   */
  render(): string {
    return renderPrometheus(this.snapshot());
  }
}
