/** Redaction policy declarations. */

import type { DataClassification } from './classification.ts';
import type { Redactor } from './redactors.ts';

/**
 * A field path's classification together with an optional redactor scoped to
 * that pattern.
 *
 * @since 0.9.0
 */
export interface FieldRedaction {
  /** Classification reported for values matched by this field pattern. */
  readonly classification: DataClassification;
  /**
   * Redactor for this field pattern, preferred over `redactors[classification]`.
   */
  readonly redactor?: Redactor;
}

/** Maps field-path patterns to classifications and classifications to redactors. */
export interface RedactionPolicy {
  /**
   * Dot-path patterns mapped to the classification they carry, or to a
   * {@linkcode FieldRedaction} carrying a pattern-specific redactor.
   */
  readonly fields: Readonly<Record<string, DataClassification | FieldRedaction>>;
  /** Optional redactors selected by classification. */
  readonly redactors?: Readonly<Record<string, Redactor>>;
  /** Fallback redactor when `redactors` has no matching classification. */
  readonly defaultRedactor?: Redactor;
}
