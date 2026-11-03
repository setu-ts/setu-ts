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

import {
  assertInsideProject,
  joinPath,
  MAX_EXISTING_FILE_BYTES,
  PathEscapesProjectError,
} from './file-writer.ts';
import {
  MODULE_SERVICE_ARTIFACTS,
  registerModuleSymbol,
  renderFunctionalModuleIndex,
} from '../seams/modules.ts';
import type { SeamSpec } from '../seams/seam-spec.ts';
import { deriveNames, isKebabIdentifier } from './names.ts';
import { isMissingPath } from './filesystem-errors.ts';
import { exportsSymbol } from '../seams/seam-spec.ts';
import type { GeneratorMode } from './generator-mode.ts';
import { CONTROLLERS_SEAM, FUNCTIONAL_CONTROLLERS_SEAM } from '../seams/http.ts';
import { scanArtifacts, type ArtifactScanAll } from './artifact-scanner.ts';

/** Where `setu generate module` places domain modules, relative to the project root. */
export const MODULES_DIR = 'src/modules';

/** A feature directory missing the declaration or registrar needed for activation. */
export interface SkippedModule {
  /** A migratable legacy declaration or a file that cannot supply its export. */
  readonly kind: 'legacy' | 'missing-export';
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
  /**
   * Module-shaped directories whose name is not a kebab-case identifier, as
   * `src/modules/<name>` paths. They are never admitted: the barrel interpolates
   * the name into an import binding and a path, so `q'y` would emit source that
   * does not compile and a name carrying a line feed would forge output lines.
   */
  readonly rejected: readonly string[];
  /** Directories that could not be safely scanned. */
  readonly unreadable?: readonly { readonly path: string; readonly reason: 'unsafe-directory' }[];
}

/** Evidence about a file the activation barrel would import. */
type ExportStatus = 'exported' | 'missing' | 'missing-export';

/** Read only regular files under the cap, distinguishing absence from bad evidence. */
async function exportStatus(fs: IFileSystem, path: string, symbol: string): Promise<ExportStatus> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (cause) {
    return isMissingPath(cause) ? 'missing' : 'missing-export';
  }
  if (!stat.isFile || stat.size > MAX_EXISTING_FILE_BYTES) return 'missing-export';
  try {
    const source = new TextDecoder().decode(await fs.readFile(path));
    return exportsSymbol(source, symbol) ? 'exported' : 'missing-export';
  } catch {
    return 'missing-export';
  }
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
 * Class-based modules require an exported module declaration. Functional modules
 * require an index exporting the registrar named by registerModuleSymbol. Neither
 * depends on the location of its controllers or services.
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

  const unreadable: { readonly path: string; readonly reason: 'unsafe-directory' }[] = [];
  try {
    await assertInsideProject(fs, dir, root);
  } catch (cause) {
    if (!(cause instanceof PathEscapesProjectError)) throw cause;
    return {
      names: [],
      skipped: [],
      rejected: [],
      unreadable: [{ path: MODULES_DIR, reason: 'unsafe-directory' }],
    };
  }

  let entries: readonly string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // No `src/modules/` yet, or it is unreadable: there are no modules to list.
    return { names: [], skipped: [], rejected: [] };
  }

  const names: string[] = [];
  const skipped: SkippedModule[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    try {
      await assertInsideProject(fs, dir, joinPath(root, entry));
    } catch (cause) {
      if (!(cause instanceof PathEscapesProjectError)) throw cause;
      unreadable.push({ path: `${MODULES_DIR}/${entry}`, reason: 'unsafe-directory' });
      continue;
    }
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
      if (
        !(await isFile(fs, joinPath(root, entry, 'index.ts'))) &&
        !(await isFile(fs, `${base}.controller.ts`))
      )
        continue;
      if (!isKebabIdentifier(entry)) {
        rejected.push(`${MODULES_DIR}/${entry}`);
        continue;
      }
      const symbol = registerModuleSymbol(deriveNames(entry));
      if ((await exportStatus(fs, joinPath(root, entry, 'index.ts'), symbol)) === 'exported')
        names.push(entry);
      else
        skipped.push({
          kind: 'missing-export',
          name: entry,
          path: `${MODULES_DIR}/${entry}`,
          missing: symbol,
        });
      continue;
    }
    if (!isKebabIdentifier(entry)) {
      if (
        (await isFile(fs, `${base}.module.ts`)) ||
        ((await isFile(fs, `${base}.controller.ts`)) && (await isFile(fs, `${base}.service.ts`)))
      ) {
        rejected.push(`${MODULES_DIR}/${entry}`);
      }
      continue;
    }
    const pascal = deriveNames(entry).pascal;
    const module = await exportStatus(fs, `${base}.module.ts`, `${pascal}Module`);
    // Retain diagnostics for pre-declaration generated modules without making
    // their old controller/service locations part of modern module identity.
    if (
      module === 'missing' &&
      !((await isFile(fs, `${base}.controller.ts`)) && (await isFile(fs, `${base}.service.ts`)))
    )
      continue;
    const missing = module === 'missing-export' ? `${pascal}Module` : undefined;
    if (missing !== undefined)
      skipped.push({
        kind: 'missing-export',
        name: entry,
        path: `${MODULES_DIR}/${entry}`,
        missing,
      });
    else if (module === 'missing')
      skipped.push({
        kind: 'legacy',
        name: entry,
        path: `${MODULES_DIR}/${entry}`,
        missing: `${entry}.module.ts`,
      });
    else names.push(entry);
  }

  return {
    names: names.sort(),
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
    rejected: rejected.sort(),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  };
}

/**
 * The request-bound service family of one module (M130 §3.4): the module's own
 * `<m>.token.ts` exporting `<SCREAMING>`. No `exports`, so the scanner never
 * reports it as adopted or hand-wired, and barrel drift skips it; the index
 * renderer reads the admitted name instead.
 *
 * @param module - The module's kebab name
 * @returns The family's seam spec
 */
export function moduleServiceSeam(module: string): SeamSpec {
  const moduleDir = `${MODULES_DIR}/${module}`;
  return {
    schematic: MODULE_SERVICE_ARTIFACTS,
    dir: moduleDir,
    suffix: '.token.ts',
    importSymbols: (names) => [names.screaming],
    barrel: `${moduleDir}/index.ts`,
    exports: [],
    renderBarrel: (artifacts) => renderFunctionalModuleIndex(deriveNames(module), artifacts),
  };
}

/** Options for {@linkcode scanModuleArtifacts}. */
export interface ModuleArtifactScanOptions {
  /** Admit the module's request-bound service token (full-stack functional projects). */
  readonly moduleServices?: boolean;
}

/**
 * Scans controllers inside one admitted feature using the project's controller
 * shape, plus the module's request-bound service token when asked.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project's root directory
 * @param module - The module's kebab name
 * @param mode - The project's generator mode
 * @param options - Which optional families to scan
 * @returns The module's admitted families
 */
export async function scanModuleArtifacts(
  fs: IFileSystem,
  dir: string,
  module: string,
  mode: GeneratorMode = 'functional',
  options: ModuleArtifactScanOptions = {},
): Promise<ArtifactScanAll> {
  const moduleDir = `${MODULES_DIR}/${module}`;
  const controllers: SeamSpec = {
    ...(mode === 'class-based'
      ? {
          ...CONTROLLERS_SEAM,
          alternative: { ...CONTROLLERS_SEAM.alternative!, onlyShapeInBarrel: true },
        }
      : FUNCTIONAL_CONTROLLERS_SEAM),
    dir: moduleDir,
    barrel: `${moduleDir}/index.ts`,
  };
  const withServices = options.moduleServices === true && mode === 'functional';
  const scan = await scanArtifacts(
    fs,
    dir,
    withServices ? [controllers, moduleServiceSeam(module)] : [controllers],
  );
  if (!withServices) return scan;
  // Only the module's own token registers; any other `*.token.ts` is the developer's.
  const own = (scan.artifacts[MODULE_SERVICE_ARTIFACTS] ?? []).filter((name) => name === module);
  return { ...scan, artifacts: { ...scan.artifacts, [MODULE_SERVICE_ARTIFACTS]: own } };
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
