/**
 * Runtime-independent environment and dotenv source loading.
 *
 * @module
 */
import type { IFileSystem, IRuntimeServices } from '@setu-ts/common';

import { parseEnv } from '../parsers/env-parser.ts';

/** Internal options for environment loading. */
export interface EnvLoaderOptions {
  /** Dotenv paths ordered from highest to lowest precedence. */
  readonly envFilePath?: string | readonly string[];
  /** When true, a path that does not exist is skipped instead of throwing. */
  readonly envFileOptional?: boolean;
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
  const paths = normalizePaths(options.envFilePath);
  const fileSystem = runtime.fs;

  if (paths.length > 0 && fileSystem === undefined) {
    throw new Error(
      'ConfigPlugin: envFilePath requires a runtime with filesystem support.',
    );
  }

  const merged = fileSystem === undefined
    ? {}
    : await loadFiles(fileSystem, paths, options.envFileOptional ?? false);
  for (const [key, value] of Object.entries(runtime.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
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
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (let index = paths.length - 1; index >= 0; index--) {
    const path = paths[index];
    if (optional && !await exists(fileSystem, path)) continue;
    const content = await readFile(fileSystem, path);
    Object.assign(merged, parseEnv(content));
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
