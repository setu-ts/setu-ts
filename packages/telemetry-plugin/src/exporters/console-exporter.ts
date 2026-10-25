/**
 * Lazy loader for the OTel console span exporter.
 *
 * @module
 * @since 0.2.0
 */

import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/**
 * Loads the console span exporter via dynamic import. The import is guarded
 * in the SAME function (AI_GUIDELINES §12.2), so a Worker bundling this file
 * does not fail at build time when the package is absent.
 *
 * @returns The `ConsoleSpanExporter` constructor
 * @throws {OptionalDependencyUnavailableError} If the npm package is not installed
 *
 * @example
 * ```typescript
 * const Exporter = await loadConsoleExporter();
 * ```
 */
export async function loadConsoleExporter(): Promise<new () => unknown> {
  try {
    const mod = await import('@opentelemetry/sdk-trace-base');
    return mod.ConsoleSpanExporter;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@opentelemetry/sdk-trace-base', {
      requiredBy: '@setu-ts/telemetry-plugin',
      cause: error,
    });
  }
}
