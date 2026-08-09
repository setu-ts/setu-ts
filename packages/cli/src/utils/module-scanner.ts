/**
 * Discovery of the domain modules already present in a target project.
 *
 * The `module` schematic renders an aggregate barrel listing every module, and a
 * schematic is a pure function that performs no I/O. So the read happens here,
 * at the command layer, and the result is handed in through
 * `SchematicOptions.modules` — the same route `plugin-detector.ts` already takes
 * for the detected plugin set.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import { joinPath } from './file-writer.ts';

/** Where `setu generate module` places domain modules, relative to the project root. */
export const MODULES_DIR = 'src/modules';

/**
 * Lists the domain module directories under `src/modules/`.
 *
 * Entries are filtered to directories, so the aggregate barrel the caller
 * renders can never import from a stray file (`src/modules/index.ts` itself is
 * the obvious one, and it must not be mistaken for a module).
 *
 * Sorted, because `readdir` enumeration order is filesystem-defined: without a
 * sort the regenerated barrel could differ byte-for-byte between two machines
 * that hold exactly the same modules, turning a no-op regeneration into a diff.
 *
 * A missing or unreadable `src/modules/` yields an empty list rather than
 * throwing — a project that has never generated a module is the common case, not
 * an error.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory (absolute)
 * @returns The module directory names, sorted, or `[]` when there are none
 */
export async function readModuleNames(
  fs: IFileSystem,
  dir: string,
): Promise<readonly string[]> {
  const root = joinPath(dir, MODULES_DIR);

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // No `src/modules/` yet, or it is unreadable: there are no modules to list.
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    try {
      const stat = await fs.stat(joinPath(root, entry));
      if (stat.isDirectory) names.push(entry);
    } catch {
      // Vanished or unreadable between the listing and the probe — skip it
      // rather than failing the whole command over one entry.
    }
  }

  return names.sort();
}
