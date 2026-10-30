/** Bounded, link-refusing traversal of artifact directories. @module */
import type { IFileSystem } from '@setu-ts/common';
import { assertInsideProject, joinPath } from './file-writer.ts';
import { isMissingPath } from './filesystem-errors.ts';

/** A directory deliberately left out of a scan, relative to the project root. */
export interface IUnreadableDirectory {
  readonly path: string;
  readonly reason: 'unsafe-directory' | 'depth-limit' | 'unreadable-directory';
}

/** At most eight subdirectories below an artifact family's root. */
const MAX_ARTIFACT_DEPTH = 8;

/**
 * Lists files relative to a family root. Every directory is verified before
 * reading it; links inside the project (including cycles) are never traversed.
 * Missing roots are ordinary, while an incomplete walk is reported to callers.
 */
export async function walkArtifactFiles(
  fs: IFileSystem,
  dir: string,
  family: string,
): Promise<{
  readonly files: readonly string[];
  readonly unreadable: readonly IUnreadableDirectory[];
}> {
  const files: string[] = [];
  const unreadable: IUnreadableDirectory[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    const projectPath = relative === '' ? family : joinPath(family, relative);
    const absolute = joinPath(dir, projectPath);
    if (depth > MAX_ARTIFACT_DEPTH) {
      unreadable.push({ path: projectPath, reason: 'depth-limit' });
      return;
    }
    // `assertInsideProject` reports every failure, an unresolvable link
    // included, as a `PathEscapesProjectError`: each means the directory cannot
    // be verified, so it is reported rather than walked.
    try {
      await assertInsideProject(fs, dir, absolute);
    } catch {
      unreadable.push({ path: projectPath, reason: 'unsafe-directory' });
      return;
    }
    let entries: readonly string[];
    try {
      entries = await fs.readdir(absolute);
    } catch (cause) {
      if (!isMissingPath(cause))
        unreadable.push({ path: projectPath, reason: 'unreadable-directory' });
      return;
    }
    for (const entry of entries) {
      const path = relative === '' ? entry : joinPath(relative, entry);
      let directory = false;
      try {
        directory = (await fs.stat(joinPath(dir, family, path))).isDirectory;
      } catch {
        // A dangling link or a self-link can fail stat before it identifies a
        // directory. Resolve that case too; ordinary file-read failures still
        // belong to the artifact reader.
        try {
          await assertInsideProject(fs, dir, joinPath(dir, family, path));
        } catch {
          unreadable.push({ path: joinPath(family, path), reason: 'unsafe-directory' });
          continue;
        }
      }
      if (directory) await visit(path, depth + 1);
      else files.push(path);
    }
  };
  await visit('', 0);
  return { files, unreadable };
}
