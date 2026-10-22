/**
 * Detection of a target project's runtime from the files it already carries.
 *
 * `setu generate` defaulted `SchematicOptions.runtime` to `'deno'` whenever
 * `--runtime` was not passed, which made the flag load-bearing for a value the
 * project already knows. Nobody passes it: `setu new svc --runtime bun` records
 * the choice once, and every later `setu generate` in that project silently
 * assumed Deno.
 *
 * That was harmless while `runtime` only reached custom schematics. It stopped
 * being harmless when the module schematic began choosing a test harness by
 * runtime — a Bun project got `@std/testing/bdd`, which reaches `Deno.test`
 * internally and cannot run there at all.
 *
 * Detected the same way plugins are: by reading the manifests the scaffold
 * wrote, never by booting anything.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { TargetRuntime } from '../constants.ts';
import { joinPath } from './file-writer.ts';
import { isMissingPath } from './filesystem-errors.ts';
import { readJsonManifest } from './manifest-reader.ts';
import { escapeName } from './names.ts';

/**
 * A runtime marker's metadata could not be inspected, so the runtime cannot be
 * decided. Thrown rather than read as absence: an unreadable `wrangler.jsonc`
 * beside a `wrangler dev` start script would otherwise classify a Workers
 * project as Node, and the caller would act on that guess.
 */
export class RuntimeMarkerUnreadableError extends Error {
  /** The marker that could not be read. */
  readonly path: string;
  /** Why it could not be read. */
  readonly reason: string;

  /**
   * @param path - The marker that could not be read
   * @param reason - Why it could not be read
   */
  constructor(path: string, reason: string) {
    // Both values are project-controlled; escaped so neither can forge an output line.
    super(`Cannot read ${escapeName(path)}: ${escapeName(reason)}`);
    this.name = 'RuntimeMarkerUnreadableError';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * Reports whether a marker path exists, without opening its content. Only a missing path counts as absent;
 * any other failure (an access error, an I/O error) is unknown, not absent.
 *
 * @param fs - The filesystem to read through
 * @param path - The absolute path
 * @returns Whether the file is present
 * @throws {RuntimeMarkerUnreadableError} When the path's metadata cannot be inspected
 */
async function markerPresent(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (cause) {
    if (isMissingPath(cause)) return false;
    throw new RuntimeMarkerUnreadableError(
      path,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Every configuration filename Wrangler accepts. The CLI scaffolds
 * `wrangler.toml`, but Wrangler has read JSON and JSONC since v3.91.0 and
 * Cloudflare recommends `wrangler.jsonc` for new projects, so a Workers
 * project carrying either must not be misread as Node.
 */
const WRANGLER_CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] as const;

/** Whether a Deno manifest sits in the directory. */
async function hasDenoManifest(fs: IFileSystem, dir: string): Promise<boolean> {
  return (
    (await markerPresent(fs, joinPath(dir, 'deno.json'))) ||
    (await markerPresent(fs, joinPath(dir, 'deno.jsonc')))
  );
}

/** The answer when no `package.json` decides: Deno when its manifest is present, else Node. */
async function denoOrNode(fs: IFileSystem, dir: string): Promise<TargetRuntime> {
  return (await hasDenoManifest(fs, dir)) ? 'deno' : 'node';
}

/**
 * Detects the runtime a project was scaffolded for.
 *
 * The order is what makes it unambiguous. A Cloudflare Workers project carries
 * BOTH a `deno.json` (which `setu generate` reads for plugin gating) and a
 * `package.json` (which `wrangler` needs), so it has to be recognised by
 * its Wrangler config first or it would be misread as Node. Deno is decided by
 * its own manifest, and a directory with no manifest at all is Node.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory
 * @returns The detected runtime: `'deno'` only when a `deno.json`/`deno.jsonc`
 *   decides it, `'node'` when nothing else does
 * @throws {RuntimeMarkerUnreadableError} When a marker's metadata cannot be inspected
 */
export async function detectTargetRuntime(fs: IFileSystem, dir: string): Promise<TargetRuntime> {
  for (const config of WRANGLER_CONFIGS) {
    if (await markerPresent(fs, joinPath(dir, config))) return 'cloudflare-workers';
  }

  // With no usable `package.json` the Deno manifest decides, and a directory
  // carrying neither falls back to Node, the default target since M111d. Never
  // the bare fallback alone: a Deno-only project has no `package.json` at all,
  // so flipping that fallback would misread every one of them as Node.
  // Presence is decided by metadata first so a stat failure is refused, while
  // unreadable or malformed content takes the same fallback: the plugin detector
  // reports a malformed manifest, and this must not throw on the way there.
  const packagePath = joinPath(dir, 'package.json');
  if (!(await markerPresent(fs, packagePath))) return await denoOrNode(fs, dir);
  const packageJson = await readJsonManifest(fs, packagePath);
  if (packageJson.kind !== 'ok') return await denoOrNode(fs, dir);

  // The `start` script is the marker, because it is what the two targets
  // genuinely differ on: Bun runs TypeScript directly, Node needs a loader.
  const parsed =
    typeof packageJson.value === 'object' && packageJson.value !== null
      ? (packageJson.value as { scripts?: Record<string, string> })
      : {};
  const start = parsed.scripts?.['start'] ?? '';

  if (start.startsWith('bun')) return 'bun';
  if (start !== '') return 'node';

  // No `start`: either a Deno project whose `package.json` exists only for a
  // frontend build (the full-stack template — it carries `deno.json` too), or a
  // hand-written Node/Bun project. Answering `deno` for the second told a Node
  // developer to run `deno install` and gave `setu generate` a Deno test
  // harness whose `@std/*` imports that project cannot resolve. A `deno.json`
  // decides it; otherwise the lockfile tells Bun from Node, the rule
  // `detectProjectRuntime` already uses for `setu adopt`.
  if (await hasDenoManifest(fs, dir)) return 'deno';
  for (const lockfile of ['bun.lock', 'bun.lockb']) {
    if (await markerPresent(fs, joinPath(dir, lockfile))) return 'bun';
  }
  return 'node';
}
