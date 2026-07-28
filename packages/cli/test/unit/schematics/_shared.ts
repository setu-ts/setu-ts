/**
 * Shared helpers for the per-schematic tests.
 *
 * @module
 */
import type { SchematicOptions } from '../../../src/schematics/registry.ts';
import { getSchematic } from '../../../src/schematics/registry.ts';

/** A fixed clock so timestamped output is deterministic. */
export const FIXED_NOW = Date.UTC(2026, 6, 28, 12, 30, 45);

/**
 * Builds schematic options.
 *
 * @param plugins - Packages to report as installed
 * @returns The options every schematic receives
 */
export function options(plugins: readonly string[] = []): SchematicOptions {
  return { runtime: 'deno', plugins: new Set(plugins), now: () => FIXED_NOW };
}

/**
 * Asserts a schematic's registry gate.
 *
 * @param name - The registry key
 * @returns The plugin the schematic requires, or undefined when ungated
 */
export function gateOf(name: string): string | undefined {
  return getSchematic(name)?.requiresPlugin;
}
