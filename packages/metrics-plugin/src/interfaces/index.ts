/**
 * Interfaces and types for the metrics plugin.
 *
 * Mostly an internal seam used only by metrics-plugin implementation files. Two
 * members are re-exported from `src/index.ts` and are therefore public:
 * `MetricsPluginOptions`, and `NamedMetricConfig` — which its `customMetrics` member is
 * typed as, so without it that option could not be named by a consumer at all.
 * `MetricSnapshot`, `MetricValue` and `SummaryWindowConfig` remain internal.
 *
 * @module
 */
import type { MetricConfig, MetricType } from '@setu-ts/common';

/**
 * Named metric config for declarative registration.
 */
export interface NamedMetricConfig extends MetricConfig {
  /** Metric name. */
  readonly name: string;
}

/**
 * A snapshot of a metric's current state for rendering.
 */
export interface MetricSnapshot {
  /** Metric name. */
  readonly name: string;
  /** Metric type. */
  readonly type: MetricType;
  /** Help text. */
  readonly help: string;
  /** Label names (if any). */
  readonly labels: readonly string[];
  /** Per-label-set values. */
  readonly values: ReadonlyMap<string, MetricValue>;
}

/**
 * A single metric value with optional aggregations.
 */
export interface MetricValue {
  /** The base value (counter/gauge) or sample count (histogram/summary). */
  readonly value: number;
  /** Sum of all observations (histogram/summary). */
  readonly sum?: number;
  /** Bucket counts (histogram). */
  readonly buckets?: ReadonlyMap<number, number>;
  /** Quantile values (summary). */
  readonly quantiles?: ReadonlyMap<number, number>;
  /** The label values for this entry (for rendering - avoids lossy round-trip). */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Summary sample window configuration.
 */
export interface SummaryWindowConfig {
  /** Maximum samples to retain. */
  readonly maxSamples: number;
  /** Quantiles to compute. */
  readonly quantiles: readonly number[];
}

/**
 * Plugin options for MetricsPlugin.
 */
export interface MetricsPluginOptions {
  /**
   * The scrape endpoint path.
   *
   * @default '/metrics'
   */
  readonly endpoint?: string;

  /**
   * Request paths the HTTP metrics middleware skips entirely — no counter,
   * histogram, or gauge is touched for them.
   *
   * When supplied this list REPLACES the default `['/health', '/live',
   * '/ready']` set rather than extending it; the plugin's own
   * {@linkcode endpoint} is always excluded regardless, so `/metrics` can
   * never count its own scrapes.
   *
   * @default ['/health', '/live', '/ready']
   */
  readonly excludePaths?: readonly string[];

  /**
   * Enable built-in HTTP metrics.
   *
   * @default true
   */
  readonly defaultMetrics?: boolean;

  /**
   * Enable the metrics middleware for HTTP request tracking.
   *
   * @default true
   */
  readonly httpMetrics?: boolean;

  /**
   * Declarative metric definitions to pre-register.
   */
  readonly customMetrics?: readonly NamedMetricConfig[];

  /**
   * Default histogram bucket boundaries.
   *
   * @default [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
   */
  readonly defaultBuckets?: readonly number[];

  /**
   * Default summary quantiles.
   *
   * @default [0.5, 0.9, 0.99]
   */
  readonly defaultQuantiles?: readonly number[];
}
