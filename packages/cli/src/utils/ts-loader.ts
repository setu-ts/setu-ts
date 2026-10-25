/**
 * Imports a project's own TypeScript module — `setu.config.ts` or a custom
 * schematic — from the Node CLI.
 *
 * Node cannot import TypeScript that carries decorators (its type stripping
 * rejects them, and a class-based project's config reaches decorated classes),
 * so the module goes through `tsx`, the same runner a generated Node project
 * starts with. Two decisions keep it loading the PROJECT rather than the caller:
 * - the `tsconfig.json` is the one nearest the imported file, walking up from
 *   its directory but NEVER above the project root, and never one found from the
 *   process's working directory — so `setu --dir <project>` from elsewhere still
 *   honours the project's aliases;
 * - with no `tsconfig.json` inside the project, none is used (`false`), rather
 *   than whatever `tsx` would discover around the process.
 *
 * The bound is a security property, not tidiness: a `tsconfig.json` is code
 * routing — its `paths` decide which file an `@setu-ts/*` import executes — so a
 * configuration planted in a directory ABOVE the project (a shared parent, `/tmp`)
 * would otherwise run in the developer's process, even over the project's own
 * installed packages. A Deno scaffold carries no `tsconfig.json`, so it is exactly
 * the project that walk would have reached past.
 *
 * `tsx` is a regular dependency of this package, loaded lazily so that the many
 * commands that never import project code do not pay for it.
 *
 * Known limitation (tsx 4.23): `tsImport` also registers a CommonJS hook that
 * discovers configuration from the process rather than from the option passed
 * here, so a project with NO `tsconfig.json` that loads a CommonJS (`.cts`)
 * helper can see another project's path aliases through it. Every scaffolded
 * npm project carries a `tsconfig.json`, and the ES module path — the one
 * `setu.config.ts` and custom schematics take — honours the option.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/**
 * Loads a module by absolute `file:` URL and returns its exports.
 *
 * `root` is the project the module belongs to; configuration is looked up no
 * higher than it.
 */
export type ProjectModuleLoader = (url: string, root?: string) => Promise<Record<string, unknown>>;

/**
 * The `tsconfig.json` nearest a module, walking up from its directory and
 * stopping at the project root.
 *
 * Without a `root`, only the module's own directory is consulted. A module that
 * is not inside `root` is likewise held to its own directory, so no input can
 * extend the walk above the project.
 *
 * @param moduleUrl - The module's absolute `file:` URL
 * @param root - The project root (absolute); the walk never goes above it
 * @param exists - Whether a path exists; defaults to the real filesystem
 * @returns The configuration's path, or `false` when there is none in bounds
 */
export function nearestTsconfig(
  moduleUrl: string,
  root?: string,
  exists: (path: string) => boolean = existsSync,
): string | false {
  let dir = dirname(fileURLToPath(moduleUrl));
  const top = root === undefined ? undefined : resolve(root);
  const inside = top !== undefined && (dir === top || dir.startsWith(`${top}${sep}`));
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (exists(candidate)) return candidate;
    if (!inside || dir === top) return false;
    dir = dirname(dir);
  }
}

/**
 * The default loader: imports the module through `tsx` with its nearest
 * configuration inside the project.
 *
 * @param url - The module's absolute `file:` URL
 * @param root - The project the module belongs to
 * @returns The module's exports
 */
export const importProjectModule: ProjectModuleLoader = async (url, root) => {
  let tsx: typeof import('tsx/esm/api');
  try {
    tsx = await import('tsx/esm/api');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('tsx', {
      requiredBy: '@setu-ts/cli',
      cause: error,
    });
  }
  const { tsImport } = tsx;
  const tsconfig = nearestTsconfig(url, root);
  const module: unknown = await tsImport(url, { parentURL: url, tsconfig });
  return module as Record<string, unknown>;
};
