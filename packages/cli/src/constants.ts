/**
 * Constants for the setu CLI tool.
 *
 * @module
 */

import denoJson from '../deno.json' with { type: 'json' };

/**
 * The CLI's version, read from the package's own `deno.json`.
 *
 * A static JSON module import rather than a duplicated literal, so the release
 * script's version bump is the single source of truth and `--version` can
 * never drift from the published package version.
 */
export const VERSION: string = denoJson.version;

/**
 * The name of the CLI executable.
 *
 * Deno chooses the installed binary name at install time
 * (`deno install -g -n setu …`), so help text interpolates this constant
 * rather than deriving a name from `argv` — Deno exposes no reliable `argv[0]`.
 */
export const PROGRAM_NAME = 'setu';

/** Exit code for a successful run. */
export const EXIT_OK = 0;

/** Exit code for a runtime error (schematic failed, write failed, gate refused). */
export const EXIT_ERROR = 1;

/** Exit code for a usage error (unknown command, missing argument). */
export const EXIT_USAGE = 2;

/**
 * The runtime targets `setu new --runtime` accepts.
 *
 * `cloudflare-workers` emits the `export default { fetch }` entry plus a
 * `wrangler.toml` and no `listen`; the other three emit the Hono serve entry.
 */
export const TARGET_RUNTIMES = ['deno', 'node', 'bun', 'cloudflare-workers'] as const;

/** A runtime target accepted by `setu new --runtime`. */
export type TargetRuntime = (typeof TARGET_RUNTIMES)[number];

/**
 * The project templates `setu new --template` accepts.
 *
 * A template selects the plugin set written into the generated
 * `setu.config.ts`. Omitting the flag yields the minimal set (the runtime
 * plugin alone), which is still emitted through the same config seam.
 */
export const TEMPLATES = ['rest', 'microservice', 'class-based', 'full-stack'] as const;

/** A project template accepted by `setu new --template`. */
export type TemplateName = (typeof TEMPLATES)[number];

/**
 * Flags that consume the following token as their value (`--dir /tmp`).
 *
 * Every other flag is boolean. {@linkcode parseArgs} needs this because
 * `--dir /tmp` and `--dry-run generate` are indistinguishable without knowing
 * which flags take a value.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'dir',
  'runtime',
  'template',
  'config',
  'port',
  'transport',
  'transport-url',
  'env-file',
  'depends-on',
  'scope',
  'name',
]);

/**
 * The `setu generate` verb that adds a member to a workspace.
 *
 * Not a schematic name: it is dispatched before the schematic registry, exactly
 * as {@linkcode CUSTOM_SCHEMATIC} is, because adding a member reads the
 * workspace and a schematic is a pure function that performs no I/O.
 *
 * Spelled `app` rather than `service` because `service` is already a schematic
 * (`setu generate service` emits a class), and one word cannot mean two things
 * in the same command.
 */
export const APP_VERB = 'app';

/**
 * The `generate` verb that adds a shared library to a workspace.
 *
 * Spelled to match its NestJS analogue (`nest g library`). Not a schematic, for
 * the same reason {@linkcode APP_VERB} is not: it reads the workspace manifest and
 * may edit the root's member glob, while a schematic performs no I/O at all.
 */
export const LIBRARY_VERB = 'library';

/**
 * Narrows an arbitrary string to a {@linkcode TargetRuntime}.
 *
 * @param value - The raw `--runtime` flag value
 * @returns True when the value names a supported runtime target
 */
export function isTargetRuntime(value: string): value is TargetRuntime {
  return (TARGET_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The project-root module a scaffolded project exports its application factory
 * from, and that `setu` imports to discover plugin-contributed commands.
 */
export const CONFIG_MODULE = 'setu.config.ts';

/** The factory export {@linkcode CONFIG_MODULE} must provide. */
export const CONFIG_EXPORT = 'createApp';
