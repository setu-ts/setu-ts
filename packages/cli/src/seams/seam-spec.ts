/**
 * The seam contract — how a generated artifact reaches its registration site.
 *
 * M58 proved one instance of this shape: a CLI-owned barrel that the scaffolded
 * `setu.config.ts` already imports, regenerated from a directory scan handed to a
 * pure schematic. This module generalizes it, so the ten wired families share one
 * scanner, one determinism rule, and one set of rendering helpers rather than ten
 * copies of each.
 *
 * A spec is DATA plus one render function. The command layer reads `dir`/`suffix`
 * to scan, the schematic reads `renderBarrel` to emit, and the templates read
 * `barrel`/`exports` to wire — so a family cannot acquire a barrel the config does
 * not import, or an import the barrel does not export.
 *
 * @module
 */

import { deriveNames } from '../utils/names.ts';

/**
 * The artifact names already present in a project, keyed by schematic name.
 *
 * Keyed by SCHEMATIC rather than by directory because two schematics can share one
 * barrel — `command-handler` and `query-handler` both live in `src/cqrs/` and both
 * appear in `src/cqrs/index.ts` — and that barrel has to list each kind under its
 * own export.
 */
export type SeamArtifacts = Readonly<Record<string, readonly string[]>>;

/**
 * One generated family's route from artifact file to registration site.
 */
export interface SeamSpec {
  /** The `setu generate` schematic name this seam belongs to. */
  readonly schematic: string;
  /** Directory the artifacts live in, relative to the project root. */
  readonly dir: string;
  /**
   * Filename suffix that identifies an artifact of this family.
   *
   * Load-bearing rather than cosmetic: it is the admission rule that keeps a
   * hand-written module in the same directory out of the barrel. Admitting one
   * would make the barrel import a symbol the developer never wrote, so their
   * project would fail to compile naming a file they never generated.
   */
  readonly suffix: string;
  /** The barrel's path, relative to the project root. */
  readonly barrel: string;
  /**
   * The symbols the barrel exports, in the order a `LocalImport` should name them.
   *
   * Declared here so `templates/seam.ts` derives the config's import from the same
   * source the barrel is rendered from — the two cannot disagree.
   */
  readonly exports: readonly string[];
  /**
   * The `@setu-ts` package that must be installed for a host template to consume
   * this seam. Omitted → consumable by any project, which is what the router,
   * middleware and plugin seams need.
   */
  readonly requiresPlugin?: string;
  /**
   * Renders the whole barrel from every family's artifact names.
   *
   * Takes the full {@linkcode SeamArtifacts} rather than one name list so a shared
   * barrel can read both of its kinds.
   *
   * @param artifacts - Artifact names by schematic name
   * @returns The barrel file contents
   */
  readonly renderBarrel: (artifacts: SeamArtifacts) => string;
}

/**
 * Returns one family's artifact names, deduplicated and sorted.
 *
 * Sorted because `readdir` enumeration order is filesystem-defined: without it a
 * regenerated barrel could differ byte-for-byte between two machines holding
 * exactly the same artifacts, turning a no-op regeneration into a diff.
 *
 * @param artifacts - Artifact names by schematic name
 * @param schematic - The schematic whose names to read
 * @param extra - A name to include even when the scan has not seen it yet — the
 *   artifact being generated right now
 * @returns The names, deduplicated and sorted
 */
export function seamNames(
  artifacts: SeamArtifacts | undefined,
  schematic: string,
  extra?: string,
): readonly string[] {
  const scanned = artifacts?.[schematic] ?? [];
  const all = extra === undefined ? scanned : [...scanned, extra];
  return [...new Set(all)].sort();
}

/**
 * Renders an array literal's contents, breaking onto indented lines once the
 * single-line form would run past the formatter's width.
 *
 * @param entries - Rendered entries
 * @returns The text between the brackets
 */
export function renderList(entries: readonly string[]): string {
  if (entries.length === 0) return '';
  const inline = entries.join(', ');
  if (inline.length <= 76) return inline;
  return `\n  ${entries.join(',\n  ')},\n`;
}

/**
 * Renders the header every seam barrel opens with.
 *
 * States that the CLI owns the file — the barrel is {@linkcode
 * GeneratedFile.managed}, so it is rewritten on every generate and a hand edit is
 * lost. It also states the wiring, because a project scaffolded before this seam
 * existed has no import of it and no diagnostic would otherwise say so.
 *
 * @param command - The `setu generate` command that owns this barrel
 * @param wiring - The lines a pre-existing project adds to `setu.config.ts`
 * @returns The comment block, ending in a blank line
 */
export function seamHeader(command: string, wiring: readonly string[]): string {
  const lines = [
    // The command goes on its own line: `command-handler / query-handler` is long
    // enough that folding it into the sentence below pushed the comment past 110
    // characters in the emitted file.
    `// Generated by \`${command}\`.`,
    `// The CLI owns this file and rewrites it whenever an artifact is added, so edits`,
    `// here are lost — add them with the CLI.`,
    '//',
    '// `setu.config.ts` consumes it as:',
    '//',
    ...wiring.map((line) => `//   ${line}`),
    '//',
    '// If you scaffolded this project before this seam existed, add those lines to',
    '// wire generated artifacts in.',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Renders one import per artifact, in the order the names are given.
 *
 * @param names - Artifact names (kebab-case), already sorted
 * @param symbol - Maps an artifact's derived names to the symbol to import
 * @param module - Maps an artifact's kebab name to the specifier to import from
 * @returns The import statements, one per line, or `''` when there are none
 */
export function renderSeamImports(
  names: readonly string[],
  symbol: (names: ReturnType<typeof deriveNames>) => string,
  module: (kebab: string) => string,
): string {
  if (names.length === 0) return '';
  return names
    .map((name) => `import { ${symbol(deriveNames(name))} } from '${module(name)}';`)
    .join('\n');
}

/**
 * Assembles a barrel from its header, imports and declarations.
 *
 * One assembler for all ten families so the blank-line layout is decided once —
 * `deno fmt` runs over a scaffolded project in CI, and ten hand-spaced templates
 * would drift from it independently.
 *
 * @param header - The output of {@linkcode seamHeader}
 * @param imports - Import statements, or `''` when the family is empty
 * @param declarations - The exported declarations, already rendered
 * @returns The barrel file contents
 */
export function assembleSeamBarrel(
  header: string,
  imports: string,
  declarations: readonly string[],
): string {
  const body = declarations.join('\n\n');
  const importBlock = imports === '' ? '' : `${imports}\n\n`;
  return `${header}\n${importBlock}${body}\n`;
}
