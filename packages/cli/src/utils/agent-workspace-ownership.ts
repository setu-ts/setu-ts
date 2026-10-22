import { dirName } from './file-writer.ts';
import type { ICliFileSystem } from './file-writer.ts';

/**
 * Refuses ancestor adoption when another user can rearrange a write target's parents.
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
      const stat = await fs.directoryOwnership(current);
      const reason = stat.isSymbolicLink
        ? 'symlink'
        : !stat.isDirectory
          ? 'not a directory'
          : stat.uid !== fs.invokingUid && stat.uid !== 0
            ? 'not owned by you'
            : (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)
              ? 'writable by others'
              : undefined;
      if (reason !== undefined)
        throw new Error(`${current}: ${reason}; run \`setu agents\` in a workspace you own`);
      checked.add(current);
      if (dirName(current) === current || dirName(current) === '') break;
    }
  }
}
