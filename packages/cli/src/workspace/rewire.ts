/**
 * Changing a workspace's broker, or one member's RPC style, after scaffolding.
 *
 * One planner for every entry point (M138 §3.7): `setu workspace broker`,
 * `setu workspace rpc`, `setu add grpc` inside a member, and the module
 * regeneration `generate app`, `setu add messaging|queue` and `setu sync` run.
 * It sorts every file a change touches into one of four ownership classes and
 * never writes the developer's own source:
 *
 * 1. CLI-owned, rewritten: each member's `src/transport/index.ts`, the manifest,
 *    the Compose stack, the Kubernetes objects, and the README's marked section.
 * 2. Merged, never removed: the member manifest gains the packages the new
 *    choice loads (a full-stack member on a broker that backs a queue gains
 *    `@setu-ts/queue-plugin`); packages no longer needed are listed, not deleted.
 * 3. Create-only: the proto toolchain and the node-redis helper.
 * 4. User-owned: `setu.config.ts` and all other source. The planner checks the
 *    config CALLS the module, and refuses — writing nothing — when it does not,
 *    printing the lines to add. That refusal is also the migration path for a
 *    member made before the module existed. A config that does not yet pass
 *    its queue the generated job processors is told the lines in a note.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import {
  strictlyCalledOutsideImports,
  strictlyReferencedOutsideImports,
} from '../diagnostics/wiring.ts';
import { JOBS_SEAM, QUEUE_PROCESSORS_EXPORT } from '../seams/jobs.ts';
import { maskComments } from '../devtool/sources.ts';
import { CLIENT_RANGES } from '../templates/client-dependencies.ts';
import { frameworkSpecifier } from '../templates/framework-specifier.ts';
import { NODE_REDIS_MODULE_PATH, nodeRedisModuleFile } from '../templates/node-redis.ts';
import { type GeneratedFile, joinPath } from '../utils/file-writer.ts';
import { escapeName } from '../utils/names.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { walkProjectFiles } from './adopt.ts';
import { workspaceContainerFiles } from './compose.ts';
import { workspaceK8sFiles } from './k8s.ts';
import {
  MEMBERS_DIR,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  workspaceSecretVariables,
  type WorkspaceManifest,
  type WorkspaceMember,
} from './manifest.ts';
import { PROTO_OUT_DIR } from './proto-toolchain.ts';
import { renderTransportSection, TRANSPORT_README_MARKERS } from './root-files.ts';
import { GRPC_CALLER_CLIENTS, GRPC_PLUGIN, grpcTargets, rpcSpec, type RpcStyle } from './rpc.ts';
import { workspaceProfile } from './runtime-profile.ts';
import { type BrokerName, brokerSpec } from './transport.ts';
import {
  renderTransportModule,
  TRANSPORT_EXPORTS,
  TRANSPORT_MODULE,
  TRANSPORT_SPECIFIER,
  transportModuleShape,
  type TransportHostKind,
  type TransportModuleInput,
} from './transport-module.ts';

/** The member config the planner reads, never writes. */
const CONFIG_FILE = 'setu.config.ts';

/** A requested change to how a workspace's members talk. */
export type TransportChange =
  | {
      readonly kind: 'broker';
      readonly broker: BrokerName;
      readonly brokerUrl?: string;
      readonly redisClient?: 'node-redis';
    }
  | { readonly kind: 'rpc'; readonly member: string; readonly rpc: RpcStyle };

/** How the planner behaves. */
export interface TransportChangeOptions {
  /** Turn orphan refusals (§3.8) into warnings. Never bypasses a missing-call refusal. */
  readonly force?: boolean;
  /**
   * Plan even when the manifest already records the change, so a member's module,
   * packages and create-only files are brought back to what its choice needs.
   * `setu add grpc` on a member already on gRPC uses it: adding a package is a
   * request for that package, whatever the manifest says.
   */
  readonly reconcile?: boolean;
}

/** What planning a change produced. Paths are relative to the workspace root. */
export type TransportChangePlan =
  | {
      readonly ok: true;
      /** The manifest as it will be after the change. */
      readonly manifest: WorkspaceManifest;
      /** Nothing would change: same broker, endpoint, client and styles. */
      readonly unchanged: boolean;
      readonly files: readonly GeneratedFile[];
      /** What the developer may still want to do by hand, in order. */
      readonly notes: readonly string[];
      /** Orphaned references the change goes ahead past, under `--force`. */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly messages: readonly string[] };

/** What the planner knows about one member before it renders anything. */
interface MemberContext {
  readonly member: WorkspaceMember;
  /** The member directory, relative to the workspace root. */
  readonly root: string;
  readonly host: TransportHostKind;
  readonly installed: ReadonlySet<string>;
}

/**
 * Reads how a member's config composes its plugins, and which it installs.
 *
 * The host kind comes from the manifest, not the config: a member declaring
 * `full-stack-starter` is composed by the starter's factory, whatever its
 * config's shape has become.
 *
 * @param fs - The filesystem
 * @param dir - The workspace root (absolute)
 * @param member - The manifest's member
 * @returns Its context
 */
async function memberContext(
  fs: IFileSystem,
  dir: string,
  member: WorkspaceMember,
): Promise<MemberContext> {
  const root = joinPath(MEMBERS_DIR, member.name);
  const installed = await detectPlugins(fs, joinPath(dir, root));
  return {
    member,
    root,
    host: installed.has('full-stack-starter') ? 'app-factory' : 'plugin-list',
    installed,
  };
}

/**
 * The module inputs for a member under a manifest.
 *
 * @param manifest - The workspace manifest
 * @param context - The member's context
 * @returns The inputs
 */
function moduleInput(manifest: WorkspaceManifest, context: MemberContext): TransportModuleInput {
  return {
    broker: brokerSpec(manifest.broker, manifest.redisClient),
    rpc: rpcSpec(context.member.rpc),
    grpcTargets: grpcTargets(manifest.members, context.member.name),
    host: context.host,
    profile: workspaceProfile(manifest.runtime),
    messaging: context.installed.has('messaging-plugin'),
    queue: context.installed.has('queue-plugin'),
    ...(manifest.brokerUrl === undefined ? {} : { brokerUrl: manifest.brokerUrl }),
  };
}

/**
 * Renders one member's transport module from the manifest and what it installs.
 *
 * Read by `generate app`, `setu add messaging|queue` and `setu sync`, which
 * regenerate the module without changing the transport.
 *
 * @param fs - The filesystem
 * @param dir - The workspace root (absolute)
 * @param manifest - The workspace manifest
 * @param member - The member to render for
 * @param installed - The member's packages, when a caller is about to change them
 * (`setu add` renders the module for the set it is installing, not the one on disk)
 * @returns The module, relative to the workspace root and marked CLI-owned
 */
export async function memberTransportModule(
  fs: IFileSystem,
  dir: string,
  manifest: WorkspaceManifest,
  member: WorkspaceMember,
  installed?: ReadonlySet<string>,
): Promise<GeneratedFile> {
  const read = await memberContext(fs, dir, member);
  const context =
    installed === undefined
      ? read
      : {
          ...read,
          installed,
          host: installed.has('full-stack-starter') ? ('app-factory' as const) : read.host,
        };
  return {
    path: joinPath(context.root, TRANSPORT_MODULE),
    contents: renderTransportModule(moduleInput(manifest, context)),
    managed: true,
  };
}

/**
 * Reads a file, or `undefined` when it is absent or unreadable.
 *
 * @param fs - The filesystem
 * @param path - Absolute path
 * @returns Its text
 */
async function readText(fs: IFileSystem, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch {
    return undefined;
  }
}

/**
 * The lines a config needs so it reads the module, for each call it lacks.
 *
 * @param config - The member's `setu.config.ts`, or `undefined` when unreadable
 * @param input - The module's inputs
 * @returns The lines to add; empty when the config already calls every function
 */
function missingCalls(config: string | undefined, input: TransportModuleInput): readonly string[] {
  const shape = transportModuleShape(input);
  const factory = input.host === 'app-factory';
  const wanted: readonly (readonly [string, string])[] = [
    ...(shape.messaging
      ? [
          [
            TRANSPORT_EXPORTS.messaging,
            factory
              ? 'messaging: messagingOptions(config),'
              : 'MessagingPlugin(messagingOptions()),',
          ] as const,
        ]
      : []),
    ...(shape.queue
      ? [
          [
            TRANSPORT_EXPORTS.queue,
            factory
              ? 'queue: { ...queueOptions(config) },'
              : 'QueuePlugin({ processors: [...QUEUE_PROCESSORS], ...queueOptions() }),',
          ] as const,
        ]
      : []),
    [
      TRANSPORT_EXPORTS.plugins,
      factory
        ? 'for (const plugin of transportPlugins()) app.register(plugin);'
        : '...transportPlugins(),  // in the plugins array',
    ],
    ...(shape.csrf
      ? [[TRANSPORT_EXPORTS.csrf, 'csrf: { exclude: [...csrfExclusions()] },'] as const]
      : []),
  ];
  // An unreadable or unclassifiable config counts as missing every call: the
  // planner cannot show the module is read, and writing it anyway could leave a
  // member on the old broker with nothing saying so.
  const missing = wanted.filter(
    ([symbol]) => config === undefined || strictlyCalledOutsideImports(config, symbol) !== true,
  );
  if (missing.length === 0) return [];
  const imported = wanted.map(([symbol]) => symbol).join(', ');
  return [
    `import { ${imported} } from '${TRANSPORT_SPECIFIER}';`,
    ...missing.map(([, line]) => line),
  ];
}

/**
 * Finds the references a switch would leave dangling in one member.
 *
 * Every path is escaped where it enters a message: file names come from the
 * developer's tree, and the output sinks leave a line feed alone, so an unescaped
 * name could forge a whole line of output.
 *
 * Scanned with comments masked; a file the masker cannot classify (a template
 * literal, a regex, a division) is scanned as raw text, so it can refuse but is
 * never skipped. The module itself and the proto output are excluded.
 *
 * @param fs - The filesystem
 * @param dir - The workspace root (absolute)
 * @param context - The member's context
 * @param patterns - Each pattern and what stops working if it is left behind
 * @returns `file:line — reason` for every hit
 */
async function orphans(
  fs: IFileSystem,
  dir: string,
  context: MemberContext,
  patterns: readonly (readonly [RegExp, string])[],
): Promise<readonly string[]> {
  if (patterns.length === 0) return [];
  const memberDir = joinPath(dir, context.root);
  const hits: string[] = [];
  // Only an ABSENT `src/` is an empty scan. Any other failure — a link the walk
  // refuses, an unreadable directory — leaves the scan incomplete, and an
  // incomplete scan is reported like a hit: it is refused unless `--force`.
  const unscanned = (path: string): string =>
    `${escapeName(path)} — could not be scanned, so what it uses is unknown`;
  let sources: readonly string[] = [];
  try {
    sources = await walkProjectFiles(fs, memberDir, 'src');
  } catch (cause) {
    if (!isMissingPath(cause)) hits.push(unscanned(joinPath(context.root, 'src')));
  }
  const files = [CONFIG_FILE, ...sources].filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?)$/.test(path) &&
      path !== TRANSPORT_MODULE &&
      !path.startsWith(`${PROTO_OUT_DIR}/`),
  );
  for (const path of files) {
    const text = await readText(fs, joinPath(memberDir, path));
    if (text === undefined) {
      // The config is checked (and refused when unreadable) before this scan runs.
      if (path !== CONFIG_FILE) hits.push(unscanned(joinPath(context.root, path)));
      continue;
    }
    const scanned = maskComments(text) ?? text;
    const lines = scanned.split('\n');
    for (const [pattern, reason] of patterns) {
      lines.forEach((line, index) => {
        if (pattern.test(line))
          hits.push(`${escapeName(joinPath(context.root, path))}:${index + 1} — ${reason}`);
      });
    }
  }
  return hits;
}

/**
 * Merges the packages a member now needs into its own manifest.
 *
 * Additive only. A package already declared in any section is left exactly as it
 * is, at its own spec: a second entry beside a `devDependencies` pin makes npm
 * install the dev one. A manifest that is not plain JSON (a JSONC `deno.json`,
 * comments, trailing commas) refuses the whole change by name, because
 * rewriting it would discard what makes it JSONC.
 *
 * @param text - The member manifest's contents
 * @param path - Its path, for the refusal
 * @param additions - Per section, the entries to add
 * @returns The new contents (undefined when nothing changes), or the refusal
 */
function mergeManifest(
  text: string,
  path: string,
  additions: Readonly<Record<string, Readonly<Record<string, string>>>>,
): { readonly contents?: string } | { readonly refusal: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    const lines = Object.entries(additions).flatMap(([section, entries]) =>
      Object.entries(entries).map(([name, value]) => `  "${section}": { "${name}": "${value}" }`),
    );
    return {
      refusal: `${escapeName(path)} is not plain JSON, so it cannot be rewritten without losing its comments; add these yourself, then run this again:\n${lines.join('\n')}`,
    };
  }
  const declared = new Set<string>();
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'imports']) {
    const entries = parsed[section];
    if (entries !== null && typeof entries === 'object') {
      for (const name of Object.keys(entries)) declared.add(`${section}:${name}`);
    }
  }
  const dependencyLike = new Set(['dependencies', 'devDependencies', 'peerDependencies']);
  let changed = false;
  const next: Record<string, unknown> = { ...parsed };
  for (const [section, entries] of Object.entries(additions)) {
    const current = parsed[section];
    const map: Record<string, unknown> =
      current !== null && typeof current === 'object' ? { ...(current as object) } : {};
    for (const [name, value] of Object.entries(entries)) {
      const elsewhere =
        dependencyLike.has(section) &&
        [...dependencyLike].some((other) => declared.has(`${other}:${name}`));
      if (name in map || elsewhere) continue;
      map[name] = value;
      changed = true;
    }
    next[section] = map;
  }
  return changed ? { contents: `${JSON.stringify(next, null, 2)}\n` } : {};
}

/** The framework package a full-stack member's Redis-backed queue needs. */
const QUEUE_PACKAGE = 'queue-plugin';

/**
 * Whether a member under these inputs needs the queue package, as generating it
 * on that broker gives it (`member-host.ts`, M139d V12-33): a full-stack member on
 * a broker that backs a queue (Redis, RabbitMQ). Switching to one later merges the
 * package so `setu g job` works (V12-60). The jobs seam is NOT pre-created: the
 * config is the developer's, and a barrel it does not read yet would fail
 * `setu check` with setu.E006 before any job exists; `setu g job` writes it.
 *
 * @param input - The module's inputs
 * @returns `true` when the member needs them
 */
function needsQueueSeam(input: TransportModuleInput): boolean {
  return (
    input.host === 'app-factory' &&
    input.broker.connection !== undefined &&
    input.broker.queueArgs !== undefined
  );
}

/**
 * The packages and manifest entries a member needs under a manifest.
 *
 * @param input - The module's inputs
 * @returns Per manifest section, the entries a scaffold would write
 */
function neededEntries(
  input: TransportModuleInput,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const shape = transportModuleShape(input);
  const { broker, rpc } = input;
  const clients = [
    ...(shape.messaging && broker.messagingArgs !== undefined
      ? (broker.messagingClients ?? [])
      : []),
    ...(shape.queue && broker.queueArgs !== undefined ? (broker.queueClients ?? []) : []),
    ...(rpc.clients ?? []),
    ...((input.grpcTargets ?? []).length === 0 ? [] : GRPC_CALLER_CLIENTS),
  ].filter((name, index, all) => all.indexOf(name) === index);
  const framework = [
    ...(needsQueueSeam(input) ? [QUEUE_PACKAGE] : []),
    ...(rpc.plugin === undefined && (input.grpcTargets ?? []).length === 0
      ? []
      : [GRPC_PLUGIN.pkg]),
  ];
  if (input.profile.manifestKind === 'deno') {
    return {
      imports: {
        ...Object.fromEntries(clients.map((name) => [name, `npm:${name}@${CLIENT_RANGES[name]}`])),
        ...Object.fromEntries(
          framework.map((pkg) => [`@setu-ts/${pkg}`, frameworkSpecifier(pkg, 'deno')]),
        ),
        ...rpc.memberImports,
      },
      ...(rpc.memberTasks === undefined ? {} : { tasks: rpc.memberTasks }),
    };
  }
  return {
    dependencies: {
      ...Object.fromEntries(clients.map((name) => [name, CLIENT_RANGES[name]!])),
      ...Object.fromEntries(
        framework.map((pkg) => [`@setu-ts/${pkg}`, frameworkSpecifier(pkg, 'npm')]),
      ),
    },
    ...(rpc.memberScripts === undefined ? {} : { scripts: rpc.memberScripts }),
    ...(rpc.memberDevDependencies === undefined
      ? {}
      : { devDependencies: rpc.memberDevDependencies }),
  };
}

/**
 * The manifest a change produces.
 *
 * @param manifest - The workspace manifest now
 * @param change - The requested change
 * @returns The manifest after it
 */
function applyChange(manifest: WorkspaceManifest, change: TransportChange): WorkspaceManifest {
  if (change.kind === 'rpc') {
    return {
      ...manifest,
      members: manifest.members.map((member) => {
        if (member.name !== change.member) return member;
        const { rpc: _previous, ...rest } = member;
        return change.rpc === 'grpc' ? { ...rest, rpc: 'grpc' } : rest;
      }),
    };
  }
  const { brokerUrl: _url, redisClient: _client, ...rest } = manifest;
  return {
    ...rest,
    broker: change.broker,
    ...(change.brokerUrl === undefined ? {} : { brokerUrl: change.brokerUrl }),
    ...(change.redisClient === undefined || change.broker !== 'redis'
      ? {}
      : { redisClient: change.redisClient }),
  };
}

/**
 * Whether two manifests record the same thing, whatever order their keys are in.
 *
 * A change rebuilds the manifest object, so its keys can come out in another order
 * than the file's; comparing the rendered text would call a no-op a change.
 *
 * @param a - One manifest
 * @param b - The other
 * @returns `true` when every field, and every member's, is equal
 */
function sameManifest(a: WorkspaceManifest, b: WorkspaceManifest): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Plans a change to the workspace broker or one member's RPC style.
 *
 * @param fs - The filesystem
 * @param dir - The workspace root (absolute)
 * @param manifest - The workspace manifest as read
 * @param change - The validated change
 * @param options - `force` turns orphan refusals into warnings
 * @returns Every file to write, or why nothing may be written
 */
export async function planTransportChange(
  fs: IFileSystem,
  dir: string,
  manifest: WorkspaceManifest,
  change: TransportChange,
  options: TransportChangeOptions = {},
): Promise<TransportChangePlan> {
  const next = applyChange(manifest, change);
  if (options.reconcile !== true && sameManifest(next, manifest)) {
    return { ok: true, manifest: next, unchanged: true, files: [], notes: [], warnings: [] };
  }
  const profile = workspaceProfile(next.runtime);
  const before = brokerSpec(manifest.broker, manifest.redisClient);
  const after = brokerSpec(next.broker, next.redisClient);
  // An RPC change reaches the member and every member that calls it: a caller's
  // module registers the plugin's client for its gRPC targets (M139b §3.12).
  const affected =
    change.kind === 'rpc'
      ? next.members.filter(
          (member) =>
            member.name === change.member || (member.dependsOn ?? []).includes(change.member),
        )
      : next.members;

  const files: GeneratedFile[] = [];
  const notes: string[] = [];
  const refusals: string[] = [];
  const orphaned: string[] = [];

  for (const member of affected) {
    const context = await memberContext(fs, dir, member);
    const input = moduleInput(next, context);
    const previous = manifest.members.find((entry) => entry.name === member.name)!;
    const memberDir = joinPath(dir, context.root);

    const config = await readText(fs, joinPath(memberDir, CONFIG_FILE));
    const missing = missingCalls(config, input);
    if (missing.length > 0) {
      refusals.push(
        `${escapeName(joinPath(context.root, CONFIG_FILE))} does not read its CLI-owned transport module, so the change would not reach it. Add these lines (the module is ${escapeName(joinPath(context.root, TRANSPORT_MODULE))}; \`setu sync\` writes it), then run this again:`,
        ...missing.map((line) => `  ${line}`),
      );
      continue;
    }

    const patterns: (readonly [RegExp, string])[] = [];
    const oldVariable = before.connection?.variable;
    if (
      change.kind === 'broker' &&
      oldVariable !== undefined &&
      oldVariable !== after.connection?.variable
    ) {
      patterns.push([
        new RegExp(`\\b${oldVariable}\\b`),
        `reads ${oldVariable}, whose ${before.name} service the Compose stack will no longer start`,
      ]);
    }
    if (
      change.kind === 'rpc' &&
      member.name === change.member &&
      previous.rpc === 'grpc' &&
      change.rpc === 'http'
    ) {
      patterns.push(
        [
          /\bCAPABILITIES\.GRPC\b/,
          'resolves the gRPC service, which this member will no longer register',
        ],
        [
          /['"]@setu-ts\/grpc-plugin['"]/,
          'imports the gRPC plugin, which this member will no longer register',
        ],
        [
          /['"](?:\.{1,2}\/)*(?:src\/)?gen\//,
          'imports generated proto descriptors no plugin will serve',
        ],
      );
    }
    // A caller whose gRPC targets this change empties loses the plugin's client
    // with them (M139b §3.12), so code still calling it is orphaned the same way.
    // A caller that serves gRPC itself keeps the plugin: only its client calls lose
    // their target, and its own services still import the plugin and resolve it.
    if (
      change.kind === 'rpc' &&
      member.name !== change.member &&
      grpcTargets(manifest.members, member.name).length > 0 &&
      grpcTargets(next.members, member.name).length === 0
    ) {
      if (member.rpc === 'grpc') {
        patterns.push([
          /\bgrpcClient(?:Provider)?\b/,
          `calls ${change.member} over gRPC, which it will no longer serve`,
        ]);
      } else {
        patterns.push(
          [
            /['"]@setu-ts\/grpc-plugin['"]/,
            `imports the gRPC plugin, whose client this member will no longer register once ${change.member} stops serving gRPC`,
          ],
          [
            /\bCAPABILITIES\.GRPC\b/,
            `resolves the gRPC service, which this member will no longer register`,
          ],
        );
      }
    }
    orphaned.push(...(await orphans(fs, dir, context, patterns)));

    files.push({
      path: joinPath(context.root, TRANSPORT_MODULE),
      contents: renderTransportModule(input),
      managed: true,
    });

    // A Deno member's manifest is `deno.json`, else `deno.jsonc` — the order Deno and
    // `detectPlugins` read them in. A JSONC file that is not plain JSON is refused by
    // `mergeManifest`, which prints the lines to add by hand.
    const candidates =
      profile.manifestKind === 'deno' ? ['deno.json', 'deno.jsonc'] : ['package.json'];
    let manifestPath = joinPath(context.root, candidates[0] ?? 'package.json');
    let text: string | undefined;
    for (const candidate of candidates) {
      const path = joinPath(context.root, candidate);
      text = await readText(fs, joinPath(dir, path));
      if (text !== undefined) {
        manifestPath = path;
        break;
      }
    }
    if (text === undefined) {
      refusals.push(
        `${escapeName(manifestPath)} cannot be read, so the packages this change needs cannot be declared.`,
      );
    } else {
      const merged = mergeManifest(text, manifestPath, neededEntries(input));
      if ('refusal' in merged) refusals.push(merged.refusal);
      else if (merged.contents !== undefined)
        files.push({ path: manifestPath, contents: merged.contents, managed: true });
    }

    const shape = transportModuleShape(input);
    const created = [
      ...(input.rpc.memberFiles?.(member.name, profile.manifestKind === 'deno') ?? []),
      ...(after.redisClient === 'node-redis' && (shape.messaging || shape.queue)
        ? [nodeRedisModuleFile()]
        : []),
    ];
    for (const file of created) {
      const path = joinPath(context.root, file.path);
      if ((await readText(fs, joinPath(dir, path))) === undefined) files.push({ ...file, path });
    }

    // What the module needed before and no longer does, for THIS member's shape:
    // a REST member never had the broker's client, so it is never listed. Worded
    // as the module's need, not the member's — another plugin (a cache from
    // `setu add cache`) may still load the package.
    const previousInput = moduleInput(manifest, { ...context, member: previous });
    const names = (entries: ReturnType<typeof neededEntries>): readonly string[] =>
      Object.entries(entries)
        .filter(([section]) => section === 'dependencies' || section === 'imports')
        .flatMap(([, map]) => Object.keys(map));
    const nowNeeded = new Set(names(neededEntries(input)));
    // The starter registers the queue on every broker, and a jobs seam imports
    // the package, so leaving a broker that backs a queue never orphans it.
    const left = names(neededEntries(previousInput)).filter(
      (name) => !nowNeeded.has(name) && name !== `@setu-ts/${QUEUE_PACKAGE}`,
    );
    if (left.length > 0) {
      notes.push(
        `${escapeName(context.root)}: its transport module no longer uses ${left.join(', ')}; left in its manifest, so remove what nothing else needs.`,
      );
    }
    // The config is the developer's: the planner never writes it, so a member that
    // does not yet hand its jobs to the queue is told the two lines that do, and
    // that `setu check` requires them once `setu g job` has written a job.
    if (
      needsQueueSeam(input) &&
      config !== undefined &&
      strictlyReferencedOutsideImports(config, QUEUE_PROCESSORS_EXPORT) !== true
    ) {
      notes.push(
        `${escapeName(joinPath(context.root, CONFIG_FILE))}: once \`setu g job\` writes a job, \`setu check\` reports setu.E006 until this file imports { ${QUEUE_PROCESSORS_EXPORT} } from './${JOBS_SEAM.barrel}' and starts its queue option with processors: [...${QUEUE_PROCESSORS_EXPORT}],`,
      );
    }
    if (previous.rpc === 'grpc' && member.rpc !== 'grpc') {
      notes.push(`${escapeName(context.root)}: the proto toolchain files were left in place.`);
    }
    if (before.redisClient === 'node-redis' && after.redisClient !== 'node-redis') {
      notes.push(
        `${escapeName(joinPath(context.root, NODE_REDIS_MODULE_PATH))} is no longer imported by the transport module; it was left in place.`,
      );
    }
  }

  if (refusals.length > 0) return { ok: false, messages: refusals };
  if (orphaned.length > 0 && options.force !== true) {
    return {
      ok: false,
      messages: [
        'Refusing the change: code still uses what it removes, or could not be checked. Fix these, or pass --force to go ahead anyway:',
        ...orphaned.map((hit) => `  ${hit}`),
      ],
    };
  }

  files.push({ path: WORKSPACE_MANIFEST, contents: renderWorkspaceManifest(next), managed: true });
  if (change.kind === 'broker') {
    files.push(
      ...workspaceContainerFiles(next, after, profile).map((file) => ({ ...file, managed: true })),
    );
    files.push(...workspaceK8sFiles(next, after).map((file) => ({ ...file, managed: true })));
    const readme = await readText(fs, joinPath(dir, 'README.md'));
    const section = renderTransportSection(
      after,
      profile,
      next.brokerUrl,
      workspaceSecretVariables(next.members),
    );
    const start = readme?.indexOf(TRANSPORT_README_MARKERS.start) ?? -1;
    const end = readme?.indexOf(TRANSPORT_README_MARKERS.end) ?? -1;
    if (readme !== undefined && start >= 0 && end > start) {
      files.push({
        path: 'README.md',
        contents:
          readme.slice(0, start) +
          section +
          readme.slice(end + TRANSPORT_README_MARKERS.end.length),
        managed: true,
      });
    } else {
      notes.push(
        `README.md has no ${TRANSPORT_README_MARKERS.start} section, so it was left as it is. Its transport section now reads:\n${section}`,
      );
    }
    if (before.compose?.files !== undefined) {
      const kept = before.compose.files.filter(
        (file) => !(after.compose?.files ?? []).some((other) => other.path === file.path),
      );
      for (const file of kept)
        notes.push(`${file.path} belonged to the ${before.name} broker; it was left in place.`);
    }
  }

  return {
    ok: true,
    manifest: next,
    unchanged: false,
    files,
    notes,
    warnings: orphaned,
  };
}
