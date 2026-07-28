/**
 * `@hono-enterprise/cli` — the `honoe` command-line tool.
 *
 * Provides project scaffolding (`honoe new`) and plugin-aware code generation
 * (`honoe generate <schematic> <name>`). This barrel is the programmatic
 * surface; the executable entry point is `src/main.ts`.
 *
 * @example
 * ```typescript
 * import { runCli } from '@hono-enterprise/cli';
 * import { createDenoRuntimeServices } from '@hono-enterprise/runtime';
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

/** The contract a `.hono-enterprise/schematics/*.ts` module is loaded through. */
export type { ModuleLoader } from './schematics/custom.ts';

/** The installed name of the CLI executable, interpolated into all help text. */
export { PROGRAM_NAME } from './constants.ts';
/** A project template accepted by `honoe new --template`. */
export type { TemplateName } from './constants.ts';

/** Detects the `@hono-enterprise` packages a project depends on. */
export { detectPlugins } from './utils/plugin-detector.ts';
