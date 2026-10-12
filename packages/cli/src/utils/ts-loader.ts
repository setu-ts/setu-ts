/**
 * Imports a project's own TypeScript module — `setu.config.ts` or a custom
 * schematic — from the Node CLI.
 *
 * Node cannot import TypeScript that carries decorators (its type stripping
 * rejects them, and a class-based project's config reaches decorated classes),
 * so the module goes through `tsx`, the same runner a generated Node project
 * starts with. Two decisions keep it loading the PROJECT rather than the caller:
 * - the `tsconfig.json` is the one nearest the imported file, walking up from
 *   its directory, never one found from the process's working directory — so
 *   `setu --dir <project>` from elsewhere still honours the project's aliases;
 * - with no `tsconfig.json` anywhere above it, none is used (`false`), rather
 *   than whatever `tsx` would discover around the process.
 *
 * `tsx` is a regular dependency of this package, loaded lazily so that the many
 * commands that never import project code do not pay for it.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loads a module by absolute `file:` URL and returns its exports. */
export type ProjectModuleLoader = (url: string) => Promise<Record<string, unknown>>;

/**
 * The `tsconfig.json` nearest a module, walking up from its directory.
 *
 * @param moduleUrl - The module's absolute `file:` URL
 * @param exists - Whether a path exists; defaults to the real filesystem
 * @returns The configuration's path, or `false` when there is none above it
 */
export function nearestTsconfig(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): string | false {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The default loader: imports the module through `tsx` with its nearest
 * project configuration.
 *
 * @param url - The module's absolute `file:` URL
 * @returns The module's exports
 */
export const importProjectModule: ProjectModuleLoader = async (url) => {
  const { tsImport } = await import('tsx/esm/api');
  const module: unknown = await tsImport(url, { parentURL: url, tsconfig: nearestTsconfig(url) });
  return module as Record<string, unknown>;
};
