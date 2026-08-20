/**
 * Normalizes raw `Error` values out of log metadata before emission (X2-5).
 *
 * An `Error` placed directly in log metadata renders as `{}` under
 * `JSON.stringify` because `message` and `stack` are non-enumerable. Both the
 * console and pino loggers run merged metadata through this before redaction
 * (console) or hand-off (pino), so the mistake cannot recur through any call
 * site. The known raw-`Error` call sites also call `serializeError` explicitly
 * so they stay correct under a third-party `ILogger` that does not normalize.
 *
 * Normalizing **before** redaction is load-bearing: a redact path such as
 * `error.token` must see the normalized object, and redacting first would leave
 * the raw `Error` for `JSON.stringify` to flatten to `{}` anyway.
 *
 * This helper is internal — it is not re-exported from `index.ts` (AI_GUIDELINES
 * §10.1).
 *
 * @module
 */
import type { LogMetadata } from '@setu-ts/common';
import { serializeError } from '@setu-ts/common';

/**
 * Returns a copy of `metadata` in which every `Error` value is replaced by its
 * plain, serializable {@linkcode serializeError} representation. Non-`Error`
 * values — including nested objects and arrays — are left untouched; only a
 * top-level `Error` value is the class this milestone closes.
 *
 * @param metadata - The merged metadata to normalize
 * @returns A normalized copy (the same object when no `Error` is present)
 * @since 0.1.0
 */
export function normalizeMetadata(metadata: LogMetadata): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (value instanceof Error) {
      out ??= { ...metadata };
      out[key] = serializeError(value);
    }
  }
  return out ?? { ...metadata };
}
