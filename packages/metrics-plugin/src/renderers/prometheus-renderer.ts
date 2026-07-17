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
 * Formats a label set as Prometheus labels string.
 *
 * @param labels - The label names
 * @param values - The label values map
 * @returns The formatted labels string (including braces)
 */
function formatLabels(labels: readonly string[], values: ReadonlyMap<string, MetricValue>): string {
  if (labels.length === 0) {
    return '';
  }

  const parts: string[] = [];
  for (const name of labels) {
    for (const [_key, _val] of values.entries()) {
      if (_key.includes(name + '=')) {
        const labelValue = extractLabelValue(_key, name);
        if (labelValue !== null) {
          parts.push(`${name}="${escapeLabelValue(labelValue)}"`);
          break;
        }
      }
    }
  }

  if (parts.length === 0) {
    // Try to extract from the first value's key
    const firstKey = values.keys().next().value;
    if (firstKey) {
      for (const name of labels) {
        const labelValue = extractLabelValue(firstKey, name);
        if (labelValue !== null) {
          parts.push(`${name}="${escapeLabelValue(labelValue)}"`);
        }
      }
    }
  }

  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

/**
 * Extracts a label value from a label key string.
 *
 * @param key - The label key (e.g., "method=GET|status=200")
 * @param labelName - The label name to extract
 * @returns The label value, or null if not found
 */
function extractLabelValue(key: string, labelName: string): string | null {
  const pattern = `${labelName}=`;
  const idx = key.indexOf(pattern);
  if (idx === -1) {
    return null;
  }

  const start = idx + pattern.length;
  const end = key.indexOf('|', start);
  const end2 = key.indexOf('"', start);

  let actualEnd = end === -1 ? key.length : end;
  if (end2 !== -1 && end2 < actualEnd) {
    actualEnd = end2;
  }

  return key.slice(start, actualEnd);
}

/**
 * Renders a counter metric.
 *
 * @param snapshot - The metric snapshot
 * @returns The Prometheus exposition string
 */
function renderCounter(snapshot: MetricSnapshot): string {
  const lines: string[] = [];

  lines.push(`# HELP ${snapshot.name} ${snapshot.help}`);
  lines.push(`# TYPE ${snapshot.name} counter`);

  for (const [_key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values);
    const val = value.value ?? 0;
    lines.push(`${snapshot.name}${labels} ${val}`);
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

  lines.push(`# HELP ${snapshot.name} ${snapshot.help}`);
  lines.push(`# TYPE ${snapshot.name} gauge`);

  for (const [_key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values);
    const val = value.value ?? 0;
    lines.push(`${snapshot.name}${labels} ${val}`);
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

  lines.push(`# HELP ${snapshot.name} ${snapshot.help}`);
  lines.push(`# TYPE ${snapshot.name} histogram`);

  // Histograms need special handling for buckets
  // This is a simplified implementation
  for (const [_key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values);
    const labelsWithBraces = labels || '{}';

    // Emit bucket counts
    if (value.buckets) {
      const sortedBuckets = Array.from(value.buckets.keys()).sort((a, b) => a - b);
      let cumulative = 0;

      for (const bound of sortedBuckets) {
        const count = value.buckets.get(bound) ?? 0;
        cumulative += count;
        const le = bound === Number.POSITIVE_INFINITY ? '+Inf' : String(bound);
        lines.push(`${snapshot.name}_bucket${labelsWithBraces} le="${le}" ${cumulative}`);
      }
    }

    // Emit sum and count
    if (value.sum !== undefined) {
      lines.push(`${snapshot.name}_sum${labels} ${value.sum}`);
    }
    if (value.value !== undefined) {
      lines.push(`${snapshot.name}_count${labels} ${value.value}`);
    }
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

  lines.push(`# HELP ${snapshot.name} ${snapshot.help}`);
  lines.push(`# TYPE ${snapshot.name} summary`);

  for (const [_key, value] of snapshot.values.entries()) {
    const labels = formatLabels(snapshot.labels, snapshot.values);

    // Emit quantiles
    if (value.quantiles) {
      for (const [quantile, val] of value.quantiles.entries()) {
        const qLabels = `${labels}{quantile="${quantile}"}`.replace('{}', '');
        lines.push(`${snapshot.name}${qLabels} ${val}`);
      }
    }

    // Emit sum and count
    if (value.sum !== undefined) {
      lines.push(`${snapshot.name}_sum${labels} ${value.sum}`);
    }
    if (value.value !== undefined) {
      lines.push(`${snapshot.name}_count${labels} ${value.value}`);
    }
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
      default:
        continue;
    }

    if (rendered) {
      lines.push(rendered);
    }
  }

  return lines.join('\n\n') + '\n';
}
