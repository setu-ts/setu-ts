/**
 * The workspace manifest — the CLI's record of a monorepo's members.
 *
 * A Setu workspace is a Deno workspace: its root `deno.json` declares
 * `"workspace": ["./apps/*"]`, a GLOB, so Deno discovers members on its own and
 * adding one never rewrites a file the developer edits. What a glob cannot
 * carry is the port each member binds, and that has to be recorded somewhere
 * the CLI can read before it renders anything — so this file holds it, and the
 * per-member `src/discovery/services.ts` modules are DERIVED from it.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import { joinPath } from '../utils/file-writer.ts';

/** The workspace manifest's filename, at the workspace root. */
export const WORKSPACE_MANIFEST = 'setu.workspace.json';

/** Where workspace members live, relative to the workspace root. */
export const MEMBERS_DIR = 'apps';

/**
 * The manifest shape this CLI writes and reads.
 *
 * Bumped only for a change a previous CLI could not read correctly;
 * {@linkcode readWorkspaceManifest} refuses anything else rather than guessing
 * at a shape it does not know.
 */
export const WORKSPACE_VERSION = 1;

/** The port the first member of a workspace binds, unless `--port` says otherwise. */
export const DEFAULT_BASE_PORT = 3000;

/** One member of a workspace. */
export interface WorkspaceMember {
  /** The member's directory name under `apps/`, and its service name in every sibling's map. */
  readonly name: string;
  /** The port this member binds, and the port its siblings dial. */
  readonly port: number;
}

/** A workspace's CLI-owned record of itself. */
export interface WorkspaceManifest {
  /** Manifest shape version; see {@linkcode WORKSPACE_VERSION}. */
  readonly version: number;
  /** Floor for port allocation. */
  readonly basePort: number;
  /** Every member, in creation order. */
  readonly members: readonly WorkspaceMember[];
}

/** Why a workspace manifest could not be used. */
export type WorkspaceManifestProblem =
  /** No manifest at this path — the directory is not a workspace root. */
  | { readonly kind: 'absent' }
  /** Present but unreadable as a manifest: malformed JSON, or the wrong shape. */
  | { readonly kind: 'malformed' }
  /** Present and well-formed, but written by a CLI this one does not understand. */
  | { readonly kind: 'unsupported-version'; readonly version: number };

/** The result of reading a workspace manifest. */
export type WorkspaceManifestResult =
  | { readonly ok: true; readonly manifest: WorkspaceManifest }
  | { readonly ok: false; readonly problem: WorkspaceManifestProblem };

/**
 * Narrows one parsed `members` entry.
 *
 * @param value - The parsed entry
 * @returns The member, or undefined when the entry is not one
 */
function toMember(value: unknown): WorkspaceMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const port = record['port'];
  if (typeof name !== 'string' || name === '') return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port)) return undefined;
  return { name, port };
}

/**
 * Reads and validates the workspace manifest in a directory.
 *
 * Every failure is REPORTED rather than thrown, and the three kinds are told
 * apart: "this is not a workspace" and "this workspace's manifest is broken"
 * need different advice, and a version this CLI does not know must never be
 * read with a guessed shape.
 *
 * @param fs - The filesystem to read through
 * @param dir - The workspace root (absolute)
 * @returns The manifest, or why it could not be used
 */
export async function readWorkspaceManifest(
  fs: IFileSystem,
  dir: string,
): Promise<WorkspaceManifestResult> {
  let raw: Uint8Array;
  try {
    raw = await fs.readFile(joinPath(dir, WORKSPACE_MANIFEST));
  } catch {
    return { ok: false, problem: { kind: 'absent' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, problem: { kind: 'malformed' } };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, problem: { kind: 'malformed' } };
  }
  const record = parsed as Record<string, unknown>;

  const version = record['version'];
  if (typeof version !== 'number') return { ok: false, problem: { kind: 'malformed' } };
  if (version !== WORKSPACE_VERSION) {
    return { ok: false, problem: { kind: 'unsupported-version', version } };
  }

  const basePort = record['basePort'];
  if (typeof basePort !== 'number' || !Number.isInteger(basePort)) {
    return { ok: false, problem: { kind: 'malformed' } };
  }

  const rawMembers = record['members'];
  if (!Array.isArray(rawMembers)) return { ok: false, problem: { kind: 'malformed' } };

  const members: WorkspaceMember[] = [];
  for (const entry of rawMembers) {
    const member = toMember(entry);
    // One bad entry invalidates the manifest rather than being dropped: a
    // silently omitted member is a member every sibling's map stops naming, and
    // the CLI would then reallocate its port to someone else.
    if (member === undefined) return { ok: false, problem: { kind: 'malformed' } };
    members.push(member);
  }

  return { ok: true, manifest: { version, basePort, members } };
}

/**
 * Renders a workspace manifest as the file's contents.
 *
 * @param manifest - The manifest to serialize
 * @returns The `setu.workspace.json` contents
 */
export function renderWorkspaceManifest(manifest: WorkspaceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Chooses the port a new member binds.
 *
 * One above the highest port in use, never below the base. Derived from the
 * MAXIMUM rather than from the member count, so adding a member can never
 * change the port an existing one binds — an index-derived port would shift
 * every member sorting after a newly inserted name, silently moving a running
 * service.
 *
 * @param manifest - The workspace's current state
 * @returns The port for the next member
 */
export function allocatePort(manifest: WorkspaceManifest): number {
  let highest = manifest.basePort - 1;
  for (const member of manifest.members) {
    if (member.port > highest) highest = member.port;
  }
  return highest + 1;
}
