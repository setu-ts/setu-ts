/**
 * Constants for the honoe CLI tool.
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
 * (`deno install -g -n honoe …`), so help text interpolates this constant
 * rather than deriving a name from `argv` — Deno exposes no reliable `argv[0]`.
 */
export const PROGRAM_NAME = 'honoe';

/** Exit code for a successful run. */
export const EXIT_OK = 0;

/** Exit code for a runtime error (schematic failed, write failed, gate refused). */
export const EXIT_ERROR = 1;

/** Exit code for a usage error (unknown command, missing argument). */
export const EXIT_USAGE = 2;

/**
 * The runtime targets `honoe new --runtime` accepts.
 *
 * `cloudflare-workers` emits the `export default { fetch }` entry plus a
 * `wrangler.toml` and no `listen`; the other three emit the Hono serve entry.
 */
export const TARGET_RUNTIMES = ['deno', 'node', 'bun', 'cloudflare-workers'] as const;

/** A runtime target accepted by `honoe new --runtime`. */
export type TargetRuntime = (typeof TARGET_RUNTIMES)[number];

/**
 * Flags that consume the following token as their value (`--dir /tmp`).
 *
 * Every other flag is boolean. {@linkcode parseArgs} needs this because
 * `--dir /tmp` and `--dry-run generate` are indistinguishable without knowing
 * which flags take a value.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(['dir', 'runtime']);

/**
 * Narrows an arbitrary string to a {@linkcode TargetRuntime}.
 *
 * @param value - The raw `--runtime` flag value
 * @returns True when the value names a supported runtime target
 */
export function isTargetRuntime(value: string): value is TargetRuntime {
  return (TARGET_RUNTIMES as readonly string[]).includes(value);
}
