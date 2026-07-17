/**
 * Prometheus text exposition format renderer (0.0.4).
 *
 * @module
 */
import type { MetricSnapshot, MetricValue } from '../interfaces/index.ts';

/**
 * Escapes a label value for Prometheus format.
 *
 * @param value - The value to escape
 * @returns The escaped value
 */
function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/**
 * Escapes `# HELP` text for Prometheus format: backslash and newline only
 * (double-quote is NOT escaped in HELP, unlike label values). Prevents a
 * help string containing a newline from splitting the HELP directive.
 *
 * @param help - The help text to escape
 * @returns The escaped help text
 */
function escapeHelp(help: string): string {
  return help
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
}

/**
 * Formats a metric value for Prometheus text format.
 * Handles special values (Infinity, -Infinity, NaN) per Prometheus 0.0.4 spec.
 *
 * @param value - The value to format
 * @returns The formatted value string
 */
function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '+Inf';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }
  return String(value);
}

/**
 * Formats a label set as Prometheus labels string.
 *
 * @param labels - The label names
 * @param values - The label values map
 * @param key - Optional key to extract labels from (for per-label-set rendering)
 * @returns The formatted labels string (including braces)
 */
function formatLabels(
  labels: readonly string[],
  values: ReadonlyMap<string, MetricValue>,
  key?: string,
): string {
  if (labels.length === 0) {
    return '';
  }

  // Key is always provided when rendering metrics with labels
  if (!key) {
    return '{}';
  }

  // Get the labels from the MetricValue directly - no lossy round-trip
  const value = values.get(key);
  if (!value?.labels) {
    return '{}';
  }

  // Sort label names for deterministic output
  const sortedNames = [...labels].sort();
  const parts: string[] = [];
  for (const name of sortedNames) {
    const labelValue = value.labels[name];
    if (labelValue !== undefined) {
      parts.push(`${name}="${escapeLabelValue(labelValue)}"`);
    }
  }
  return parts.length > 0 ? `{${parts.join(',')}}` : '{}';
}

/**
 * Appends an additional label to an existing label string.
 * Handles the case where base labels are empty.
 *
 * @param baseLabels - The existing labels string (empty or {a="1",b="2"})
 * @param newLabel - The new label to append (e.g., le="0.1")
 * @returns The combined labels string
 */
function appendLabel(baseLabels: string, newLabel: string): string {
  if (baseLabels === '') {
    return `{${newLabel}}`;
  }
  // baseLabels is like {a="1",b="2"} - remove trailing } and append
  return `${baseLabels.slice(0, -1)},${newLabel}}`;
}

/**
 * Renders a counter metric.
 *
 * @param snapshot - The metric snapshot
 * @returns The Prometheus exposition string
 */
function renderCounter(snapshot: MetricSnapshot): string {
  const lines: string[] = [];

  lines.push(`# HELP ${snapshot.name} ${escapeHelp(snapshot.help)}`);
  lines.push(`# TYPE ${snapshot.name} counter`);

  for (const [key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values, key);
    const val = value.value ?? 0;
    // For no labels, don't emit braces
    lines.push(`${snapshot.name}${labels} ${formatValue(val)}`);
  }

  return lines.join('\n');
}

/**
 * Renders a gauge metric.
 *
 * @param snapshot - The metric snapshot
 * @returns The Prometheus exposition string
 */
function renderGauge(snapshot: MetricSnapshot): string {
  const lines: string[] = [];

  lines.push(`# HELP ${snapshot.name} ${escapeHelp(snapshot.help)}`);
  lines.push(`# TYPE ${snapshot.name} gauge`);

  for (const [key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values, key);
    const val = value.value ?? 0;
    // For no labels, don't emit braces
    lines.push(`${snapshot.name}${labels} ${formatValue(val)}`);
  }

  return lines.join('\n');
}

/**
 * Renders a histogram metric.
 *
 * @param snapshot - The metric snapshot
 * @returns The Prometheus exposition string
 */
function renderHistogram(snapshot: MetricSnapshot): string {
  const lines: string[] = [];

  lines.push(`# HELP ${snapshot.name} ${escapeHelp(snapshot.help)}`);
  lines.push(`# TYPE ${snapshot.name} histogram`);

  // Histograms need special handling for buckets
  for (const [key, value] of snapshot.values.entries()) {
    // Format labels for this specific label set
    const labels = formatLabels(snapshot.labels, snapshot.values, key);

    // Emit bucket counts with cumulative sum
    if (value.buckets) {
      const sortedBuckets = Array.from(value.buckets.keys()).sort((a, b) => a - b);

      for (const bound of sortedBuckets) {
        const count = value.buckets.get(bound)!;
        const le = bound === Number.POSITIVE_INFINITY ? '+Inf' : String(bound);
        // For bucket lines, use appendLabel to handle empty labels correctly
        const bucketLabels = appendLabel(labels, `le="${le}"`);
        lines.push(`${snapshot.name}_bucket${bucketLabels} ${count}`);
      }
    }

    // Emit sum and count (no braces for no-label case)
    lines.push(`${snapshot.name}_sum${labels} ${formatValue(value.sum!)}`);
    lines.push(`${snapshot.name}_count${labels} ${formatValue(value.value!)}`);
  }

  return lines.join('\n');
}

/**
 * Renders a summary metric.
 *
 * @param snapshot - The metric snapshot
 * @returns The Prometheus exposition string
 */
function renderSummary(snapshot: MetricSnapshot): string {
  const lines: string[] = [];

  lines.push(`# HELP ${snapshot.name} ${escapeHelp(snapshot.help)}`);
  lines.push(`# TYPE ${snapshot.name} summary`);

  for (const [key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values, key);

    // Emit quantiles
    if (value.quantiles) {
      for (const [quantile, val] of value.quantiles.entries()) {
        // Use appendLabel to handle empty labels correctly
        const qLabels = appendLabel(labels, `quantile="${quantile}"`);
        lines.push(`${snapshot.name}${qLabels} ${formatValue(val)}`);
      }
    }

    // Emit sum and count (no braces for no-label case)
    lines.push(`${snapshot.name}_sum${labels} ${formatValue(value.sum!)}`);
    lines.push(`${snapshot.name}_count${labels} ${formatValue(value.value!)}`);
  }

  return lines.join('\n');
}

/**
 * Renders metrics in Prometheus text exposition format (0.0.4).
 *
 * @param snapshots - Array of metric snapshots
 * @returns The Prometheus exposition format string
 */
export function renderPrometheus(snapshots: readonly MetricSnapshot[]): string {
  if (snapshots.length === 0) {
    return '';
  }

  const lines: string[] = [];

  for (const snapshot of snapshots) {
    let rendered: string;

    switch (snapshot.type) {
      case 'counter':
        rendered = renderCounter(snapshot);
        break;
      case 'gauge':
        rendered = renderGauge(snapshot);
        break;
      case 'histogram':
        rendered = renderHistogram(snapshot);
        break;
      case 'summary':
        rendered = renderSummary(snapshot);
        break;
    }

    lines.push(rendered);
  }

  return lines.join('\n\n') + '\n';
}
