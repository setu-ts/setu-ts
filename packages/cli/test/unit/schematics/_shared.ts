/**
 * Shared helpers for the per-schematic tests.
 *
 * @module
 */
import { expect } from '@std/expect';

import type { GeneratedFile, SchematicOptions } from '../../../src/schematics/registry.ts';
import { getSchematic } from '../../../src/schematics/registry.ts';
import { getSeamSpec } from '../../../src/seams/registry.ts';
import type { DerivedNames } from '../../../src/utils/names.ts';
import { deriveNames } from '../../../src/utils/names.ts';

/** A fixed clock so timestamped output is deterministic. */
export const FIXED_NOW = Date.UTC(2026, 6, 28, 12, 30, 45);

/**
 * Builds schematic options.
 *
 * @param plugins - Packages to report as installed
 * @param modules - Domain modules to report as already present
 * @param artifacts - Generated artifacts to report as already present, by schematic name
 * @returns The options every schematic receives
 */
export function options(
  plugins: readonly string[] = [],
  modules: readonly string[] = [],
  artifacts: Readonly<Record<string, readonly string[]>> = {},
): SchematicOptions {
  return {
    runtime: 'deno',
    plugins: new Set(plugins),
    now: () => FIXED_NOW,
    modules,
    artifacts,
  };
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

/**
 * Returns the artifact file a wired schematic emitted — the one that is not its barrel.
 *
 * @param files - Everything the schematic returned
 * @param schematic - The schematic name, for its seam's barrel path
 * @returns The single non-barrel file
 */
export function artifactOf(
  files: readonly GeneratedFile[],
  schematic: string,
): GeneratedFile {
  const barrel = getSeamSpec(schematic)?.barrel;
  const artifacts = files.filter((file) => file.path !== barrel);
  expect(artifacts.length).toBe(1);
  return artifacts[0]!;
}

/**
 * Returns the seam barrel a wired schematic emitted.
 *
 * @param files - Everything the schematic returned
 * @param schematic - The schematic name, for its seam's barrel path
 * @returns The barrel file
 */
export function barrelOf(
  files: readonly GeneratedFile[],
  schematic: string,
): GeneratedFile {
  const barrel = getSeamSpec(schematic)!.barrel;
  const found = files.find((file) => file.path === barrel);
  expect(found).toBeDefined();
  return found!;
}

/**
 * Asserts the seam contract every wired schematic must satisfy.
 *
 * Applied to all ten rather than restated per schematic, because each clause guards a
 * property that is easy to break in exactly one family and easy to miss:
 *
 * - the barrel is the ONLY managed file, so a mistyped artifact name still refuses;
 * - the barrel lists a name already present exactly once, so regenerating is idempotent;
 * - two calls with the same set in a different order are byte-identical, so a no-op
 *   regeneration leaves an empty diff rather than a reordered one.
 *
 * @param schematic - The schematic name
 * @param name - A name to generate
 * @param existing - Names to report as already present, EXCLUDING `name`. At least TWO
 *   are required, and NOT in sorted order: with one name, or with names already sorted,
 *   the reversal below is a no-op and the determinism clause passes whether the barrel
 *   sorts or not. A negative control that dropped the sort proved that the single-name
 *   form this helper started with was vacuous.
 * @param opts - Extra options the schematic needs (a plugin set, say)
 */
export function assertSeamContract(
  schematic: string,
  name: string,
  existing: readonly string[],
  opts: { readonly plugins?: readonly string[] } = {},
): void {
  const factory = getSchematic(schematic)!.factory;
  const names: DerivedNames = deriveNames(name);
  const spec = getSeamSpec(schematic)!;
  const plugins = opts.plugins ?? [];

  expect(existing.length).toBeGreaterThanOrEqual(2);
  expect([...existing]).not.toEqual([...existing].sort());

  const files = factory(names, options(plugins, [], { [schematic]: existing }));

  // Exactly one managed file, and it is the barrel.
  expect(files.filter((f) => f.managed === true).map((f) => f.path)).toEqual([spec.barrel]);

  // The generated name appears once even when the scan already reported it.
  const withDuplicate = factory(
    names,
    options(plugins, [], { [schematic]: [...existing, names.kebab] }),
  );
  expect(barrelOf(withDuplicate, schematic).contents).toBe(
    barrelOf(files, schematic).contents,
  );

  // Byte-identical across reordered input: the barrel sorts before rendering.
  const reversed = factory(
    names,
    options(plugins, [], { [schematic]: [...existing].reverse() }),
  );
  expect(barrelOf(reversed, schematic).contents).toBe(barrelOf(files, schematic).contents);
}
