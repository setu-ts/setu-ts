/**
 * Turning an existing single-service project into a workspace with that service
 * as its first member.
 *
 * The scaffolded shape is `apps/<name>/…` with a root manifest above it, so a
 * conversion has to MOVE files — which is the reason this was left out of M62 and
 * the reason it is written the way it is here.
 *
 * **It moves only what the CLI itself emits.** The list comes from the project
 * renderer, not from a directory walk, and that is a correctness property rather
 * than caution: `.git` must stay at the repository root, so must a CI
 * configuration, and so must `deno.lock` — a workspace has ONE lockfile, at the
 * top. A conversion that moved "everything" would relocate the repository's
 * history into `apps/<name>/.git` and quietly break the checkout.
 *
 * **Every move is copy → verify → delete, in that order.** `IFileSystem` has no
 * rename, so a move is three operations, and the order decides what a failure
 * leaves behind: this way a crash leaves the file in BOTH places, which is
 * recoverable and reported. The other order loses it.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import { CONFIG_MODULE } from '../constants.ts';
import { joinPath } from '../utils/file-writer.ts';

/**
 * The files and directories a conversion relocates into the member.
 *
 * Every entry is one the CLI emits itself (`templates/project-files.ts` and the
 * seam barrels). Anything else in the project directory stays where it is, which
 * is what keeps `.git`, `.github`, `deno.lock`, `node_modules` and any file a
 * developer added at the repository root — where they belong for a workspace.
 */
export const ADOPTED_ENTRIES: readonly string[] = [
  'deno.json',
  'package.json',
  '.npmrc',
  'tsconfig.json',
  'wrangler.toml',
  'main.ts',
  CONFIG_MODULE,
  'README.md',
  'vite.config.ts',
  'react-router.config.ts',
  'src',
  'app',
  'test',
];

/**
 * The subset of {@linkcode ADOPTED_ENTRIES} that are directories.
 *
 * Named rather than derived at run time, because it is read AFTER the move — by
 * then the directories are empty and a `stat` cannot tell which of them this
 * command was responsible for.
 */
export const ADOPTED_DIRECTORIES: readonly string[] = ['src', 'app', 'test'];

/** One entry a conversion will relocate. */
export interface AdoptedFile {
  /** Path relative to the project root, e.g. `src/routes/index.ts`. */
  readonly from: string;
  /** Path relative to the workspace root, e.g. `apps/orders/src/routes/index.ts`. */
  readonly to: string;
}

/** What planning a conversion produced. */
export type AdoptPlan =
  | { readonly ok: true; readonly files: readonly AdoptedFile[] }
  | { readonly ok: false; readonly message: string };

/**
 * Lists every file under a directory, relative to it.
 *
 * @param fs - The filesystem to read through
 * @param root - The directory to walk (absolute)
 * @param prefix - The relative prefix accumulated so far
 * @returns Relative paths of the files found
 */
async function walk(
  fs: IFileSystem,
  root: string,
  prefix: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(joinPath(root, prefix))) {
    const relative = prefix === '' ? entry : joinPath(prefix, entry);
    const stat = await fs.stat(joinPath(root, relative));
    if (stat.isDirectory) {
      found.push(...(await walk(fs, root, relative)));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/**
 * Plans which of a project's files move into `apps/<member>/`.
 *
 * A directory in {@linkcode ADOPTED_ENTRIES} is walked, so nested source moves
 * with its parent; an entry that is not present is skipped, because the set spans
 * every template and no project has all of them.
 *
 * @param fs - The filesystem to read through
 * @param project - The existing project directory (absolute)
 * @param memberRoot - Where the member lands, relative to the workspace root
 * @returns The moves, or the refusal to print
 */
export async function planAdoption(
  fs: IFileSystem,
  project: string,
  memberRoot: string,
): Promise<AdoptPlan> {
  // The one file that makes this a Setu project. Without it there is no plugin
  // list to move and nothing here would produce a working member.
  try {
    await fs.stat(joinPath(project, CONFIG_MODULE));
  } catch {
    return {
      ok: false,
      message: `No ${CONFIG_MODULE} in ${project}, so this is not a Setu project. ` +
        `A conversion needs one: it becomes the first member's application factory.`,
    };
  }

  const files: AdoptedFile[] = [];
  for (const entry of ADOPTED_ENTRIES) {
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(joinPath(project, entry))).isDirectory;
    } catch {
      // Absent: the entry set spans every template, and no project has all of it.
      continue;
    }

    if (!isDirectory) {
      files.push({ from: entry, to: joinPath(memberRoot, entry) });
      continue;
    }

    for (const nested of await walk(fs, project, entry)) {
      files.push({ from: nested, to: joinPath(memberRoot, nested) });
    }
  }

  return { ok: true, files };
}

/** What a single move did. */
export type MoveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Moves one file: copy, verify, then delete the original.
 *
 * The verification is a byte-length comparison rather than a hash — enough to
 * catch a truncated write, which is the failure that would otherwise delete the
 * only copy of a file.
 *
 * @param fs - The filesystem to move through
 * @param project - The project root the paths are relative to (absolute)
 * @param file - The move to perform
 * @returns Whether it completed
 */
export async function moveFile(
  fs: IFileSystem,
  project: string,
  file: AdoptedFile,
): Promise<MoveOutcome> {
  const from = joinPath(project, file.from);
  const to = joinPath(project, file.to);

  try {
    const bytes = await fs.readFile(from);
    const parent = to.slice(0, to.lastIndexOf('/'));
    if (parent !== '') await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(to, bytes);

    const written = await fs.readFile(to);
    if (written.byteLength !== bytes.byteLength) {
      return {
        ok: false,
        message: `Copied ${file.from} to ${file.to} but the copy is ` +
          `${written.byteLength} bytes against ${bytes.byteLength} — the original is untouched.`,
      };
    }

    // Only now. A crash before this leaves the file in both places, which is
    // recoverable; the other order loses it.
    await fs.rm(from);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: `Failed to move ${file.from}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}

/**
 * Removes an adopted directory once every file under it has moved.
 *
 * Without this the project keeps an empty `src/` (and `app/`, `test/`) at the
 * workspace root: `moveFile` deletes files, and a directory whose files have all
 * left is still there. An empty `src/` beside `apps/` reads as a second place
 * source might live.
 *
 * It removes ONLY a directory it can prove is empty of files, and reports the
 * ones it cannot — a symlink, or something a walk cannot classify, is left alone
 * rather than deleted recursively on an assumption.
 *
 * @param fs - The filesystem to prune through
 * @param project - The project root (absolute)
 * @param directories - Top-level directory names that were adopted
 * @returns The directories left in place, with files still in them
 */
export async function pruneAdoptedDirectories(
  fs: IFileSystem,
  project: string,
  directories: readonly string[],
): Promise<readonly string[]> {
  const kept: string[] = [];
  for (const directory of directories) {
    const path = joinPath(project, directory);
    try {
      if (!(await fs.stat(path)).isDirectory) continue;
      const remaining = await walk(fs, project, directory);
      if (remaining.length > 0) {
        kept.push(directory);
        continue;
      }
      await fs.rm(path, { recursive: true });
    } catch {
      // Unreadable or already gone: nothing to prune, and nothing to report — the
      // move itself would have failed loudly first.
    }
  }
  return kept;
}

/**
 * Rewrites the member's entry to bind its allocated port.
 *
 * A standalone project's entry binds the literal `3000`; a member binds the port
 * the workspace allocated it, read from the generated discovery module, so the
 * port it binds and the port its siblings dial stay ONE datum.
 *
 * Returns `undefined` when the entry no longer has the literal to replace — a
 * developer may have changed it — and the caller then reports the two lines to
 * change rather than guessing at an edit.
 *
 * @param entry - The existing entry's contents
 * @param symbol - The exported constant to bind instead
 * @param specifier - The module to import it from
 * @returns The rewritten entry, or undefined when it does not match
 */
export function rewriteEntryPort(
  entry: string,
  symbol: string,
  specifier: string,
): string | undefined {
  const binding = /await app\.start\(\{ port: 3000 \}\);/;
  if (!binding.test(entry)) return undefined;

  const imported = entry.replace(
    `import { createApp } from './${CONFIG_MODULE}';\n`,
    `import { createApp } from './${CONFIG_MODULE}';\nimport { ${symbol} } from '${specifier}';\n`,
  );
  return imported.replace(binding, `await app.start({ port: ${symbol} });`);
}
