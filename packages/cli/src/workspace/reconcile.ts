/** Workspace-manifest reconciliation against member directories. */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { joinPath } from '../utils/file-writer.ts';
import { escapeName } from '../utils/names.ts';
import { MEMBERS_DIR, WORKSPACE_MANIFEST, type WorkspaceManifest } from './manifest.ts';

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

/**
 * Renders the refusal for a failed reconciliation, branched on its reason.
 *
 * Shared by every command that reconciles, so the two cannot drift. The
 * remove-the-entry advice is given ONLY for a missing directory: a directory
 * that exists but cannot be inspected (a permission error) is still a valid
 * member, and removing its manifest entry would delete real configuration.
 *
 * @param failure - The failed reconciliation
 * @returns The message to report
 */
export function describeReconcileFailure(
  failure: Extract<ReconcileResult, { readonly ok: false }>,
): string {
  const path = joinPath(MEMBERS_DIR, failure.member);
  if (failure.reason === 'unreadable') {
    return `Member "${escapeName(failure.member)}" is in ${WORKSPACE_MANIFEST} but ${
      escapeName(path)
    } cannot be ` +
      `inspected. Fix its access permissions, then run this again.`;
  }
  return `Member "${escapeName(failure.member)}" is in ${WORKSPACE_MANIFEST} but ${
    escapeName(path)
  } does not exist. ` +
    `Remove its entry (and its dependsOn references) from the manifest, or restore the ` +
    `directory, then run this again.`;
}
