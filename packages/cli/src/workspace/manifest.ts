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
import { deriveNames, escapeName, isIdentifierSafe } from '../utils/names.ts';

import { isTargetRuntime, type TargetRuntime } from '../constants.ts';

import { joinPath } from '../utils/file-writer.ts';
import { readEnvFilePath } from '../templates/env-file.ts';
import { isWorkspaceRuntime } from './runtime-profile.ts';
import { DEFAULT_BROKER, getBroker, type BrokerName } from './transport.ts';

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
 *
 * Version 2 (M138) split the one `transport` field into a workspace `broker` and
 * a per-member `rpc`. A version-1 CLI reading a version-2 file would find no
 * `transport`, fall back to `http` and drop the broker without a word, so the
 * bump is what makes it refuse instead. Version 1 is still READ, and mapped
 * (see {@linkcode readWorkspaceManifest}); every write is version 2.
 */
export const WORKSPACE_VERSION = 2;

/** The last manifest version that recorded one `transport` field. */
const LEGACY_TRANSPORT_VERSION = 1;

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
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
  );
}

/** What reading a valued port flag produced. */
export type PortFlagResult =
  { readonly ok: true; readonly port?: number } | { readonly ok: false; readonly message: string };

/**
 * Reads and validates a valued port flag.
 *
 * Shared by `setu new --workspace` (where it sets the base port), `setu
 * generate app` (where it sets one member's), and the devtool opt-in (where it
 * sets one member's devtool port), so no two sites can disagree about what a
 * bindable port is. They already could not disagree with the MANIFEST reader —
 * the range comes from {@linkcode isUsablePort} — and this closes the same gap
 * between the flag sites.
 *
 * Presence is tested, not `stringFlag`: `parseArgs` records a valued flag as the
 * boolean `true` when the next token is itself flag-shaped or absent, so
 * `--port -1` and a trailing `--port` both read as "no value". Testing for a
 * string instead would let the number the user typed vanish without a word.
 *
 * @param flags - The parsed flags
 * @param flag - Which valued port flag to read. Every message names the flag as
 * the user typed it, so a refusal never says `--port` when `--devtool-port` was
 * supplied.
 * @returns The port, `ok` with no port when the flag is absent, or the refusal
 */
export function readPortFlag(
  flags: Readonly<Record<string, string | boolean | readonly string[]>>,
  flag: 'port' | 'devtool-port' = 'port',
): PortFlagResult {
  const raw = flags[flag];
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      message:
        `--${flag} needs a value: expected an integer between ${MIN_PORT} and ${MAX_PORT}. ` +
        `A negative number is read as another flag, so there is no port below ${MIN_PORT}.`,
    };
  }

  const port = Number(raw);
  if (!isUsablePort(port)) {
    return {
      ok: false,
      message: `Invalid --${flag} "${escapeName(
        raw,
      )}": expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    };
  }
  return { ok: true, port };
}

/** One member of a workspace. */
export interface WorkspaceMember {
  /** The member's directory name under `apps/`, and its service name in every sibling's map. */
  readonly name: string;
  /** The port this member binds, and the port its siblings dial. */
  readonly port: number;
  /**
   * Generated secret variable names required from the shell by Compose.
   * @since 0.13.0
   */
  readonly generatedSecrets?: readonly string[];
  /**
   * Custom dotenv paths, relative to the member's directory, that the generated
   * `.env`/`.env.*` rules do not already cover. The managed root
   * `.dockerignore` lists each, so an image never copies the member's secrets.
   * Append-only: a path is never dropped, because the file it names may still
   * hold a secret the CLI generated.
   * @since 0.13.0
   */
  readonly envFilePaths?: readonly string[];
  /**
   * The IPv4 loopback port this member's local diagnostics connector listens
   * on, when the devtool opt-in recorded one.
   *
   * Recorded at `generate app --devtool` / `setu devtool enable` time for the
   * same reason {@linkcode healthProbes} is: the value must be the SAME datum
   * the launcher dials and the member's own generated dev entry binds, and the
   * launcher reads only this manifest.
   *
   * ABSENT means "not enabled", not "unknown": unlike a probe path, a member
   * without a devtool port runs exactly `main.ts` and offers no connector, and
   * the dev runner keys on its presence only for the member the launcher named.
   *
   * Allocated from the recorded connector range by {@linkcode allocateDevtoolPort}.
   * Both allocators avoid configured collisions, including stopped members.
   */
  readonly devtoolPort?: number;
  /** Loopback inspector port allocated for this member's debug script. */
  readonly inspectPort?: number;
  /** Vite HMR port, present only for a full-stack member. */
  readonly vitePort?: number;
  /** Sibling services that must answer `/ready` before this member starts. */
  readonly dependsOn?: readonly string[];
  /**
   * Whether this member serves `/live` and `/ready`.
   *
   * Recorded at `generate app` time, where the chosen template is known, because
   * the Kubernetes renderer has only the manifest. Every named template reaches
   * `HealthPlugin` — the three plugin-list ones declare it and the
   * starter-composed one gets it through the REST tier — so only a
   * template-LESS member answers neither path.
   *
   * ABSENT means "unknown", not "no": a workspace created before M70h has no
   * such record, and the renderer falls back to the TCP probe rather than
   * pointing a probe at a path that may 404 (X2-7).
   */
  readonly healthProbes?: boolean;
  /**
   * Whether this member serves `/metrics`.
   *
   * Recorded at `generate app` time for the same reason {@linkcode healthProbes}
   * is — the Kubernetes renderer has only the manifest, and a member's plugin
   * set is knowable only where the template is chosen. Every named template
   * reaches `MetricsPlugin`, so only a template-LESS member serves neither.
   *
   * ABSENT means "unknown", not "no": the renderer omits the Prometheus
   * annotations rather than pointing a scraper at an endpoint that may not
   * exist (X10-6). It deliberately does NOT reuse `healthProbes`, because the
   * two can diverge and a boolean whose name says one thing while being read
   * for another is how these drift.
   */
  readonly metricsEndpoint?: boolean;
  /**
   * How this member is called, when it co-serves gRPC.
   *
   * ABSENT means `http`, the convention {@linkcode WorkspaceManifest.redisClient}
   * uses: every member serves HTTP, so only the addition is recorded. Per member
   * rather than per workspace, because an HTTP member and a gRPC member still
   * reach each other over HTTP — unlike two members on different brokers.
   */
  readonly rpc?: 'grpc';
}

/** Names the shell variable supplying one member's own secret. */
export function memberSecretVariable(member: string, variable: string): string {
  return `${member.toUpperCase().replaceAll('-', '_')}_${variable}`;
}

/** Lists the member-specific shell variables the workspace README must export. */
export function workspaceSecretVariables(members: readonly WorkspaceMember[]): readonly string[] {
  return members.flatMap((member) =>
    (member.generatedSecrets ?? []).map((variable) => memberSecretVariable(member.name, variable)),
  );
}

/** A workspace's CLI-owned record of itself. */
export interface WorkspaceManifest {
  /** Manifest shape version; see {@linkcode WORKSPACE_VERSION}. */
  readonly version: number;
  /** Floor for port allocation. */
  readonly basePort: number;
  /** Connector allocation range start; absent derives basePort + 1000, capped at MAX_PORT. */
  readonly devtoolBasePort?: number;
  /** Development port range start; absent derives basePort + 2000. */
  readonly devBasePort?: number;
  /**
   * The bus every member publishes to and consumes from.
   *
   * Recorded at the WORKSPACE level, and read by every `generate app` after it,
   * because members can only meet on a bus they share — a per-member broker
   * would make a workspace whose services silently cannot reach each other
   * trivially expressible. How a member is CALLED is per member instead
   * ({@linkcode WorkspaceMember.rpc}).
   */
  readonly broker: BrokerName;
  /** Redis driver; omitted means ioredis. @since 0.11.0 */
  readonly redisClient?: 'node-redis';
  /**
   * Where the broker listens, overriding its local default.
   *
   * Omitted for `memory`, which has no endpoint, and whenever the default holds.
   */
  readonly brokerUrl?: string;
  /**
   * Which toolchain the workspace is built and run with.
   *
   * Recorded at the WORKSPACE level for the same reason the transport is, and
   * with more force: members share one root manifest and one lockfile, so a
   * per-member runtime would make an unbuildable workspace expressible in a flag.
   *
   * **Absent means `deno`**, so every workspace created before this field existed
   * keeps its shape and its behaviour — the same compatibility trick `broker`
   * uses.
   */
  readonly runtime: TargetRuntime;
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
   * Well-formed, but naming a broker this CLI does not know.
   *
   * Refused rather than defaulted to `memory`: quietly moving every member off
   * the bus the manifest asked for would leave services that cannot reach each
   * other and no diagnostic saying why. A version-1 `transport` naming neither a
   * broker nor `http`/`grpc` is reported here too.
   */
  | { readonly kind: 'unknown-broker'; readonly broker: string }
  | { readonly kind: 'unknown-redis-client'; readonly redisClient: string }
  /**
   * Well-formed, but naming a runtime no workspace can be built with.
   *
   * Refused rather than defaulted for the same reason an unknown transport is:
   * quietly rebuilding a workspace with a different toolchain would rewrite every
   * member's manifest and its image.
   */
  | { readonly kind: 'unknown-runtime'; readonly runtime: string }
  /**
   * Well-formed, but a member's name is not one `generate app` could write
   * (M139b): lowercase kebab-case whose derived identifiers are safe. Reported
   * by name, so a workspace that used to accept it does not read as corrupt.
   */
  | { readonly kind: 'invalid-member-name'; readonly name: string }
  /**
   * Well-formed, but two members' generated secrets map to one Compose shell
   * variable (member `admin` with `WEB_SESSION_SECRET` and member `admin-web`
   * with `SESSION_SECRET` both need `ADMIN_WEB_SESSION_SECRET`), so Compose would
   * hand both the same signing key.
   */
  | {
      readonly kind: 'secret-collision';
      readonly variable: string;
      readonly first: string;
      readonly second: string;
    };

/** The result of reading a workspace manifest. */
export type WorkspaceManifestResult =
  | { readonly ok: true; readonly manifest: WorkspaceManifest }
  | { readonly ok: false; readonly problem: WorkspaceManifestProblem };

/**
 * Whether a manifest member name is one `setu generate app` could have
 * written: its own kebab form, and safe as an identifier and a path segment.
 * A member name becomes a directory under `apps/` and is rendered into
 * generated TypeScript (object keys, JSDoc) unquoted: a separator, a dot
 * segment, a quote or a comment terminator would put a member's writes
 * elsewhere or inject code into a caller's `src/transport/index.ts`.
 *
 * @param name - The parsed name
 * @returns `true` when the name is safe to write and render
 */
export function isMemberName(name: string): boolean {
  if (name === '') return false;
  const names = deriveNames(name);
  return names.kebab === name && isIdentifierSafe(names);
}

/**
 * The first pair of members whose generated secrets map to one Compose shell
 * variable (member `admin` with `WEB_SESSION_SECRET` and member `admin-web`
 * with `SESSION_SECRET` both need `ADMIN_WEB_SESSION_SECRET`), so Compose would
 * hand both the same signing key. Checked by the reader and by every command
 * that writes `generatedSecrets`, so no command writes a manifest the reader
 * then refuses.
 *
 * @param members - The members as they are, or would be after a write
 * @returns The collision, or undefined when every shell variable is distinct
 */
export function findSecretCollision(
  members: readonly WorkspaceMember[],
): Extract<WorkspaceManifestProblem, { kind: 'secret-collision' }> | undefined {
  const owners = new Map<string, string>();
  for (const member of members)
    for (const variable of member.generatedSecrets ?? []) {
      const shell = memberSecretVariable(member.name, variable);
      const owner = `${member.name} (${variable})`;
      const first = owners.get(shell);
      if (first !== undefined)
        return { kind: 'secret-collision', variable: shell, first, second: owner };
      owners.set(shell, owner);
    }
  return undefined;
}

/**
 * The sentence naming a manifest problem the generic "not a workspace" refusal
 * does not explain, for every command that reads the manifest.
 *
 * @param problem - Why the manifest could not be used
 * @returns The sentence, or undefined when the generic refusal says enough
 */
export function manifestProblemDetail(problem: WorkspaceManifestProblem): string | undefined {
  if (problem.kind === 'secret-collision') {
    return (
      `Members ${problem.first} and ${problem.second} both need the Compose variable ` +
      `${problem.variable}, so they would share one signing key. Rename a member or its ` +
      'generated secret in the manifest.'
    );
  }
  if (problem.kind !== 'invalid-member-name') return undefined;
  const kebab = deriveNames(problem.name).kebab;
  const rename = isMemberName(kebab) ? ` (for example to "${escapeName(kebab)}")` : '';
  return (
    `Its member "${escapeName(problem.name)}" is not a name \`generate app\` could write: ` +
    'a member name is the lowercase kebab-case form of itself, and every name derived from it is ' +
    `a safe identifier. Rename it${rename} in the manifest and on disk.`
  );
}

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
  const dependsOn = record['dependsOn'];
  const generatedSecrets = record['generatedSecrets'];
  const envFilePaths = record['envFilePaths'];
  if (typeof name !== 'string' || !isMemberName(name)) return undefined;
  // The path is rendered into the managed .dockerignore, so it is held to the
  // same grammar `--env-file` is: relative segments of [A-Za-z0-9._-] only.
  if (
    envFilePaths !== undefined &&
    (!Array.isArray(envFilePaths) ||
      !envFilePaths.every((entry) => {
        if (typeof entry !== 'string') return false;
        const parsed = readEnvFilePath({ 'env-file': entry });
        return parsed.ok && parsed.path === entry;
      }))
  )
    return undefined;
  if (typeof port !== 'number') return undefined;
  if (
    generatedSecrets !== undefined &&
    (!Array.isArray(generatedSecrets) ||
      !generatedSecrets.every(
        (entry) => typeof entry === 'string' && /^[A-Z][A-Z0-9_]*$/.test(entry),
      ))
  )
    return undefined;
  if (
    dependsOn !== undefined &&
    (!Array.isArray(dependsOn) ||
      !dependsOn.every((entry) => typeof entry === 'string' && entry !== ''))
  )
    return undefined;
  // A DEFINED but wrong-shaped devtool port invalidates the manifest rather
  // than being dropped, which is the caller's own rule one level down: a
  // silently omitted `devtoolPort` is an address `ports --reallocate` then
  // rewrites the manifest without, reporting success, while the member's
  // `main.dev.ts` goes on binding the old number and the launcher has nothing
  // left to dial. The two boolean siblings below keep the drop behaviour
  // deliberately: they are released, absent means "unknown" for both, and
  // tightening them would refuse manifests the CLI accepts today. No manifest
  // can carry a malformed `devtoolPort` yet, so this refuses nothing that
  // already exists.
  const devtoolPort = record['devtoolPort'];
  if (devtoolPort !== undefined && typeof devtoolPort !== 'number') return undefined;
  const inspectPort = record['inspectPort'];
  const vitePort = record['vitePort'];
  if (
    (inspectPort !== undefined && typeof inspectPort !== 'number') ||
    (vitePort !== undefined && typeof vitePort !== 'number')
  )
    return undefined;
  // `'http'` is the default spelled out, so it is accepted and dropped; any other
  // value is a style this CLI does not know, and guessing would serve the wrong one.
  const rpc = record['rpc'];
  if (rpc !== undefined && rpc !== 'http' && rpc !== 'grpc') return undefined;
  const healthProbes = record['healthProbes'];
  const metricsEndpoint = record['metricsEndpoint'];
  return {
    name,
    port,
    ...(generatedSecrets === undefined || generatedSecrets.length === 0
      ? {}
      : { generatedSecrets }),
    ...(envFilePaths === undefined || envFilePaths.length === 0 ? {} : { envFilePaths }),
    ...(devtoolPort === undefined ? {} : { devtoolPort }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(typeof healthProbes === 'boolean' ? { healthProbes } : {}),
    ...(typeof metricsEndpoint === 'boolean' ? { metricsEndpoint } : {}),
    ...(inspectPort === undefined ? {} : { inspectPort }),
    ...(vitePort === undefined ? {} : { vitePort }),
    ...(rpc === 'grpc' ? { rpc } : {}),
  };
}

/**
 * Whether a broker's connection value is an endpoint a stored URL may replace.
 *
 * The same rule `--broker-url` applies: `memory` has no endpoint, and the
 * `pubsub` / `service-bus` values are a project id and a secret read from the
 * environment. A hand-edited URL on one of those would otherwise be rendered as
 * that value's fallback — a URL passed as a GCP project id or an Azure
 * connection string.
 *
 * @param broker - A known broker name
 * @returns `true` when a URL may be recorded for it
 */
function addressable(broker: string): boolean {
  return getBroker(broker)?.connection?.urlOverridable === true;
}

/** The bus a manifest records, read from either manifest version. */
type BusRead =
  | {
      readonly ok: true;
      readonly broker: BrokerName;
      readonly brokerUrl?: string;
      /** A version-1 `grpc` transport: every member co-serves gRPC. */
      readonly everyMemberGrpc: boolean;
    }
  | { readonly ok: false; readonly problem: WorkspaceManifestProblem };

/**
 * Reads the broker, and the version-1 transport it replaced.
 *
 * Version 1 recorded ONE `transport` that was either a broker or a call style.
 * It maps as M138 §3.1 tabulates: a broker name is the broker; `grpc` is the
 * in-memory broker with every member on gRPC; `http` or absent is the in-memory
 * broker. A `transportUrl` beside a call style addressed nothing and is refused.
 * A version-2 file still carrying either version-1 field is refused, so a file
 * cannot be half-migrated.
 *
 * @param record - The parsed manifest
 * @param version - Its declared version, already known to be 1 or 2
 * @returns The bus, or why the manifest cannot be used
 */
function readBus(record: Record<string, unknown>, version: number): BusRead {
  const malformed: BusRead = { ok: false, problem: { kind: 'malformed' } };
  if (version === LEGACY_TRANSPORT_VERSION) {
    if (record['broker'] !== undefined || record['brokerUrl'] !== undefined) return malformed;
    // Only an ABSENT field takes the default: an explicit `null` is a value this
    // CLI does not know, refused like any other, never read as the default.
    const transport = record['transport'] === undefined ? 'http' : record['transport'];
    const url = record['transportUrl'];
    if (typeof transport !== 'string') {
      return { ok: false, problem: { kind: 'unknown-broker', broker: String(transport) } };
    }
    if (url !== undefined && typeof url !== 'string') return malformed;
    if (transport === 'http' || transport === 'grpc') {
      if (url !== undefined) return malformed;
      return { ok: true, broker: DEFAULT_BROKER, everyMemberGrpc: transport === 'grpc' };
    }
    if (getBroker(transport) === undefined) {
      return { ok: false, problem: { kind: 'unknown-broker', broker: transport } };
    }
    if (url !== undefined && !addressable(transport)) return malformed;
    return {
      ok: true,
      broker: transport as BrokerName,
      ...(url === undefined ? {} : { brokerUrl: url }),
      everyMemberGrpc: false,
    };
  }
  if (record['transport'] !== undefined || record['transportUrl'] !== undefined) return malformed;
  const broker = record['broker'] === undefined ? DEFAULT_BROKER : record['broker'];
  if (typeof broker !== 'string' || getBroker(broker) === undefined) {
    return { ok: false, problem: { kind: 'unknown-broker', broker: String(broker) } };
  }
  const url = record['brokerUrl'];
  if (url !== undefined && (typeof url !== 'string' || !addressable(broker))) return malformed;
  return {
    ok: true,
    broker: broker as BrokerName,
    ...(url === undefined ? {} : { brokerUrl: url }),
    everyMemberGrpc: false,
  };
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
  if (version !== WORKSPACE_VERSION && version !== LEGACY_TRANSPORT_VERSION) {
    return { ok: false, problem: { kind: 'unsupported-version', version } };
  }

  const devtoolBasePort = record['devtoolBasePort'];
  if (devtoolBasePort !== undefined && typeof devtoolBasePort !== 'number') {
    return { ok: false, problem: { kind: 'malformed' } };
  }
  if (devtoolBasePort !== undefined && !isUsablePort(devtoolBasePort)) {
    return {
      ok: false,
      problem: { kind: 'invalid-port', port: devtoolBasePort, field: 'devtoolBasePort' },
    };
  }
  const devBasePort = record['devBasePort'];
  if (devBasePort !== undefined && typeof devBasePort !== 'number')
    return { ok: false, problem: { kind: 'malformed' } };
  if (devBasePort !== undefined && !isUsablePort(devBasePort))
    return {
      ok: false,
      problem: { kind: 'invalid-port', port: devBasePort, field: 'devBasePort' },
    };
  const basePort = record['basePort'];
  if (typeof basePort !== 'number') return { ok: false, problem: { kind: 'malformed' } };
  if (!isUsablePort(basePort)) {
    return { ok: false, problem: { kind: 'invalid-port', port: basePort, field: 'basePort' } };
  }

  const bus = readBus(record, version);
  if (!bus.ok) return bus;
  const redisClient = record['redisClient'];
  if (redisClient !== undefined && redisClient !== 'node-redis') {
    return {
      ok: false,
      problem: { kind: 'unknown-redis-client', redisClient: String(redisClient) },
    };
  }
  // Absent → `deno`, so a workspace created before this field existed keeps its
  // shape. An unrecognised value is refused rather than defaulted, exactly as an
  // unknown transport is: silently rebuilding a workspace with the wrong
  // toolchain would rewrite every member's manifest and its Dockerfile.
  const rawRuntime = record['runtime'];
  const runtime = rawRuntime === undefined ? 'deno' : rawRuntime;
  if (typeof runtime !== 'string' || !isTargetRuntime(runtime) || !isWorkspaceRuntime(runtime)) {
    return { ok: false, problem: { kind: 'unknown-runtime', runtime: String(runtime) } };
  }

  const rawMembers = record['members'];
  if (!Array.isArray(rawMembers)) return { ok: false, problem: { kind: 'malformed' } };

  const members: WorkspaceMember[] = [];
  for (const entry of rawMembers) {
    const rawName =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['name']
        : undefined;
    if (typeof rawName === 'string' && rawName !== '' && !isMemberName(rawName)) {
      return { ok: false, problem: { kind: 'invalid-member-name', name: rawName } };
    }
    const parsedMember = toMember(entry);
    // A version-1 `grpc` transport meant every member co-served gRPC; version 2
    // records that on each member, so the mapping happens here, once.
    const member =
      parsedMember !== undefined && bus.everyMemberGrpc
        ? { ...parsedMember, rpc: 'grpc' as const }
        : parsedMember;
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
    // Range-checked on the way IN for the same reason `port` is: the value is
    // written into the member's generated dev entry and read by the launcher as
    // its connect address, so one bad number produces a project that cannot
    // start its connector from a command that reported success.
    if (member.devtoolPort !== undefined && !isUsablePort(member.devtoolPort)) {
      return {
        ok: false,
        problem: {
          kind: 'invalid-port',
          port: member.devtoolPort,
          field: `member "${member.name}" devtoolPort`,
        },
      };
    }
    for (const field of ['inspectPort', 'vitePort'] as const)
      if (member[field] !== undefined && !isUsablePort(member[field]))
        return {
          ok: false,
          problem: {
            kind: 'invalid-port',
            port: member[field]!,
            field: `member "${member.name}" ${field}`,
          },
        };
    members.push(member);
  }

  const collision = findSecretCollision(members);
  if (collision !== undefined) return { ok: false, problem: collision };

  const names = new Set(members.map((member) => member.name));
  for (const member of members) {
    const dependencies = member.dependsOn ?? [];
    if (
      dependencies.includes(member.name) ||
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((dependency) => !names.has(dependency))
    )
      return { ok: false, problem: { kind: 'malformed' } };
  }

  return {
    ok: true,
    manifest: {
      // The CURRENT version, never the parsed one: four commands re-serialize a
      // read manifest, and writing `version: 1` back with a `broker` in it would
      // send the next read down the version-1 path, where an absent `transport`
      // maps to `memory` — the silent fallback the bump exists to prevent.
      version: WORKSPACE_VERSION,
      basePort,
      ...(devtoolBasePort === undefined ? {} : { devtoolBasePort }),
      ...(devBasePort === undefined ? {} : { devBasePort }),
      broker: bus.broker,
      ...(redisClient === undefined ? {} : { redisClient }),
      runtime,
      ...(bus.brokerUrl === undefined ? {} : { brokerUrl: bus.brokerUrl }),
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
  const { devtoolBasePort, devBasePort, ...rest } = manifest;
  return `${JSON.stringify(
    {
      ...rest,
      ...(devtoolBasePort === undefined ? {} : { devtoolBasePort }),
      ...(devBasePort === undefined ? {} : { devBasePort }),
    },
    null,
    2,
  )}\n`;
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
 * Connector ports live in their own range ({@linkcode allocateDevtoolPort}), so
 * the maximum is taken over APPLICATION ports only — walking `devtoolPort` too
 * would drag every later application past the first connector and into the
 * connector range (`basePort + 1000` onward), interleaving the two kinds again.
 * A candidate equal to a recorded connector port, which a hand-edited or
 * overlapping range can produce, is skipped instead, so neither allocator ever
 * hands out the other's number.
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
  let candidate = highest + 1;
  const used = recordedPorts(manifest);
  while (candidate <= MAX_PORT && used.has(candidate)) candidate++;
  return isUsablePort(candidate) ? candidate : undefined;
}

/** Returns the recorded connector range or its bounded default. */
export function devtoolRangeStart(manifest: WorkspaceManifest): number {
  return manifest.devtoolBasePort ?? Math.min(MAX_PORT, manifest.basePort + 1000);
}

/** Chooses the next connector port, skipping every configured application port. */
export function allocateDevtoolPort(manifest: WorkspaceManifest): number | undefined {
  let highest = devtoolRangeStart(manifest) - 1;
  for (const member of manifest.members) {
    if (member.devtoolPort !== undefined) highest = Math.max(highest, member.devtoolPort);
  }
  let candidate = highest + 1;
  const applicationPorts = recordedPorts(manifest);
  while (candidate <= MAX_PORT && applicationPorts.has(candidate)) candidate++;
  return isUsablePort(candidate) ? candidate : undefined;
}

/**
 * Every recorded app, connector, inspector and Vite port, including stopped members.
 *
 * @param manifest - The workspace's recorded assignments
 * @returns All occupied ports, without duplicates
 * @since 0.12.0
 */
export function recordedPorts(manifest: WorkspaceManifest): ReadonlySet<number> {
  return new Set(
    manifest.members.flatMap((member) =>
      [member.port, member.devtoolPort, member.inspectPort, member.vitePort].filter(
        (port): port is number => port !== undefined,
      ),
    ),
  );
}

/**
 * Chooses a development port from its range, avoiding every recorded port.
 *
 * @param manifest - The workspace's port ranges and recorded assignments
 * @returns The next inspector or Vite port, or undefined when the range is exhausted
 * @since 0.12.0
 */
export function allocateDevPort(manifest: WorkspaceManifest): number | undefined {
  let candidate = manifest.devBasePort ?? manifest.basePort + 2000;
  for (const member of manifest.members)
    for (const port of [member.inspectPort, member.vitePort])
      if (port !== undefined) candidate = Math.max(candidate, port + 1);
  const used = recordedPorts(manifest);
  while (candidate <= MAX_PORT && used.has(candidate)) candidate++;
  return isUsablePort(candidate) ? candidate : undefined;
}
