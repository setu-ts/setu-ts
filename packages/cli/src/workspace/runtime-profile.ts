/**
 * What a workspace's runtime target changes about the workspace itself.
 *
 * A Setu workspace was a **Deno** workspace by construction, which contradicted
 * the framework's own headline claim: Node and Bun are supported runtimes, a
 * scaffolded standalone project already runs on both, and only the MONOREPO was
 * Deno-only — which is precisely where the NestJS equivalent (`nest g app`) lives.
 *
 * Declared as one record per runtime, the way {@linkcode TransportSpec} is, so a
 * runtime difference is stated once rather than switched on at each of a dozen
 * render sites. Everything here was measured against real toolchains rather than
 * inferred:
 *
 * - **Bun needs no root shape of its own.** `bun install` reads npm `workspaces`
 *   from `package.json`, so `deno` and `npm` are the only two manifest kinds. What
 *   Bun changes is the COMMANDS, which is why
 *   {@linkcode WorkspaceRuntimeProfile.runScript} exists beside `manifestKind`: a
 *   next step derived from the shape alone tells a Bun developer to run `npm
 *   start`. It also installs into each member's own `node_modules` rather than
 *   only a hoisted root, which both generated ignore files account for.
 * - **A workspace-root `.npmrc` maps the `@jsr` scope for members.** Verified by
 *   installing `@setu-ts/{kernel,common,runtime}` into a two-member npm workspace
 *   and serving a request from one of them.
 * - **A sibling library resolves by its package NAME under npm too**, through the
 *   symlinks npm creates in the root `node_modules` — the same property the Deno
 *   arm relies on, so libraries need no per-runtime design.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { TargetRuntime } from '../constants.ts';

/** The root manifest shape a workspace is defined by. */
export type WorkspaceManifestKind = 'deno' | 'npm';

/** How a workspace's runtime target renders. */
export interface WorkspaceRuntimeProfile {
  /** The `--runtime` value that selects it. */
  readonly runtime: TargetRuntime;
  /** One line for `--help` and the workspace README. */
  readonly description: string;
  /**
   * Which root manifest declares the members.
   *
   * Only two, because Bun reads npm's: `deno.json` with a `workspace` array of
   * globs, or `package.json` with a `workspaces` array.
   */
  readonly manifestKind: WorkspaceManifestKind;
  /** The root manifest's filename. */
  readonly rootManifestFile: string;
  /**
   * The key in it that lists the member globs.
   *
   * Deno's is singular and npm's is plural, which is exactly the kind of
   * difference that produces a command reading the right file for the wrong key
   * and reporting that the workspace is malformed.
   */
  readonly globKey: string;
  /**
   * Renders a member glob the way this toolchain matches it.
   *
   * Deno takes `./apps/*`; npm matches the pattern as written and conventionally
   * has no `./`. Both resolve the same directories, but a glob written in the
   * other's style is a glob that silently matches nothing.
   *
   * @param directory - The directory members live in
   * @returns The glob
   */
  readonly memberGlob: (directory: string) => string;
  /**
   * Renders an environment read with a fallback, as SOURCE for a generated file.
   *
   * The one thing a generated module cannot express portably: `Deno.env.get(x)`
   * is a syntax error's worth of wrong on Node, and `process.env` is undeclared on
   * Deno without types. Two renderers read this — a transport's connection value
   * and each sibling's host in the discovery map.
   *
   * @param variable - The environment variable to read
   * @param fallback - The value to use when it is unset
   * @returns The expression, as source
   */
  readonly envRead: (variable: string, fallback: string) => string;
  /** What a developer runs to install the workspace's dependencies. */
  readonly install: string;
  /** What invokes this workspace's dependency-aware development runner. */
  readonly runAll: string;
  /**
   * Renders the command that runs one named script in the current directory.
   *
   * Bun is why this exists rather than a branch on
   * {@linkcode WorkspaceRuntimeProfile.manifestKind}: it shares npm's manifest
   * shape and NOT its commands, so a next step derived from the shape tells a Bun
   * developer to run `npm start` in a workspace whose install line says
   * `bun install`.
   *
   * @param script - The script or task name, e.g. `start`
   * @returns The command to run it
   */
  readonly runScript: (script: string) => string;
  /** The lockfile this toolchain writes, for `.gitignore` and image copies. */
  readonly lockfile: string;
}

/**
 * Renders a Deno environment read.
 *
 * @param variable - The environment variable
 * @param fallback - The value when unset
 * @returns The expression, as source
 */
function denoEnvRead(variable: string, fallback: string): string {
  return `Deno.env.get('${variable}') ??\n          '${fallback}'`;
}

/**
 * Renders a Node/Bun environment read.
 *
 * `process.env.X` rather than `process.env['X']`: every variable this renders is
 * a generated SCREAMING_SNAKE name, so the dot form is always valid, and it is
 * what a reader of the generated file expects to see.
 *
 * @param variable - The environment variable
 * @param fallback - The value when unset
 * @returns The expression, as source
 */
function nodeEnvRead(variable: string, fallback: string): string {
  return `process.env.${variable} ??\n          '${fallback}'`;
}

const PROFILES: Readonly<Record<TargetRuntime, WorkspaceRuntimeProfile>> = {
  ['deno']: {
    runtime: 'deno',
    description: 'Deno workspace — members resolved by a glob in the root deno.json',
    manifestKind: 'deno',
    rootManifestFile: 'deno.json',
    globKey: 'workspace',
    memberGlob: (directory) => `./${directory}/*`,
    envRead: denoEnvRead,
    install: 'deno install',
    runAll: 'deno run --allow-read --allow-run --allow-net scripts/dev.ts',
    runScript: (script) => `deno task ${script}`,
    lockfile: 'deno.lock',
  },
  ['node']: {
    runtime: 'node',
    description: 'npm workspace — members resolved by the root package.json workspaces field',
    manifestKind: 'npm',
    rootManifestFile: 'package.json',
    globKey: 'workspaces',
    memberGlob: (directory) => `${directory}/*`,
    envRead: nodeEnvRead,
    install: 'npm install',
    // `--workspaces` rather than `--filter`: npm's own flag, and it runs the
    // script in every workspace that declares it.
    runAll: 'node scripts/dev.mjs',
    runScript: (script) => `npm run ${script}`,
    lockfile: 'package-lock.json',
  },
  ['bun']: {
    runtime: 'bun',
    description: 'Bun workspace — npm workspaces, installed and run by Bun',
    manifestKind: 'npm',
    rootManifestFile: 'package.json',
    globKey: 'workspaces',
    memberGlob: (directory) => `${directory}/*`,
    envRead: nodeEnvRead,
    install: 'bun install',
    runAll: 'bun scripts/dev.mjs',
    runScript: (script) => `bun run ${script}`,
    // Measured: `bun install` populates each MEMBER's `node_modules` as well as
    // the hoisted root — which is why the generated `.gitignore` and
    // `.dockerignore` both name the member locations, not only the root one.
    lockfile: 'bun.lock',
  },
  // Present so the record is total over `TargetRuntime` and the lookup needs no
  // "cannot happen" branch. It is refused before it can be selected: each Worker
  // is its own deploy unit with its own `wrangler.toml`, so a workspace of them is
  // a different topology rather than a runtime swap.
  ['cloudflare-workers']: {
    runtime: 'cloudflare-workers',
    description: 'Not a workspace target — each Worker is its own deploy unit',
    manifestKind: 'npm',
    rootManifestFile: 'package.json',
    globKey: 'workspaces',
    memberGlob: (directory) => `${directory}/*`,
    envRead: nodeEnvRead,
    install: 'npm install',
    runAll: 'node scripts/dev.mjs',
    runScript: (script) => `npm run ${script}`,
    lockfile: 'package-lock.json',
  },
};

/** The runtimes a workspace can target. */
export const WORKSPACE_RUNTIMES: readonly TargetRuntime[] = ['deno', 'node', 'bun'];

/**
 * Reports whether a runtime can host a workspace.
 *
 * @param runtime - The target
 * @returns True when a workspace can be created for it
 */
export function isWorkspaceRuntime(runtime: TargetRuntime): boolean {
  return WORKSPACE_RUNTIMES.includes(runtime);
}

/**
 * Reads which toolchain an existing project is built with.
 *
 * Detected rather than asked for, because `setu adopt` converts a project that
 * already made this choice: one carrying a `package.json` and no `deno.json` is a
 * Node or Bun project, and wrapping it in a Deno workspace root would produce a
 * workspace whose only member its toolchain cannot install.
 *
 * Node and Bun are told apart by the LOCKFILE rather than by the manifest, which
 * is identical for both. With neither lockfile present the answer is `node`: its
 * root shape is what Bun reads too, so the workspace still installs and runs under
 * either — only the emitted commands differ, and `npm` is the safer default for a
 * project that has never been installed.
 *
 * @param fs - The filesystem to probe
 * @param project - The project directory (absolute)
 * @returns The runtime it is built with
 */
export async function detectProjectRuntime(
  fs: IFileSystem,
  project: string,
): Promise<TargetRuntime> {
  const has = async (name: string): Promise<boolean> => {
    try {
      await fs.stat(`${project}/${name}`);
      return true;
    } catch {
      return false;
    }
  };

  if (await has('deno.json')) return 'deno';
  if (!(await has('package.json'))) return 'deno';
  return (await has('bun.lock')) || (await has('bun.lockb')) ? 'bun' : 'node';
}

/**
 * Resolves an already-validated runtime to its profile.
 *
 * Total by construction: the record covers the whole union, so a manifest whose
 * runtime the reader has accepted needs no fallback branch.
 *
 * @param runtime - The workspace's runtime
 * @returns Its profile
 */
export function workspaceProfile(runtime: TargetRuntime): WorkspaceRuntimeProfile {
  return PROFILES[runtime];
}
