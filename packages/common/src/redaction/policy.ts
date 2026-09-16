/** Redaction policy declarations. */

import type { DataClassification } from './classification.ts';
import type { Redactor } from './redactors.ts';

/** Maps field-path patterns to classifications and classifications to redactors. */
export interface RedactionPolicy {
  /** Dot-path patterns mapped to the classification they carry. */
  readonly fields: Readonly<Record<string, DataClassification>>;
  /** Optional redactors selected by classification. */
  readonly redactors?: Readonly<Record<string, Redactor>>;
  /** Fallback redactor when `redactors` has no matching classification. */
  readonly defaultRedactor?: Redactor;
}
