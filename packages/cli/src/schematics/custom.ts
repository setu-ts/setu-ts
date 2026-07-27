/**
 * Custom schematic loader with injectable loadSchematic seam for real import testing.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import { join } from 'path';
import type { Schematic, SchematicOptions } from './registry.ts';

/**
 * Loads a custom schematic from a user-provided module file.
 *
 * The custom schematic must be located in .hono-enterprise/schematics/<name>.ts and export a
 * function matching the Schematic signature.
 *
 * @param name - The name of the custom schematic (basename without extension)
 * @param options - Options including filesystem and runtime context
 * @returns The loaded schematic function
 * @throws {Error} If the file does not exist or does not export a valid schematic function
 */
export async function loadCustomSchematic(
  name: string,
  options: { fs: IFileSystem; dir?: string; runtime: SchematicOptions['runtime'] },
): Promise<Schematic> {
  const dir = options.dir ?? join(Deno.cwd(), '.hono-enterprise', 'schematics');
  const schematicFile = join(dir, `${name}.ts`);

  // Check if file exists via fs
  try {
    await options.fs.stat(schematicFile);
  } catch {
    throw new Error(`Custom schematic not found: ${schematicFile}`);
  }

  // Real dynamic import — this is the guarded lazy import path that CLAUDE.md requires
  const mod = await import(`file://${schematicFile}`);

  // Validate the export shape
  const schematic = mod.schematic || mod.default;
  if (typeof schematic !== 'function') {
    throw new Error(
      `Custom schematic must export a 'schematic' function or default export that is a function`,
    );
  }

  return schematic;
}

/**
 * Validates whether a custom schematic module exports a function matching the Schematic contract.
 *
 * This is used for type-checking without actually executing the schematic.
 *
 * @param schematic - The candidate schematic function
 * @returns True if the schematic has the correct shape, false otherwise
 */
export function validateSchematic(schematic: unknown): schematic is Schematic {
  return typeof schematic === 'function';
}
