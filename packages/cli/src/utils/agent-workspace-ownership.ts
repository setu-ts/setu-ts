import { dirName } from './file-writer.ts';
import type { ICliFileSystem } from './file-writer.ts';
import { isMissingPath } from './filesystem-errors.ts';

/**
 * The remedy a refusal names, chosen for its reason.
 *
 * A symlink inside a workspace and a directory another user owns need opposite
 * advice: telling the developer of a link to "run `setu agents` in a workspace
 * you own" sends them to the workspace they are already in. The symlink remedy
 * names the link's real path when it can be resolved.
 */
async function remedyFor(
  fs: ICliFileSystem,
  directory: string,
  reason: 'symlink' | 'not a directory' | 'not owned by you',
): Promise<string> {
  if (reason === 'symlink') {
    const real =
      fs.realPath === undefined ? undefined : await fs.realPath(directory).catch(() => undefined);
    return (
      'replace the link with the directory it points at, or run setu agents from its real path' +
      (real === undefined ? '' : ` (${real})`)
    );
  }
  if (reason === 'not a directory')
    return 'fix the workspace layout so every member path is a directory';
  return 'run `setu agents` in a workspace you own';
}

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
        throw new Error(`${current}: ${reason}; ${await remedyFor(fs, current, reason)}`);
      checked.add(current);
      if (dirName(current) === current || dirName(current) === '') break;
    }
  }
}
