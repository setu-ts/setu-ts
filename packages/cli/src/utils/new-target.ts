/** Shared target inspection for generated projects and downloaded examples. @module */
import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';
import { interruptedRunRetryHint, joinPath } from './file-writer.ts';
import { escapeName } from './names.ts';

/**
 * Checks every directory component before a scaffold is written.
 *
 * The interrupted-run hint (which tells the user to delete the directory) is
 * added only when every existing entry is one this run would itself create, so
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
  const plannedTop = new Set((planned ?? []).map((path) => path.split('/')[0]));
  const hint =
    !contents.includes('.git') && entries.every((entry) => plannedTop.has(entry))
      ? interruptedRunRetryHint(
          entries.map((entry) => joinPath(root, entry)),
          root,
        )
      : undefined;
  return hint === undefined ? [refusal] : [refusal, hint];
}
