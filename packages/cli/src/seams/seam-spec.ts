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

import type { DerivedNames } from '../utils/names.ts';
import { deriveNames } from '../utils/names.ts';
import { GENERATED_LINE_WIDTH } from '../templates/root-settings.ts';

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
   * The first half of the admission rule. The second half is
   * {@linkcode SeamSpec.importSymbols}: a suffix is a claim about intent, not a
   * guarantee that the file exports what the barrel is about to name.
   */
  readonly suffix: string;
  /**
   * The symbols the barrel imports FROM one artifact module.
   *
   * Read by two callers deliberately, so they cannot disagree: `renderBarrel` names
   * these in the import it emits, and `readArtifactNames` requires the file to export
   * every one of them before admitting it.
   *
   * Splitting those two was a real defect. `middleware` and `metric` each gained a
   * second export in M60, and a project that generated one of them earlier got a
   * regenerated barrel importing a symbol its own file did not have — so `deno check`
   * failed on a file the CLI had just reported creating.
   *
   * @param names - The artifact's derived naming forms
   * @returns The symbols, in the order the import should name them
   */
  readonly importSymbols: (names: DerivedNames) => readonly string[];
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
/**
 * Renders one import statement, wrapping when it would exceed the width.
 *
 * The same budget the declarations answer to, and for the same reason: a family
 * whose artifact exports two or three symbols emits an import line that
 * `deno fmt` rewraps, so a scaffolded project fails its own `deno fmt --check`
 * on a barrel the CLI wrote. Measured before this: 103–112 columns in the CQRS,
 * events and middleware barrels once three artifacts existed.
 *
 * The wrapped shape is the one `deno fmt` itself produces, so formatting the
 * result is a no-op rather than a rewrite.
 *
 * @param symbols - The names to import
 * @param module - The module specifier, already relative
 * @returns The import statement
 */
function renderImport(symbols: readonly string[], module: string): string {
  const sorted = fmtSortSpecifiers(symbols);
  const inline = `import { ${sorted.join(', ')} } from '${module}';`;
  if (inline.length <= GENERATED_LINE_WIDTH) return inline;
  return `import {\n  ${sorted.join(',\n  ')},\n} from '${module}';`;
}

/**
 * Sorts import specifiers the way `deno fmt` does: case-insensitively, with the
 * uppercase spelling first on a case-only tie.
 *
 * `deno fmt` reorders the specifiers inside an import statement, so a barrel that
 * lists them in any other order fails the generated project's own
 * `deno fmt --check`. Pre-M70d the CQRS and event barrels happened to list their two
 * symbols already in the sorted order — the SCREAMING constant sorts before its
 * PascalCase class, because `_` (0x5F) sorts before a letter — which is why the
 * defect surfaced only when the camelCase factory symbol was added: `create…` sorts
 * before the constant, so the emit order (constant first) no longer matched.
 *
 * Both rules were probed against `deno fmt` itself rather than assumed:
 * `{ bAlpha, Bbeta, aZulu }` → `{ aZulu, bAlpha, Bbeta }`, and `{ abc, ABC }` →
 * `{ ABC, abc }`. They are expressed as one sort KEY — the case-folded name, a
 * separator no identifier can contain, then the original spelling — rather than a
 * hand-rolled tie-break loop. That is not only shorter: the loop's arms were
 * unreachable from every seam spec (no two `importSymbols` results can collide in
 * case), so they sat permanently untested, and a key has no arm to leave untaken.
 *
 * The comparator deliberately has no zero arm. Equal keys mean two BYTE-IDENTICAL
 * symbols, which no `importSymbols` result contains — and if one ever did, their
 * relative order would be unobservable, because the emitted text is the same either
 * way. Keeping the arm would mean shipping a third branch nothing can reach.
 *
 * @param symbols - The names to order
 * @returns The names, in the order `deno fmt` would leave them
 */
function fmtSortSpecifiers(symbols: readonly string[]): string[] {
  const key = (symbol: string): string => `${symbol.toLowerCase()}\u0000${symbol}`;
  return [...symbols].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

/**
 * Renders an exported readonly-array declaration, wrapping when it runs long.
 *
 * Takes the NAME and the ELEMENT TYPE rather than a pre-measured prefix width,
 * because the width is then derived from the very text this returns and a caller
 * cannot get it wrong. The previous shape took a `prefixWidth` number defaulting
 * to 24, which every caller had to remember to override with its own
 * declaration's length — six of the eight did not, and the CQRS barrel that did
 * wrote the declaration out a second time just to call `.length` on it.
 *
 * That default is the X2-4 defect in miniature. Measured: three generated
 * plugins rendered
 * `export const GENERATED_PLUGINS: readonly IPlugin[] = [OrderArchivePlugin(), …];`
 * at **123 columns**, and the scaffolded project failed its own
 * `deno fmt --check` on a file the CLI had just written.
 *
 * @param name - The exported constant's name
 * @param elementType - The array's element type, without the `[]`
 * @param entries - The rendered entries, already in source form
 * @returns The complete declaration, ending in `;`
 */
export function renderExportedArray(
  name: string,
  elementType: string,
  entries: readonly string[],
): string {
  const prefix = `export const ${name}: readonly ${elementType}[] = [`;
  const inline = entries.join(', ');

  // `+ 2` for the closing `];`. Measured against the line the entries actually
  // land on, which is the whole point of deriving the prefix here.
  if (entries.length === 0 || prefix.length + inline.length + 2 <= GENERATED_LINE_WIDTH) {
    return `${prefix}${inline}];`;
  }
  return `${prefix}\n  ${entries.join(',\n  ')},\n];`;
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
 * Takes the spec's own {@linkcode SeamSpec.importSymbols} rather than a symbol callback
 * of its own, so the symbols this emits are exactly the ones the scanner requires the
 * file to export.
 *
 * @param names - Artifact names (kebab-case), already sorted
 * @param symbols - The spec's `importSymbols`
 * @param module - Maps an artifact's kebab name to the specifier to import from
 * @returns The import statements, one per line, or `''` when there are none
 */
export function renderSeamImports(
  names: readonly string[],
  symbols: (names: DerivedNames) => readonly string[],
  module: (kebab: string) => string,
): string {
  if (names.length === 0) return '';
  return names
    .map((name) => renderImport(symbols(deriveNames(name)), module(name)))
    .join('\n');
}

/**
 * Reports whether a module's source exports a symbol.
 *
 * A source-text check rather than a parse, because this package has a zero-dependency
 * surface and carries no TypeScript parser. It recognizes the declaration form
 * (`export const|function|class|…  X`) and the named-re-export form (`export { X }`,
 * including `y as X`), which covers everything the CLI itself emits.
 *
 * An aliased default export, or a symbol re-exported through `export * from`, reads as
 * ABSENT. That direction is deliberate: a false negative skips the artifact and reports
 * it, while a false positive would put an unresolvable import in the developer's barrel
 * — so the heuristic errs toward the outcome that still compiles.
 *
 * The symbol is interpolated into a pattern unescaped, which is safe because every
 * caller passes an identifier derived by `deriveNames` — letters and digits only, never
 * a regular-expression metacharacter.
 *
 * @param source - The module's source text
 * @param symbol - The identifier to look for
 * @returns True when the module appears to export it
 */
export function exportsSymbol(source: string, symbol: string): boolean {
  const declaration = new RegExp(
    `export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
      `(?:const|let|var|function|class|type|interface|enum)\\s+${symbol}\\b`,
  );
  if (declaration.test(source)) return true;

  // `export { a, b as c }` — the symbol may appear as the local name or the alias.
  // Matched WITHOUT a capture group, and tested against the whole match: a group would
  // need a `?? ''` fallback for its `string | undefined` type, and that fallback is
  // unreachable, so it would sit permanently uncovered. Including the `export {` and `}`
  // in the tested text is harmless, because a symbol is always a derived identifier and
  // never the reserved word itself.
  const word = new RegExp(`\\b${symbol}\\b`);
  for (const clause of source.matchAll(/export\s*\{[^}]*\}/g)) {
    if (word.test(clause[0])) return true;
  }
  return false;
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
