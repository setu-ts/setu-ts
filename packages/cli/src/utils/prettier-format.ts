/**
 * Formats what the CLI writes into an npm-target project with Prettier.
 *
 * The renderers are shared by every target and emit the layout `deno fmt`
 * produces, which a Deno project's own `deno fmt --check` accepts. Prettier
 * disagrees with that layout on long calls, wrapped signatures, JSON arrays
 * and JSX — measured across every template on 2026-10-12 — so a fresh Node,
 * Bun or Workers project failed its own `npm run format:check` on files the
 * CLI had just written. Formatting the planned files here makes them clean by
 * construction, for `setu new` and for every later `setu generate`, and keeps
 * one layout to maintain in the renderers rather than two (maintainer-approved
 * Prettier dependency, 2026-10-12).
 *
 * The parser is chosen by extension here rather than by Prettier's
 * `getFileInfo`, which resolves its ignore file from the PROCESS's working
 * directory — the wrong project whenever `--dir` points elsewhere.
 *
 * @module
 */

import { resolve, sep } from 'node:path';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';

import { joinPath } from './file-writer.ts';
import type { GeneratedFile } from './file-writer.ts';
import type { TargetRuntime } from '../constants.ts';
import { PRETTIER_OPTIONS } from '../templates/npm-tooling.ts';

/** The part of Prettier's API this module uses. */
export interface PrettierApi {
  /** Locates the config file governing `path`, WITHOUT loading it. */
  resolveConfigFile(path: string): Promise<string | null>;
  resolveConfig(path: string, options: { config: string }): Promise<Record<string, unknown> | null>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
}

/** Loads Prettier; the seam tests replace. */
export type PrettierLoader = () => Promise<PrettierApi>;

/** The default loader: Prettier, a regular dependency of this package. */
export const loadPrettier: PrettierLoader = async () => {
  let prettier: typeof import('prettier');
  try {
    prettier = await import('prettier');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('prettier', {
      requiredBy: '@setu-ts/cli',
      cause: error,
    });
  }
  return {
    resolveConfigFile: (path) => prettier.resolveConfigFile(path),
    resolveConfig: (path, options) => prettier.resolveConfig(path, options),
    format: (source, options) => prettier.format(source, options),
  };
};

/** Prettier's parser for each extension a generated project contains. */
const PARSERS: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  json: 'json',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
};

/**
 * The parser Prettier formats a path with, or `undefined` when it has none.
 *
 * @param path - The file's path
 * @returns The parser name
 */
export function parserFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1);
  return Object.hasOwn(PARSERS, extension) ? PARSERS[extension] : undefined;
}

/**
 * Whether a target's project is formatted with Prettier.
 *
 * @param runtime - The project's runtime target
 * @returns `true` for every npm-manifest target; a Deno project keeps `deno fmt`
 */
export function formatsWithPrettier(runtime: TargetRuntime): boolean {
  return runtime !== 'deno';
}

/**
 * The absolute path a planned file is written to: commands plan some files
 * relative to the project and some absolute.
 *
 * @param projectRoot - The project directory
 * @param path - The planned path
 * @returns The destination path
 */
function destination(projectRoot: string, path: string): string {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : joinPath(projectRoot, path);
}

/**
 * The Prettier configuration for one destination, taken only from INSIDE the
 * project.
 *
 * Prettier's own lookup walks up to the filesystem root and imports a
 * JavaScript config it finds there, plugins included — so a
 * `prettier.config.mjs` planted in a directory above the project (a shared
 * parent, `/tmp`) would run in the developer's process on the next
 * `setu generate`. The config FILE is located first, which reads no code, and
 * loaded only when it lies within the project; otherwise the options the
 * scaffold writes apply (M111d audit F3).
 *
 * @param prettier - The Prettier API
 * @param projectRoot - The project directory
 * @param path - The destination file
 * @returns The options to format `path` with
 */
async function projectConfig(
  prettier: PrettierApi,
  projectRoot: string,
  path: string,
): Promise<Record<string, unknown>> {
  const file = await prettier.resolveConfigFile(path);
  const root = resolve(projectRoot);
  if (file === null || !resolve(file).startsWith(`${root}${sep}`)) return PRETTIER_OPTIONS;
  return (await prettier.resolveConfig(path, { config: file })) ?? PRETTIER_OPTIONS;
}

/** One file Prettier could not format, kept as rendered. */
export interface FormatSkip {
  readonly path: string;
  readonly reason: string;
}

/** The formatted plan, and any file that had to be left as rendered. */
export interface FormattedPlan {
  readonly files: readonly GeneratedFile[];
  readonly skipped: readonly FormatSkip[];
}

/**
 * Formats every planned file Prettier has a parser for.
 *
 * With a `projectRoot` the configuration is the project's own for each
 * destination file when it has one on disk — `overrides` and nested config files
 * included — so a later `setu generate` honours a project that changed its style;
 * without one — `setu new`, before the project exists — it is the options the
 * scaffold writes into `.prettierrc.json`. A file whose source Prettier cannot
 * parse (a custom schematic's malformed output) is kept as rendered and
 * reported, rather than blocking the write.
 *
 * @param files - The planned files
 * @param projectRoot - An existing project the files are written into, if any
 * @param load - Loads Prettier; defaults to the real package
 * @returns The plan with each formattable file's contents replaced
 */
export async function formatPlannedFiles(
  files: readonly GeneratedFile[],
  projectRoot?: string,
  load: PrettierLoader = loadPrettier,
): Promise<FormattedPlan> {
  if (!files.some((file) => parserFor(file.path) !== undefined)) return { files, skipped: [] };
  const prettier = await load();
  const out: GeneratedFile[] = [];
  const skipped: FormatSkip[] = [];
  for (const file of files) {
    const parser = parserFor(file.path);
    if (parser === undefined) {
      out.push(file);
      continue;
    }
    try {
      // Resolved for EACH destination, so an `overrides` entry or a nested
      // config file applies exactly as the project's own `format:check` reads it.
      const config =
        projectRoot === undefined
          ? PRETTIER_OPTIONS
          : await projectConfig(prettier, projectRoot, destination(projectRoot, file.path));
      out.push({ ...file, contents: await prettier.format(file.contents, { ...config, parser }) });
    } catch (cause) {
      out.push(file);
      skipped.push({
        path: file.path,
        reason: cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : String(cause),
      });
    }
  }
  return { files: out, skipped };
}

/**
 * The files a command writes into a project of `runtime`: formatted with
 * Prettier for an npm target, unchanged for Deno. Every skipped file is
 * reported through `report`, so a malformed custom schematic is visible.
 *
 * @param files - The planned files
 * @param runtime - The project's runtime target
 * @param projectRoot - An existing project the files are written into, if any
 * @param report - Receives one line per skipped file
 * @param load - Loads Prettier; defaults to the real package
 * @returns The files to write
 */
export async function formatForTarget(
  files: readonly GeneratedFile[],
  runtime: TargetRuntime,
  projectRoot: string | undefined,
  report: (message: string) => void,
  load: PrettierLoader = loadPrettier,
): Promise<readonly GeneratedFile[]> {
  if (!formatsWithPrettier(runtime)) return files;
  const plan = await formatPlannedFiles(files, projectRoot, load);
  for (const skip of plan.skipped) {
    report(`Left ${skip.path} as rendered: Prettier could not parse it (${skip.reason}).`);
  }
  return plan.files;
}
