/**
 * @module
 *
 * `@setu-ts/cli` — the `setu` command-line tool.
 *
 * Provides project scaffolding (`setu new`) and plugin-aware code generation
 * (`setu generate <schematic> <name>`). This barrel is the programmatic
 * surface; the executable entry point is `src/main.ts`.
 *
 * @example
 * ```typescript
 * import { runCli } from '@setu-ts/cli';
 * import { createDenoRuntimeServices } from '@setu-ts/runtime';
 *
 * const runtime = createDenoRuntimeServices();
 * const code = await runCli(['generate', 'service', 'billing'], {
 *   fs: runtime.fs!,
 *   cwd: Deno.cwd(),
 *   now: () => runtime.now(),
 *   log: console.log,
 *   error: console.error,
 * });
 * ```
 *
 * @module
 */

/** Runs the CLI and returns its exit code without terminating the process. */
export { runCli } from './cli.ts';
/** The dependency bundle {@linkcode runCli} takes. */
export type { CliDependencies } from './cli.ts';

/** Derives every naming form a schematic needs from one user-supplied name. */
export { deriveNames } from './utils/names.ts';
/** The five naming forms {@linkcode deriveNames} produces. */
export type { DerivedNames } from './utils/names.ts';

/** One file a schematic asks the command layer to create. */
export type { GeneratedFile } from './utils/file-writer.ts';
/** The contract a schematic module must satisfy. */
export type { Schematic, SchematicOptions } from './schematics/registry.ts';

/** The contract a `.setu-ts/schematics/*.ts` module is loaded through. */
export type { ModuleLoader } from './schematics/custom.ts';
/** The contract the target project's `setu.config.ts` is loaded through. */
export type { AppLoader } from './app-loader.ts';

/** The installed name of the CLI executable, interpolated into all help text. */
export { PROGRAM_NAME } from './constants.ts';
/** A project template accepted by `setu new --template`. */
export type { TemplateName } from './constants.ts';

/** Detects the `@setu-ts` packages a project depends on. */
export { detectPlugins } from './utils/plugin-detector.ts';
