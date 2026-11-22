/** Shared target inspection for generated projects and downloaded examples. @module */
import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';
import { interruptedRunRetryHint, joinPath, readExistingText } from './file-writer.ts';
import { escapeName } from './names.ts';

/** One file the run plans to write, as the target check compares it. */
export interface PlannedFile {
  /** Project-relative path. */
  readonly path: string;
  /** The text the run writes there. */
  readonly contents: string;
  /** True for a file holding a generated secret, which differs on every run. */
  readonly secret?: boolean;
}

/**
 * Checks every directory component before a scaffold is written.
 *
 * The interrupted-run hint (which tells the user to delete the directory) is
 * added only when every existing file holds exactly what this run would write
 * there, so a directory holding the user's own files or a git repository is
 * never called debris.
 *
 * @param fs - The target filesystem
 * @param root - The resolved project directory
 * @param planned - Resolves the files this run plans to write, exactly as written
 *   (formatted), when known; called only for a non-empty target
 * @returns A refusal and optional interrupted-run hint, or no refusal
 */
export async function newTargetRefusal(
  fs: IFileSystem,
  root: string,
  planned?: () => Promise<readonly PlannedFile[]>,
): Promise<readonly string[]> {
  let path = '';
  for (const segment of root.split('/').filter(Boolean)) {
    path = `${path}/${segment}`;
    try {
      if (!(await fs.stat(path)).isDirectory) {
        return [
          `Cannot create ${escapeName(root)}: ${escapeName(path)} is a file, not a directory.`,
        ];
      }
    } catch (cause) {
      if (isMissingPath(cause)) return [];
      throw cause;
    }
  }
  const contents = await fs.readdir(root);
  const entries = contents.filter((entry) => entry !== '.git');
  if (entries.length === 0) return [];
  const refusal = `${escapeName(root)} already exists and is not empty (${entries.length} entries); choose another name or empty it.`;
  const hint =
    !contents.includes('.git') &&
    planned !== undefined &&
    (await onlyPlannedFiles(fs, root, entries, planned))
      ? interruptedRunRetryHint(
          entries.map((entry) => joinPath(root, entry)),
          root,
        )
      : undefined;
  return hint === undefined ? [refusal] : [refusal, hint];
}

/**
 * Whether everything under `root` is this run's own output: each file holds the
 * bytes the run would write at that path, and each directory is one a planned
 * path needs. A path match alone is not ownership (a user's `main.ts` sits at a
 * planned path too), so content decides. A secret file differs on every run and
 * counts by path only; at least one non-secret file must match, so a user's own
 * `.env` alone never earns the hint.
 *
 * @param fs - The target filesystem
 * @param root - The resolved project directory
 * @param entries - The top-level entries of `root`, `.git` excluded
 * @param resolve - Resolves the files this run plans to write, as written
 * @returns True when nothing under `root` is outside the plan
 */
async function onlyPlannedFiles(
  fs: IFileSystem,
  root: string,
  entries: readonly string[],
  resolve: () => Promise<readonly PlannedFile[]>,
): Promise<boolean> {
  let planned: readonly PlannedFile[];
  try {
    planned = await resolve();
  } catch {
    // Without the bytes the run would write, nothing is shown to be its own output.
    return false;
  }
  const files = new Map(planned.map((file) => [file.path, file]));
  const dirs = new Set(
    planned.flatMap((file) =>
      file.path
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
    ),
  );
  const pending = [...entries];
  let matched = 0;
  try {
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
      const full = joinPath(root, path);
      if ((await fs.stat(full)).isDirectory) {
        if (!dirs.has(path)) return false;
        for (const entry of await fs.readdir(full)) pending.push(`${path}/${entry}`);
        continue;
      }
      const file = files.get(path);
      if (file === undefined) return false;
      if (file.secret === true) continue;
      if ((await readExistingText(fs, full)) !== file.contents) return false;
      matched++;
    }
  } catch {
    // An entry that cannot be inspected is not shown to be this run's own output.
    return false;
  }
  return matched > 0;
}
