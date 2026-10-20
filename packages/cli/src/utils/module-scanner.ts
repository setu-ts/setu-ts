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
import { registerModuleSymbol } from '../seams/modules.ts';
import { deriveNames } from './names.ts';
import { exportsSymbol } from '../seams/seam-spec.ts';
import type { GeneratorMode } from './generator-mode.ts';
import { FUNCTIONAL_CONTROLLERS_SEAM, FUNCTIONAL_ROUTES_SEAM } from '../seams/http.ts';
import { scanArtifacts, type ArtifactScanAll } from './artifact-scanner.ts';

/** Where `setu generate module` places domain modules, relative to the project root. */
export const MODULES_DIR = 'src/modules';

/** A feature directory missing the declaration or registrar needed for activation. */
export interface SkippedModule {
  /** The legacy module directory name. */
  readonly name: string;
  /** The directory relative to the project root. */
  readonly path: string;
  /** The file required to admit this module. */
  readonly missing: string;
}

/** The usable modules plus legacy generated modules that need migration. */
export interface ModuleScan {
  /** Valid module directory names, sorted. */
  readonly names: readonly string[];
  /** Candidate modules missing their declaration or exported registrar. */
  readonly skipped: readonly SkippedModule[];
}

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
 * Class-based modules require their controller, service and declaration files.
 * Functional modules require their canonical routes file and an index exporting
 * the registrar named by registerModuleSymbol. Pre-M114 service-only modules
 * remain under the old HTTP barrel and are neither admitted nor reported here.
 * Unrelated directories such as shared helpers are ignored in both modes.
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
 * @param mode - The project's generator style
 * @returns Valid module directory names and legacy generated module diagnostics
 */
export async function scanModules(
  fs: IFileSystem,
  dir: string,
  mode: GeneratorMode = 'class-based',
): Promise<ModuleScan> {
  const root = joinPath(dir, MODULES_DIR);

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // No `src/modules/` yet, or it is unreadable: there are no modules to list.
    return { names: [], skipped: [] };
  }

  const names: string[] = [];
  const skipped: SkippedModule[] = [];
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
    if (mode === 'functional') {
      if (!(await isFile(fs, `${base}.routes.ts`))) continue;
      const symbol = registerModuleSymbol(deriveNames(entry));
      let source = '';
      try {
        if (await isFile(fs, joinPath(root, entry, 'index.ts'))) {
          source = new TextDecoder().decode(await fs.readFile(joinPath(root, entry, 'index.ts')));
        }
      } catch {
        /* An unreadable index cannot activate the module. */
      }
      if (exportsSymbol(source, symbol)) names.push(entry);
      else skipped.push({ name: entry, path: `${MODULES_DIR}/${entry}`, missing: symbol });
      continue;
    }
    const controller = await isFile(fs, `${base}.controller.ts`);
    const service = await isFile(fs, `${base}.service.ts`);
    const module = await isFile(fs, `${base}.module.ts`);
    if (controller && service && module) {
      names.push(entry);
    } else if (controller && service) {
      skipped.push({ name: entry, path: `${MODULES_DIR}/${entry}`, missing: `${entry}.module.ts` });
    }
  }

  return { names: names.sort(), skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Scans the two imperative registrar families inside one admitted feature. */
export function scanModuleArtifacts(
  fs: IFileSystem,
  dir: string,
  module: string,
): Promise<ArtifactScanAll> {
  const moduleDir = `${MODULES_DIR}/${module}`;
  return scanArtifacts(
    fs,
    dir,
    [FUNCTIONAL_CONTROLLERS_SEAM, FUNCTIONAL_ROUTES_SEAM].map((spec) => ({
      ...spec,
      dir: moduleDir,
      barrel: `${moduleDir}/index.ts`,
    })),
  );
}

/**
 * Lists valid module names for callers that need no migration diagnostics.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory
 * @returns Valid module directory names, sorted
 */
export async function readModuleNames(fs: IFileSystem, dir: string): Promise<readonly string[]> {
  return (await scanModules(fs, dir)).names;
}
