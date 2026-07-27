/**
 * CLI tool with plugin-aware scaffolding and code generation.
 *
 * This package provides the `honoe` command-line interface for project scaffolding
 * (`honoe new`) and code generation (`honoe generate`).
 *
 * @module
 */

// Re-export core symbols for programmatic use
export { runCli } from './cli.ts';
export { deriveNames } from './utils/names.ts';
export type { DerivedNames } from './utils/names.ts';
export { SCHEMATICS } from './constants.ts';
export { PROGRAM_NAME } from './constants.ts';
export type { CliDependencies } from './cli.ts';

// Types from schematics registry
export type { GeneratedFile, Schematic, SchematicOptions } from './schematics/registry.ts';

// Detection utility
export { detectPlugins } from './utils/plugin-detector.ts';
