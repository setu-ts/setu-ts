/**
 * Runtime-independent environment and dotenv source loading.
 *
 * @module
 */
import type { IFileSystem, IRuntimeServices } from '@setu-ts/common';

import type { EnvSourceObservation } from '../diagnostics/provenance.ts';
import { MAX_OVERRIDDEN_ALIASES } from '../diagnostics/provenance.ts';
import { parseEnv } from '../parsers/env-parser.ts';

/** Internal options for environment loading. */
export interface EnvLoaderOptions {
  /** Dotenv paths ordered from highest to lowest precedence. */
  readonly envFilePath?: string | readonly string[];
  /** When true, a path that does not exist is skipped instead of throwing. */
  readonly envFileOptional?: boolean;
}

/**
 * The exact configured path to approved source-alias map provenance merges
 * through. Absent means no aliasing: every file origin stays category-only.
 *
 * @internal
 */
export interface EnvProvenanceOptions {
  readonly aliasByPath: ReadonlyMap<string, string>;
}

/**
 * The merged values plus the per-key source observation each final value
 * carries after the merge. Produced only by
 * {@linkcode loadEnvWithProvenance}; plain {@linkcode loadEnv} discards the
 * observations and costs nothing extra.
 *
 * @internal
 */
export interface EnvLoadResult {
  readonly values: Record<string, string>;
  /** Final per-key source observations, keyed by exact configuration key. */
  readonly sources: ReadonlyMap<string, EnvSourceObservation>;
}

/**
 * Loads and merges raw configuration sources.
 *
 * Runtime environment variables override all dotenv files. Among files,
 * earlier paths override later paths. Expansion deliberately happens after
 * this function so references observe the final values.
 *
 * @param runtime - Runtime services providing environment and optional files
 * @param options - Source-loading options
 * @returns Final merged, unexpanded string values
 * @throws {Error} If configured files cannot be accessed or parsed
 */
export async function loadEnv(
  runtime: IRuntimeServices,
  options: EnvLoaderOptions = {},
): Promise<Record<string, string>> {
  return (await loadEnvWithProvenance(runtime, options)).values;
}

/**
 * The one merge implementation, with optional provenance observation. When
 * `diagnostics` is absent the observations map is not built at all — the
 * disabled path does no new work — and the merge itself is byte-identical to
 * {@linkcode loadEnv} in both cases: the same loop order, the same
 * assignments, the same errors.
 *
 * As each existing merge step wins, the winning source displaces the
 * previous one: the displaced source's approved alias is appended to the
 * key's displacement list (lowest-precedence first, capped at the approved
 * budget) and the record is replaced by the winner. An unapproved file path
 * contributes only its category — never the path, its name, or a count.
 *
 * @param runtime - Runtime services providing environment and optional files
 * @param options - Source-loading options
 * @param diagnostics - Optional provenance aliasing
 * @returns Merged values plus per-key source observations
 * @throws {Error} If configured files cannot be accessed or parsed
 * @internal
 */
export async function loadEnvWithProvenance(
  runtime: IRuntimeServices,
  options: EnvLoaderOptions = {},
  diagnostics?: EnvProvenanceOptions,
): Promise<EnvLoadResult> {
  const paths = normalizePaths(options.envFilePath);
  const fileSystem = runtime.fs;

  if (paths.length > 0 && fileSystem === undefined) {
    throw new Error(
      'ConfigPlugin: envFilePath requires a runtime with filesystem support.',
    );
  }

  const sources = new Map<string, EnvSourceObservation>();
  const merged = fileSystem === undefined
    ? {}
    : await loadFiles(fileSystem, paths, options.envFileOptional ?? false, diagnostics, sources);
  for (const [key, value] of Object.entries(runtime.env)) {
    if (value !== undefined) {
      if (diagnostics !== undefined) {
        recordDisplacement(sources, key, { origin: 'environment' });
      }
      merged[key] = value;
    }
  }
  return diagnostics === undefined
    ? { values: merged, sources: new Map() }
    : { values: merged, sources };
}

/**
 * Replaces a key's source observation with a winning one, appending the
 * displaced source's approved alias (when it had one) to the displacement
 * list, lowest-precedence first, capped at the approved budget.
 *
 * @param sources - The observations being built
 * @param key - The configuration key whose value was displaced
 * @param winner - The winning source without its displacement list
 */
function recordDisplacement(
  sources: Map<string, EnvSourceObservation>,
  key: string,
  winner: { readonly origin: 'environment' | 'file'; readonly sourceAlias?: string },
): void {
  const previous = sources.get(key);
  const displaced = previous === undefined ? [] : [
    ...previous.overriddenSourceAliases,
    ...(previous.sourceAlias === undefined ? [] : [previous.sourceAlias]),
  ].slice(-MAX_OVERRIDDEN_ALIASES);
  sources.set(key, {
    origin: winner.origin,
    ...(winner.sourceAlias === undefined ? {} : { sourceAlias: winner.sourceAlias }),
    overriddenSourceAliases: Object.freeze(displaced),
  });
}

function normalizePaths(path: string | readonly string[] | undefined): readonly string[] {
  if (path === undefined) {
    return [];
  }
  return typeof path === 'string' ? [path] : path;
}

async function loadFiles(
  fileSystem: IFileSystem,
  paths: readonly string[],
  optional: boolean,
  diagnostics: EnvProvenanceOptions | undefined,
  sources: Map<string, EnvSourceObservation>,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  // Lowest-precedence file first, so a higher-precedence file's assignment
  // overwrites in place — the existing behaviour — and the displacement is
  // observed as the merge step wins.
  for (let index = paths.length - 1; index >= 0; index--) {
    const path = paths[index];
    if (optional && !await exists(fileSystem, path)) continue;
    const content = await readFile(fileSystem, path);
    const parsed = parseEnv(content);
    if (diagnostics !== undefined) {
      const sourceAlias = diagnostics.aliasByPath.get(path);
      for (const key of Object.keys(parsed)) {
        recordDisplacement(sources, key, {
          origin: 'file',
          ...(sourceAlias === undefined ? {} : { sourceAlias }),
        });
      }
    }
    Object.assign(merged, parsed);
  }
  return merged;
}

/**
 * Reports whether a path is there at all.
 *
 * Deliberately a `stat` probe rather than a `readFile` catch: absence and
 * unreadability are different faults, and only the first is tolerable. Every
 * runtime spells its not-found error differently, so probing is also the only
 * portable way to tell them apart.
 *
 * @param fileSystem - The runtime's filesystem
 * @param path - The dotenv path to probe
 * @returns Whether the path can be stat'd
 */
async function exists(fileSystem: IFileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readFile(fileSystem: IFileSystem, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await fileSystem.readFile(path));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`ConfigPlugin: unable to read env file '${path}'${detail}.`);
  }
}
