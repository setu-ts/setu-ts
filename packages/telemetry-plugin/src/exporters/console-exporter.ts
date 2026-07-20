/**
 * Lazy loader for the OTel console span exporter.
 *
 * @module
 * @since 0.24.0
 */

/**
 * Loads the console span exporter via dynamic import.
 *
 * @returns The `ConsoleSpanExporter` constructor
 * @throws {Error} If the npm package is not installed
 *
 * @example
 * ```typescript
 * const Exporter = await loadConsoleExporter();
 * ```
 */
export async function loadConsoleExporter(): Promise<
  new () => unknown
> {
  const mod = await import('npm:@opentelemetry/sdk-trace-base@^2.9.0');
  return mod.ConsoleSpanExporter;
}
