/**
 * Vocabulary for classifying fields before they leave the process.
 *
 * @module
 */

/** Standard classifications understood by framework redaction policies. */
export const DATA_CLASSIFICATIONS = {
  PII: 'pii',
  PHI: 'phi',
  PCI: 'pci',
  SECRET: 'secret',
} as const;

/** A standard classification or an application-defined classification. */
export type DataClassification =
  | (typeof DATA_CLASSIFICATIONS)[keyof typeof DATA_CLASSIFICATIONS]
  | string;

/** Secret field patterns used by the logger when no explicit `redact` list is supplied. */
export const DEFAULT_SECRET_FIELD_PATTERNS: readonly string[] = [
  '**.password',
  '**.token',
  '**.secret',
  '**.apiKey',
  '**.authorization',
  '**.cookie',
] as const;
