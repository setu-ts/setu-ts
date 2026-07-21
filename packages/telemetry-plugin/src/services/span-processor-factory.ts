/**
 * Factory for creating span processors from the loaded OTel SDK module.
 *
 * @module
 * @since 0.24.1
 */

import type { SpanProcessorKind } from '../interfaces/index.ts';

/**
 * Module handle for the OTel SDK trace base — provides processor constructors.
 *
 * @internal
 */
export interface SpanProcessorSdkModule {
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
  BatchSpanProcessor: new (exporter: unknown, config?: Record<string, unknown>) => unknown;
}

/**
 * Creates a span processor of the requested kind.
 *
 * Both `SimpleSpanProcessor` and `BatchSpanProcessor` are imported from the
 * already-pinned `npm:@opentelemetry/sdk-trace-base@^2.9.0` and passed in via
 * `sdkMod` — this factory does NOT perform lazy imports itself.
 *
 * @param kind - The processor kind (`'simple'` or `'batch'`).
 * @param exporter - The span exporter instance to attach to the processor.
 * @param sdkMod - The loaded OTel SDK module providing processor constructors.
 * @returns A new span processor instance.
 * @since 0.24.1
 */
export function createSpanProcessor(
  kind: SpanProcessorKind,
  exporter: unknown,
  sdkMod: SpanProcessorSdkModule,
): unknown {
  const { SimpleSpanProcessor, BatchSpanProcessor } = sdkMod;

  if (kind === 'batch') {
    return new BatchSpanProcessor(exporter);
  }

  return new SimpleSpanProcessor(exporter);
}
