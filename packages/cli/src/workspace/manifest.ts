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
import { DEFAULT_TRANSPORT, getTransport, type TransportName } from './transport.ts';

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

/** The lowest port a member may bind. */
export const MIN_PORT = 1;

/** The highest port a member may bind. */
export const MAX_PORT = 65535;

/**
 * Reports whether a value is a port a member can actually bind.
 *
 * Applied to every port the CLI reads or derives, not only to the `--port`
 * flag. This manifest is documented as hand-editable, and `app.start()` rejects
 * anything outside this range outright (`Invalid port (out of range): 99999`),
 * so a number that reaches a generated module unchecked produces a workspace
 * whose members cannot start — from a command that reported success.
 *
 * `0` is excluded for a subtler reason than the rest: it BINDS, on an arbitrary
 * free port, so the member starts and looks healthy while every sibling
 * dialling `0` is refused.
 *
 * @param value - The candidate port
 * @returns True when a member could bind it
 */
export function isUsablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= MIN_PORT && value <= MAX_PORT;
}

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
  /**
   * How members talk to each other.
   *
   * Recorded at the WORKSPACE level, and read by every `generate app` after it,
   * because members can only meet on a bus they share — a per-member transport
   * would make a workspace whose services silently cannot reach each other
   * trivially expressible.
   */
  readonly transport: TransportName;
  /**
   * Where the transport's broker listens, when it has one.
   *
   * Omitted for `http`, `grpc` and `memory`, which have no endpoint to name.
   */
  readonly transportUrl?: string;
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
  | { readonly kind: 'unsupported-version'; readonly version: number }
  /**
   * Well-formed, but a port in it is one no member could bind.
   *
   * Reported separately from `malformed` so the refusal can NAME the number and
   * the field it came from. "This is not a readable workspace manifest" would
   * send a developer looking for a syntax error in a file whose only problem is
   * a typo'd port.
   */
  | {
    readonly kind: 'invalid-port';
    /** The offending value, exactly as it appeared. */
    readonly port: number;
    /** `basePort`, or the member whose port it is. */
    readonly field: string;
  }
  /**
   * Well-formed, but naming a transport this CLI does not know.
   *
   * Refused rather than defaulted to `http`: quietly moving every member off
   * the bus the manifest asked for would leave services that cannot reach each
   * other and no diagnostic saying why.
   */
  | { readonly kind: 'unknown-transport'; readonly transport: string };

/** The result of reading a workspace manifest. */
export type WorkspaceManifestResult =
  | { readonly ok: true; readonly manifest: WorkspaceManifest }
  | { readonly ok: false; readonly problem: WorkspaceManifestProblem };

/**
 * Narrows one parsed `members` entry to the right SHAPE.
 *
 * The port's RANGE is checked by the caller rather than here, so that a
 * plausible-but-unusable port is reported as the invalid port it is instead of
 * as an unreadable manifest.
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
  if (typeof port !== 'number') return undefined;
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
  if (typeof basePort !== 'number') return { ok: false, problem: { kind: 'malformed' } };
  if (!isUsablePort(basePort)) {
    return { ok: false, problem: { kind: 'invalid-port', port: basePort, field: 'basePort' } };
  }

  // Absent → `http`, so a workspace created before the transport choice existed
  // keeps working and keeps its behaviour. An unrecognised value is refused
  // rather than defaulted: silently downgrading a member to HTTP because the
  // manifest names a broker this CLI does not know is the "flag vanished" class
  // one level up.
  const rawTransport = record['transport'];
  const transport = rawTransport === undefined ? DEFAULT_TRANSPORT : rawTransport;
  if (typeof transport !== 'string' || getTransport(transport) === undefined) {
    return { ok: false, problem: { kind: 'unknown-transport', transport: String(transport) } };
  }

  const rawUrl = record['transportUrl'];
  if (rawUrl !== undefined && typeof rawUrl !== 'string') {
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
    // Checked on the way IN, so an unusable port can never reach a generated
    // module. Every member's port is written into its own `main.ts` binding and
    // into every sibling's discovery map, so one bad value breaks the whole
    // workspace — and `generate app` would otherwise report success while doing
    // it.
    if (!isUsablePort(member.port)) {
      return {
        ok: false,
        problem: { kind: 'invalid-port', port: member.port, field: `member "${member.name}"` },
      };
    }
    members.push(member);
  }

  return {
    ok: true,
    manifest: {
      version,
      basePort,
      transport: transport as TransportName,
      ...(rawUrl === undefined ? {} : { transportUrl: rawUrl }),
      members,
    },
  };
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
 * Returns `undefined` rather than a number past {@linkcode MAX_PORT}: a
 * workspace based at 65535 has exactly one member's worth of room, and handing
 * out 65536 would write a `main.ts` that throws `Invalid port (out of range)`
 * the first time it runs.
 *
 * @param manifest - The workspace's current state
 * @returns The port for the next member, or undefined when the range is spent
 */
export function allocatePort(manifest: WorkspaceManifest): number | undefined {
  let highest = manifest.basePort - 1;
  for (const member of manifest.members) {
    if (member.port > highest) highest = member.port;
  }
  const next = highest + 1;
  return isUsablePort(next) ? next : undefined;
}
