/** Shared target inspection for generated projects and downloaded examples. @module */
import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';
import { interruptedRunRetryHint, joinPath } from './file-writer.ts';
import { escapeName } from './names.ts';

/**
 * Checks every directory component before a scaffold is written.
 *
 * The interrupted-run hint (which tells the user to delete the directory) is
 * added only when every existing file is a path this run would itself write, so
 * a directory holding the user's own files or a git repository is never called debris.
 *
 * @param fs - The target filesystem
 * @param root - The resolved project directory
 * @param planned - The project-relative paths this run plans to write, when known
 * @returns A refusal and optional interrupted-run hint, or no refusal
 */
export async function newTargetRefusal(
  fs: IFileSystem,
  root: string,
  planned?: readonly string[],
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
    !contents.includes('.git') && (await onlyPlannedFiles(fs, root, entries, planned ?? []))
      ? interruptedRunRetryHint(
          entries.map((entry) => joinPath(root, entry)),
          root,
        )
      : undefined;
  return hint === undefined ? [refusal] : [refusal, hint];
}

/**
 * Whether every file under `root` is a path this run plans to write, and every
 * directory one those paths need. A shared top-level name (`src/`) is not
 * ownership: an unplanned file anywhere beneath it withholds the hint.
 *
 * @param fs - The target filesystem
 * @param root - The resolved project directory
 * @param entries - The top-level entries of `root`, `.git` excluded
 * @param planned - The project-relative paths this run plans to write
 * @returns True when nothing under `root` is outside the plan
 */
async function onlyPlannedFiles(
  fs: IFileSystem,
  root: string,
  entries: readonly string[],
  planned: readonly string[],
): Promise<boolean> {
  const files = new Set(planned);
  const dirs = new Set(
    planned.flatMap((path) =>
      path
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
    ),
  );
  const pending = [...entries];
  try {
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
      const full = joinPath(root, path);
      if (!(await fs.stat(full)).isDirectory) {
        if (!files.has(path)) return false;
      } else if (!dirs.has(path)) {
        return false;
      } else {
        for (const entry of await fs.readdir(full)) pending.push(`${path}/${entry}`);
      }
    }
  } catch {
    // An entry that cannot be inspected is not shown to be this run's own output.
    return false;
  }
  return true;
}
