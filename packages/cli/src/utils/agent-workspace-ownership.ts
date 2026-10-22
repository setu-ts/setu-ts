import { dirName } from './file-writer.ts';
import type { ICliFileSystem } from './file-writer.ts';
import { isMissingPath } from './filesystem-errors.ts';

/**
 * Refuses workspace writes when a write target's parents belong to another user, the
 * git `safe.directory` model: every directory up to `/` must be owned by the invoking
 * user or root, and must not be a symlink. Permission bits are not checked, so a
 * directory you own but others can write is trusted (the same limit git has).
 * Missing targets are checked from their nearest existing ancestor through the root.
 * This validates ownership only; a missing member still fails project detection.
 * Without the optional ownership seam or invoking uid (fakes and Windows), this
 * check is skipped; Windows is not protected by this POSIX ownership rule.
 * Paths in thrown errors are escaped by the agents command's terminal boundary.
 */
export async function assertAgentWorkspaceOwnership(
  fs: ICliFileSystem,
  directories: readonly string[],
): Promise<void> {
  if (fs.directoryOwnership === undefined || fs.invokingUid === undefined) return;
  const checked = new Set<string>();
  for (const directory of directories) {
    for (let current = directory; !checked.has(current); current = dirName(current)) {
      const stat = await fs.directoryOwnership(current).catch((cause: unknown) => {
        const parent = dirName(current);
        if (isMissingPath(cause) && parent !== current && parent !== '') return undefined;
        throw new Error(
          `${current}: cannot check directory ownership; run \`setu agents\` in a workspace you own`,
          { cause },
        );
      });
      if (stat === undefined) continue;
      const reason = stat.isSymbolicLink
        ? 'symlink'
        : !stat.isDirectory
          ? 'not a directory'
          : stat.uid !== fs.invokingUid && stat.uid !== 0
            ? 'not owned by you'
            : undefined;
      if (reason !== undefined)
        throw new Error(`${current}: ${reason}; run \`setu agents\` in a workspace you own`);
      checked.add(current);
      if (dirName(current) === current || dirName(current) === '') break;
    }
  }
}
