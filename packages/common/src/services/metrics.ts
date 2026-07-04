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
