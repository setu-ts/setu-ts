/**
 * Migration schematic — generates a migration file (gated on database-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a migration file.
 */
export function generateMigration(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const timestamp = Math.floor(Date.now() / 1000);
  const fileName = `src/migrations/${timestamp}-${names.kebab}.up.ts`;
  const contents =
    `// Requires database-plugin\nexport interface Migration {\n  up(): Promise<void>;\n  down(): Promise<void>\n}\n\nexport const migration: Migration = {\n  async up() {\n    // Migration up logic\n  },\n  async down() {\n    // Migration down logic\n  },\n};\n`;
  return [{ path: fileName, contents }];
}
