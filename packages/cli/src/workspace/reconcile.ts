/** Workspace-manifest reconciliation against member directories. */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { joinPath } from '../utils/file-writer.ts';
import { MEMBERS_DIR, type WorkspaceManifest } from './manifest.ts';

/** Result of verifying that every declared member still exists. */
export type ReconcileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly member: string; readonly reason: 'missing' | 'unreadable' };

/** Verifies that each manifest member has its expected directory. */
export async function reconcileMembers(
  fs: IFileSystem,
  dir: string,
  manifest: WorkspaceManifest,
): Promise<ReconcileResult> {
  for (const member of manifest.members) {
    try {
      const stat = await fs.stat(joinPath(dir, MEMBERS_DIR, member.name));
      if (!stat.isDirectory) return { ok: false, member: member.name, reason: 'missing' };
    } catch (cause) {
      return {
        ok: false,
        member: member.name,
        reason: isMissingPath(cause) ? 'missing' : 'unreadable',
      };
    }
  }
  return { ok: true };
}
