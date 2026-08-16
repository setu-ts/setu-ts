/**
 * Discovery of the migrations already present in a target project.
 *
 * The `migration` schematic renders a runner listing every migration in order,
 * and a schematic is a pure function that performs no I/O — so the read happens
 * at the command layer and the result is handed in through
 * `SchematicOptions.migrations`, exactly the route `readModuleNames` takes.
 *
 * Deliberately NOT a `SeamSpec`. `seams/registry.ts` states that nothing in the
 * framework reads migration files — no plugin calls `ctx.cli.register`, so
 * `setu db:migrate` does not exist and there is no registration site — and that
 * stays true: what the schematic emits is a PROJECT-local runner, not a
 * framework seam. Making it a seam would put a barrel into `setu.config.ts`
 * that no plugin option consumes.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import { joinPath } from './file-writer.ts';

/** Where `setu generate migration` places migrations, relative to the project root. */
export const MIGRATIONS_DIR = 'src/migrations';

/** The files the schematic owns, which are never themselves migrations. */
const OWNED = new Set(['index.ts', 'run.ts']);

/**
 * A migration file name is `<14-digit timestamp>-<kebab>.ts`.
 *
 * Matched rather than assumed, so an unrelated helper a developer drops into
 * this directory is not run as a migration — the M60 lesson about admitting a
 * candidate on filename alone.
 */
const MIGRATION_FILE = /^\d{14}-[a-z0-9-]+\.ts$/;

/**
 * Lists the migrations under `src/migrations/`, in application order.
 *
 * Sorted by filename, which IS the order: the leading timestamp is what orders
 * a migration, and a plain sort over a fixed-width numeric prefix is
 * chronological.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory to scan
 * @returns The migration file names, without the `.ts` suffix, oldest first
 */
export async function readMigrationNames(
  fs: IFileSystem,
  dir: string,
): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await fs.readdir(joinPath(dir, MIGRATIONS_DIR));
  } catch {
    // No migrations directory yet: the first `generate migration` creates it.
    return [];
  }

  return entries
    .filter((entry) => !OWNED.has(entry) && MIGRATION_FILE.test(entry))
    .map((entry) => entry.slice(0, -'.ts'.length))
    .sort();
}
