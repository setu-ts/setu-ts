/**
 * Runtime-independent environment and dotenv source loading.
 *
 * @module
 */
import type { IFileSystem, IRuntimeServices } from '@hono-enterprise/common';

import { parseEnv } from '../parsers/env-parser.ts';

/** Internal options for environment loading. */
export interface EnvLoaderOptions {
  /** Dotenv paths ordered from highest to lowest precedence. */
  readonly envFilePath?: string | readonly string[];
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

  const merged = fileSystem === undefined ? {} : await loadFiles(fileSystem, paths);
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
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (let index = paths.length - 1; index >= 0; index--) {
    const path = paths[index];
    const content = await readFile(fileSystem, path);
    Object.assign(merged, parseEnv(content));
  }
  return merged;
}

async function readFile(fileSystem: IFileSystem, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await fileSystem.readFile(path));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`ConfigPlugin: unable to read env file '${path}'${detail}.`);
  }
}
