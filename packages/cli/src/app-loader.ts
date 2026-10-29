/**
 * Loading the target project's application factory.
 *
 * This is the one place the CLI imports user code. It resolves
 * `setu.config.ts` (or `--config <path>`), imports it for real through `tsx`
 * (`utils/ts-loader.ts`), and validates that it exports the factory the contract requires
 * — each failure naming the resolved path and what was expected.
 *
 * @module
 */

import type { IApplication } from '@setu-ts/common';
import { CONFIG_EXPORT, CONFIG_MODULE } from './constants.ts';
import { joinPath, toFileUrl } from './utils/file-writer.ts';
import { escapeName } from './utils/names.ts';
import { memberPath } from './utils/member-path.ts';
import { MEMBERS_DIR, readWorkspaceManifest, WORKSPACE_MANIFEST } from './workspace/manifest.ts';
import { importModule, type ModuleLoader } from './schematics/custom.ts';
import type { IFileSystem } from '@setu-ts/common';

/**
 * A stand-in for one Cloudflare binding, for command discovery only.
 *
 * `setu commands` calls `createApp()` to find plugin-contributed verbs, and a
 * Workers project's factory takes the platform `env`. The scaffolded default of
 * `{}` survived only while nothing READ a binding — but every documented
 * binding-backed composition (`new D1Adapter(env.DB)`,
 * `new KvSessionStore(env.SESSIONS)`, `new DurableObjectLock(env.LOCKS)`) is
 * constructed eagerly in the plugin list, because those options are read before
 * any application exists. So the moment a project followed the D1 or session
 * docs, `setu commands` and every plugin verb stopped working — with an error
 * that was correct and useless: the binding was absent because the CLI passed no
 * env, not because `wrangler.toml` was wrong (X9-3).
 *
 * Every binding guard in `cloudflare-plugin` is a `hasMethods` check
 * (`prepare`/`batch`, `get`/`put`/`delete`/`list`, `idFromName`/`get`, …), so
 * one proxy answering every property with a function satisfies all of them.
 *
 * Calling one THROWS rather than returning a fake value: discovery must not
 * silently perform I/O against a stub, and no discovery path invokes a binding.
 *
 * @returns A structurally-valid inert binding
 */
function inertBinding(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === Symbol.toPrimitive || property === 'toString') {
          return () => '[setu discovery stub]';
        }
        return () => {
          throw new Error(
            'A Cloudflare binding was CALLED during command discovery. `setu` builds the ' +
              'application to list plugin commands and passes inert bindings; construct ' +
              'clients in the plugin list, but do not read through them there.',
          );
        };
      },
    },
  );
}

/**
 * The `env` a discovery-time `createApp()` receives.
 *
 * Answers every name with {@linkcode inertBinding}. Enumeration stays empty, so
 * `splitWorkerEnv` reports no string variables and `runtime.env` is empty —
 * correct for discovery, which reads no configuration.
 *
 * @returns A proxy env whose every binding is structurally valid and inert
 */
function discoveryEnv(): Readonly<Record<string, unknown>> {
  return new Proxy(
    {},
    {
      get: (_target, property) => (typeof property === 'string' ? inertBinding() : undefined),
    },
  ) as Readonly<Record<string, unknown>>;
}

/**
 * Loads the project's config module by URL.
 *
 * Shares {@linkcode ModuleLoader}'s shape and default implementation — both
 * import an ES module by absolute URL — so there is one lazy-import mechanism
 * in this package, not two.
 */
export type AppLoader = ModuleLoader;

/**
 * Resolves the path of the module the application factory is loaded from.
 *
 * @param dir - The project root (absolute; see `resolveDir`)
 * @param config - The `--config` override, when supplied
 * @returns The absolute path to the config module
 */
export function configModulePath(dir: string, config?: string): string {
  if (config === undefined || config === '') return joinPath(dir, CONFIG_MODULE);
  return config.startsWith('/') ? joinPath(config) : joinPath(dir, config);
}

/**
 * Reports whether the project has a config module at all.
 *
 * Checked separately from loading so "this project has no `setu.config.ts`"
 * can be a distinct, actionable message rather than an import failure.
 *
 * @param fs - The filesystem to probe
 * @param dir - The project root (absolute)
 * @param config - The `--config` override, when supplied
 * @returns True when the module exists
 */
export async function configModuleExists(
  fs: IFileSystem,
  dir: string,
  config?: string,
): Promise<boolean> {
  try {
    await fs.stat(configModulePath(dir, config));
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrows an unknown value to something usable as an application.
 *
 * Validated where the seam is injected rather than at first use, so a config
 * module that returns the wrong thing fails immediately with a clear message
 * instead of throwing somewhere inside dispatch.
 *
 * @param value - The value `createApp()` resolved to
 * @returns True when it carries the members this command needs
 */
function isApplication(value: unknown): value is IApplication {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<IApplication>;
  return (
    typeof candidate.start === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.services === 'object' &&
    candidate.services !== null
  );
}

/** The Deno manifests whose presence marks a project as a Deno target. */
const DENO_MANIFESTS = ['deno.json', 'deno.jsonc'] as const;

/** Whether a path exists on the CLI's filesystem. */
async function exists(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory above `path`, or `undefined` at a root.
 *
 * Splits on either separator, because a Windows path arrives with backslashes:
 * cutting at the last `/` alone would turn `C:\repo\apps\api` into the
 * PREFIX `C:\repo\apps\ap` — a sibling Node never resolves through.
 * `joinPath` never resolves `..`, so the parent is the text before the last
 * separator; a POSIX root, a drive root (`C:\`, `C:`) and a UNC share root
 * (`\\server\share`) have none.
 *
 * @param path - An absolute directory
 * @returns Its parent, or `undefined` when it is a root
 */
export function parentDir(path: string): string | undefined {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
  if (trimmed === '' || trimmed === '/' || /^[A-Za-z]:$/.test(trimmed)) return undefined;
  if (/^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return undefined;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return undefined;
  if (cut === 0) return '/';
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/**
 * The directories whose `node_modules` may install a Deno project's framework:
 * the project, and — when it is a member of a workspace — each ancestor up to
 * and including that workspace's root. Outside a workspace, the project alone.
 *
 * An ancestor counts as this project's workspace only when its
 * {@linkcode WORKSPACE_MANIFEST} is one this CLI can read AND lists a member at
 * exactly `<ancestor>/apps/<name>` = the project. The mere presence of the file
 * is not enough: a `setu.workspace.json` planted beside a planted
 * `node_modules/@setu-ts/kernel` in a shared parent would otherwise widen the
 * search to reach it.
 *
 * @param fs - The CLI's filesystem
 * @param dir - The project root (absolute)
 * @returns The directories, nearest first
 */
export async function installSearchDirs(fs: IFileSystem, dir: string): Promise<string[]> {
  // Compared with one separator: `joinPath` joins with `/` while a native Windows path keeps
  // `\`, so `C:\ws/apps/api` and `C:\ws\apps\api` must read as the same member.
  const project = memberPath(dir);
  const chain: string[] = [];
  for (let current: string | undefined = dir; current !== undefined; current = parentDir(current)) {
    chain.push(current);
    if (!(await exists(fs, joinPath(current, WORKSPACE_MANIFEST)))) continue;
    const read = await readWorkspaceManifest(fs, current);
    const listed =
      read.ok &&
      read.manifest.members.some(
        (member) => memberPath(joinPath(current!, joinPath(MEMBERS_DIR, member.name))) === project,
      );
    return listed ? chain : [dir];
  }
  return [dir];
}

/**
 * The unknown `redisClient` the nearest workspace manifest above `dir` stores, if any.
 *
 * {@linkcode installSearchDirs} reads an unreadable manifest as "not a member", so a
 * member of a workspace whose `redisClient` is unknown would otherwise be handled
 * as a standalone project and quietly receive the ioredis default (M117 §3.8).
 *
 * @param fs - The file system
 * @param dir - The project directory
 * @returns The stored value, or `undefined` when no manifest above names an unknown one
 */
export async function unknownWorkspaceRedisClient(
  fs: IFileSystem,
  dir: string,
): Promise<string | undefined> {
  for (let current: string | undefined = dir; current !== undefined; current = parentDir(current)) {
    if (!(await exists(fs, joinPath(current, WORKSPACE_MANIFEST)))) continue;
    const read = await readWorkspaceManifest(fs, current);
    return !read.ok && read.problem.kind === 'unknown-redis-client'
      ? read.problem.redisClient
      : undefined;
  }
  return undefined;
}

/**
 * Why a Deno project's config cannot be imported by this Node CLI, if it can't.
 *
 * The CLI imports `setu.config.ts` through Node resolution, which cannot read a
 * Deno import map. A generated Deno project sets `nodeModulesDir: "auto"`, so
 * after `deno install` its framework packages are linked into a `node_modules`
 * the import resolves through. Without that link the import would fail inside
 * module resolution with a message naming a package rather than the cause, so
 * it is refused here, by name, first. A workspace member is satisfied by its
 * workspace root's `node_modules`, where a Deno workspace links its packages.
 *
 * The search is bounded: the project itself, then — only when it is a listed
 * member — its ancestors up to its workspace root, and no further (see
 * {@linkcode installSearchDirs}). An unbounded walk would accept a `node_modules/@setu-ts/kernel`
 * planted in a shared parent such as `/tmp` as "installed", and Node would then
 * import and run it (M111d audit round 2, N1). With the bound, a kernel is found
 * only where the project's own resolution reaches it first.
 *
 * @param fs - The CLI's filesystem
 * @param dir - The project root (absolute)
 * @returns The refusal, or `undefined` when the project is not a Deno project
 *   or its packages are installed
 */
export async function denoInstallRefusal(
  fs: IFileSystem,
  dir: string,
): Promise<string | undefined> {
  let manifest: string | undefined;
  for (const name of DENO_MANIFESTS) {
    if (await exists(fs, joinPath(dir, name))) manifest = joinPath(dir, name);
  }
  if (manifest === undefined) return undefined;

  for (const current of await installSearchDirs(fs, dir)) {
    if (await exists(fs, joinPath(current, 'node_modules', '@setu-ts', 'kernel'))) {
      return undefined;
    }
  }

  const text = new TextDecoder().decode(await fs.readFile(manifest));
  if (text.includes('jsr:@setu-ts/')) {
    return (
      `${escapeName(manifest)} pins the framework from JSR, which this CLI cannot load. ` +
      `Move the project to the npm packages first — see docs/upgrading.md.`
    );
  }
  return (
    `This Deno project's packages are not installed where Node can import them. ` +
    `Run \`deno install\` in ${escapeName(dir)} (its manifest sets nodeModulesDir: "auto"), ` +
    `then run this command again.`
  );
}

/**
 * Imports the project's config module and calls its factory.
 *
 * The returned application is NOT started: the caller owns the no-socket boot
 * and the guaranteed teardown (see `commands/plugin-commands.ts`).
 *
 * @param dir - The project root (absolute)
 * @param config - The `--config` override, when supplied
 * @param load - The module loader; defaults to a real import through `tsx`
 * @returns The unstarted application
 * @throws {Error} If the module cannot be imported, exports no
 * {@linkcode CONFIG_EXPORT} function, or that function does not produce an
 * application
 */
export async function loadApp(
  dir: string,
  config?: string,
  load: AppLoader = importModule,
): Promise<IApplication> {
  const url = toFileUrl(configModulePath(dir, config));

  let module: Record<string, unknown>;
  try {
    module = await load(url, dir);
  } catch (cause) {
    throw new Error(
      `Cannot load ${escapeName(String(url))}: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
      { cause },
    );
  }

  const factory = module[CONFIG_EXPORT];
  if (typeof factory !== 'function') {
    throw new Error(
      `${escapeName(
        String(url),
      )} must export a '${CONFIG_EXPORT}' function returning the application; ` +
        `found ${typeof factory}.`,
    );
  }

  let app: unknown;
  try {
    // The env is passed on EVERY target, not only Workers: a factory that
    // declares no parameter ignores it, and the CLI cannot know the target's
    // runtime from here without reading a second manifest.
    app = await (factory as (env: Readonly<Record<string, unknown>>) => unknown)(discoveryEnv());
  } catch (cause) {
    const detail = escapeName(cause instanceof Error ? cause.message : String(cause));
    throw new Error(
      `${CONFIG_EXPORT}() in ${escapeName(String(url))} threw: ${detail}\n` +
        `  Plugin commands are unavailable in this project because building the ` +
        `application failed. \`setu\` constructs it to discover them, with inert ` +
        `platform bindings — anything a plugin READS at construction time will not ` +
        `be there.`,
      { cause },
    );
  }

  if (!isApplication(app)) {
    throw new Error(
      `${CONFIG_EXPORT}() in ${escapeName(String(url))} must return the application from ` +
        `createApplication(); got ${app === null ? 'null' : typeof app}.`,
    );
  }

  return app;
}
