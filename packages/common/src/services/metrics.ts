/**
 * Metric contracts, consumed by the MetricsPlugin.
 *
 * @module
 */
import type { MetricType } from '../types.ts';

/**
 * Configuration for registering a metric.
 *
 * @since 0.1.0
 */
export interface MetricConfig {
  /** The metric instrument kind. */
  readonly type: MetricType;
  /** Human-readable description (Prometheus `HELP`). */
  readonly help: string;
  /** Label names attachable to observations. */
  readonly labels?: readonly string[];
  /** Histogram bucket boundaries (histogram metrics only). */
  readonly buckets?: readonly number[];
}

/**
 * A registered metric.
 *
 * @since 0.1.0
 */
export interface IMetric {
  /** Metric name (Prometheus naming conventions). */
  readonly name: string;
  /** The metric instrument kind. */
  readonly type: MetricType;
  /** Human-readable description. */
  readonly help: string;
  /**
   * Records an observation.
   *
   * For counters the value is the increment (default 1); for gauges the new
   * value; for histograms and summaries the observed sample.
   *
   * @param value - The observed value
   * @param labels - Label values keyed by label name
   */
  observe(value?: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * Ergonomic options for the typed factory methods. `type` is injected by the
 * method name; `help` defaults to the metric name.
 *
 * @since 0.19.0
 */
export interface MetricOptions {
  /** Human-readable description (Prometheus `HELP`). Defaults to the metric name. */
  readonly help?: string;
  /** Label names attachable to observations. */
  readonly labels?: readonly string[];
  /** Histogram bucket boundaries (histogram metrics only). */
  readonly buckets?: readonly number[];
  /** Summary quantiles (summary metrics only). */
  readonly quantiles?: readonly number[];
  /**
   * Summary only: bounded sample-window size.
   *
   * @default 512
   */
  readonly maxSamples?: number;
}

/**
 * Monotonically increasing counter. `observe` / `inc` add a non-negative value.
 *
 * @since 0.19.0
 */
export interface ICounter extends IMetric {
  /**
   * Increments the counter.
   *
   * @param value - The value to add (default 1)
   * @param labels - Label values keyed by label name
   */
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * Gauge: arbitrary set / inc / dec. `observe` sets the value.
 *
 * @since 0.19.0
 */
export interface IGauge extends IMetric {
  /**
   * Sets the gauge to a specific value.
   *
   * @param value - The new value
   * @param labels - Label values keyed by label name
   */
  set(value: number, labels?: Readonly<Record<string, string>>): void;
  /**
   * Increments the gauge.
   *
   * @param value - The value to add (default 1)
   * @param labels - Label values keyed by label name
   */
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
  /**
   * Decrements the gauge.
   *
   * @param value - The value to subtract (default 1)
   * @param labels - Label values keyed by label name
   */
  dec(value?: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * Histogram: bucketed observation distribution plus sum and count.
 *
 * @since 0.19.0
 */
export interface IHistogram extends IMetric {
  /**
   * Records an observation (sample).
   *
   * @param value - The observed value
   * @param labels - Label values keyed by label name
   */
  observe(value: number, labels?: Readonly<Record<string, string>>): void;
  /** Upper bounds of the histogram buckets. */
  readonly buckets: readonly number[];
}

/**
 * Summary: per-quantile observations plus sum and count.
 *
 * @since 0.19.0
 */
export interface ISummary extends IMetric {
  /**
   * Records an observation (sample).
   *
   * @param value - The observed value
   * @param labels - Label values keyed by label name
   */
  observe(value: number, labels?: Readonly<Record<string, string>>): void;
  /** Configured quantiles. */
  readonly quantiles: readonly number[];
}

/**
 * Metrics service resolved via `ctx.services.get<IMetricsService>('metrics')`.
 *
 * @since 0.19.0
 */
export interface IMetricsService {
  /**
   * Gets or creates a counter.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The counter instance
   */
  counter(name: string, options?: MetricOptions): ICounter;
  /**
   * Gets or creates a gauge.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The gauge instance
   */
  gauge(name: string, options?: MetricOptions): IGauge;
  /**
   * Gets or creates a histogram.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The histogram instance
   */
  histogram(name: string, options?: MetricOptions): IHistogram;
  /**
   * Gets or creates a summary.
   *
   * @param name - Metric name
   * @param options - Optional configuration
   * @returns The summary instance
   */
  summary(name: string, options?: MetricOptions): ISummary;
  /**
   * Gets a metric by name.
   *
   * @param name - Metric name
   * @returns The metric, or undefined if not found
   */
  get(name: string): IMetric | undefined;
}
