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
 * Reports whether a path is an existing regular file.
 *
 * @param fs - The filesystem to probe
 * @param path - The path to test
 * @returns True when the path exists and is a file
 */
async function isFile(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Lists the domain modules under `src/modules/`.
 *
 * A directory counts as a module only when it holds BOTH `<name>.controller.ts`
 * and `<name>.service.ts` — the two files the aggregate barrel imports. That is
 * the barrel's precondition, and checking it is what keeps an unrelated
 * directory out: a `shared/` helper folder is a natural thing to put here, and
 * admitting it would make the regenerated barrel import
 * `./shared/shared.controller.ts`, which does not exist. The developer's project
 * would then fail to compile, naming files they never created, from a command
 * that reported success.
 *
 * A directory whose canonical paths exist but are themselves directories is
 * rejected too, since neither can be imported.
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
    let stat;
    try {
      stat = await fs.stat(joinPath(root, entry));
    } catch {
      // Vanished or unreadable between the listing and the probe — skip it
      // rather than failing the whole command over one entry.
      continue;
    }
    if (!stat.isDirectory) continue;

    const base = joinPath(root, entry, entry);
    if (
      await isFile(fs, `${base}.controller.ts`) &&
      await isFile(fs, `${base}.service.ts`)
    ) {
      names.push(entry);
    }
  }

  return names.sort();
}
