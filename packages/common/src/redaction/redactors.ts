/** Built-in synchronous redactors. */

import type { DataClassification } from './classification.ts';

/** Context supplied to a redactor for the value it is replacing. */
export interface RedactionContext {
  /** Dot-separated path of the classified value. */
  readonly path: string;
  /** Classification matched for the value. */
  readonly classification: DataClassification;
}

/** A synchronous replacement strategy for a classified value. */
export type Redactor = (value: unknown, context: RedactionContext) => unknown;

/** Replaces every value with a stable placeholder. */
export const eraseRedactor: Redactor = (): string => '[Redacted]';

/** Options for {@linkcode createMaskRedactor}. */
export interface MaskOptions {
  /** Number of trailing characters retained. Defaults to `4`. */
  readonly keep?: number;
}

/**
 * Creates a redactor that preserves a short trailing suffix of string values.
 * Non-string values and strings no longer than the retained suffix are erased.
 *
 * @param options - Mask configuration
 * @returns A synchronous masking redactor
 */
export function createMaskRedactor(options: MaskOptions = {}): Redactor {
  const keep = options.keep ?? 4;
  return (value: unknown): unknown => {
    if (
      !Number.isSafeInteger(keep) || keep < 0 || typeof value !== 'string' || value.length <= keep
    ) {
      return eraseRedactor(value, { path: '', classification: '' });
    }
    return `${'*'.repeat(value.length - keep)}${value.slice(-keep)}`;
  };
}
