/**
 * Migration schematic (gated on `database-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Formats an epoch-milliseconds reading as a `YYYYMMDDHHMMSS` UTC stamp.
 *
 * @param epochMs - Wall-clock milliseconds
 * @returns The 14-character timestamp used to order migrations
 */
function stamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

/**
 * Generates a timestamped migration.
 *
 * The timestamp comes from `options.now()` — the injected clock — so the
 * emitted filename is deterministic under test and never reads a runtime API
 * directly.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the clock used for the filename timestamp
 * @returns One file at `src/migrations/<timestamp>-<kebab>.ts`
 */
export function generateMigration(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `/**
 * Migration: ${names.kebab}
 *
 * Applied in filename order. \`down\` must exactly reverse \`up\`.
 */
export interface Migration {
  /** Applies the change. */
  up(): Promise<void>;
  /** Reverses {@linkcode Migration.up}. */
  down(): Promise<void>;
}

/** The ${names.kebab} migration. */
export const ${names.camel}Migration: Migration = {
  async up(): Promise<void> {
    // Replace with the forward change.
    await Promise.resolve();
  },

  async down(): Promise<void> {
    // Replace with the exact inverse of up().
    await Promise.resolve();
  },
};
`;
  return [
    { path: `src/migrations/${stamp(options.now())}-${names.kebab}.ts`, contents },
  ];
}
