/**
 * Node module-resolution hook for test subprocesses: `@setu-ts/*` resolves to workspace source,
 * as it does inside Vitest, instead of to a member's built `dist/` (absent on a fresh checkout and
 * stale after an edit).
 *
 * One importer is exempt: a project a test INSTALLED under the repository's `.tmp/`. Its
 * `node_modules` holds the tree's packed tarballs, which is what such a test exists to exercise —
 * redirecting its imports to source would let a broken export or packaging defect pass. A temp file
 * with no install of the package still resolves to source, as before.
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceExport } from '../scripts/codemods/workspace-sources.ts';

type Resolved = { url: string; shortCircuit?: boolean };

/** The repository's scratch root; installed test projects live below it. */
const SCRATCH = fileURLToPath(new URL('../.tmp/', import.meta.url));

/**
 * Whether `parentURL` belongs to a project under `.tmp/` that has `name` installed.
 *
 * @param parentURL - The importing module's URL, if any
 * @param name - The package name (`@setu-ts/<member>`)
 * @returns `true` when Node should resolve the import from that install
 */
export function installedForImporter(parentURL: string | undefined, name: string): boolean {
  if (parentURL === undefined || !parentURL.startsWith('file:')) return false;
  let dir = dirname(fileURLToPath(parentURL));
  if (!dir.startsWith(SCRATCH)) return false;
  while (dir.startsWith(SCRATCH) && dir.length > SCRATCH.length - 1) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    dir = dirname(dir);
  }
  return false;
}

/** Resolves workspace specifiers to source; defers everything else. */
export function resolve(
  specifier: string,
  context: { parentURL?: string },
  next: (specifier: string, context: unknown) => Resolved | Promise<Resolved>,
): Resolved | Promise<Resolved> {
  const target = sourceExport(specifier);
  if (target === null) return next(specifier, context);
  const name = specifier.split('/').slice(0, 2).join('/');
  return installedForImporter(context.parentURL, name)
    ? next(specifier, context)
    : { url: pathToFileURL(target).href, shortCircuit: true };
}
