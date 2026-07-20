/**
 * Lazy loader for the OTLP HTTP trace exporter.
 *
 * @module
 * @since 0.24.0
 */

/**
 * Loads the OTLP trace exporter via dynamic import.
 *
 * @param url - The OTLP endpoint URL
 * @param headers - Optional headers to include in OTLP requests
 * @returns The `OTLPTraceExporter` constructor
 * @throws {Error} If the npm package is not installed or `url` is missing
 *
 * @example
 * ```typescript
 * const Exporter = await loadOtlpExporter('http://otel:4318/v1/traces');
 * ```
 */
export async function loadOtlpExporter(
  url: string,
  _headers?: Record<string, string>,
): Promise<new (opts?: { url?: string; headers?: Record<string, string> }) => unknown> {
  if (!url) {
    throw new Error('OTLP exporter requires a `url` option');
  }

  const mod = await import(
    'npm:@opentelemetry/exporter-trace-otlp-http@^0.220.0'
  );
  return mod.OTLPTraceExporter;
}
