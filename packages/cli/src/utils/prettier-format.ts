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

import { joinPath } from './file-writer.ts';
import type { GeneratedFile } from './file-writer.ts';
import type { TargetRuntime } from '../constants.ts';
import { PRETTIER_OPTIONS } from '../templates/npm-tooling.ts';

/** The part of Prettier's API this module uses. */
export interface PrettierApi {
  resolveConfig(path: string): Promise<Record<string, unknown> | null>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
}

/** Loads Prettier; the seam tests replace. */
export type PrettierLoader = () => Promise<PrettierApi>;

/** The default loader: Prettier, a regular dependency of this package. */
export const loadPrettier: PrettierLoader = async () => {
  const prettier = await import('prettier');
  return {
    resolveConfig: (path) => prettier.resolveConfig(path),
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
 * With a `projectRoot` the configuration is the project's own when it has one
 * on disk, so a later `setu generate` honours a project that changed its style;
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
  const config = projectRoot === undefined
    ? PRETTIER_OPTIONS
    : await prettier.resolveConfig(joinPath(projectRoot, 'package.json')) ?? PRETTIER_OPTIONS;
  const out: GeneratedFile[] = [];
  const skipped: FormatSkip[] = [];
  for (const file of files) {
    const parser = parserFor(file.path);
    if (parser === undefined) {
      out.push(file);
      continue;
    }
    try {
      out.push({ ...file, contents: await prettier.format(file.contents, { ...config, parser }) });
    } catch (cause) {
      out.push(file);
      skipped.push({
        path: file.path,
        reason: cause instanceof Error ? cause.message.split('\n')[0] ?? '' : String(cause),
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
