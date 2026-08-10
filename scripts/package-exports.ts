/**
 * @module
 *
 * Derives each published package's public export list from its barrel, and
 * renders/parses the `## Exports` table package READMEs carry.
 *
 * Package READMEs used to end at a link to `PUBLIC_API.md`, so the jsr.io page
 * for a package could not answer "what do I actually get?" without leaving the
 * page. The table closes that, but a hand-written one is a set of claims that
 * rot silently, so it is DERIVED from `deno doc --json` over the package's own
 * manifest export targets — the same view JSR renders — and gated for drift.
 *
 * Both the generator (`deno task docs:exports`) and the documentation gate read
 * this module, so the rendered shape and the checked shape cannot disagree.
 */

/** One exported symbol of a package barrel. */
export interface ExportedSymbol {
  /** The exported identifier. */
  readonly name: string;
  /** The declaration kind, as `deno doc` reports it (normalised for display). */
  readonly kind: string;
}

/** A package's exports, grouped by the import specifier that provides them. */
export interface PackageExports {
  /** Import specifier, e.g. `@setu-ts/runtime` or `@setu-ts/runtime/worker`. */
  readonly specifier: string;
  /** Exported symbols, sorted by kind then name. */
  readonly symbols: readonly ExportedSymbol[];
}

/** Maps a `deno doc` declaration kind to the word used in the table. */
const KIND_LABEL: Readonly<Record<string, string>> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  typeAlias: 'type',
  variable: 'const',
  enum: 'enum',
  namespace: 'namespace',
  moduleDoc: 'module',
};

/** Order kinds are listed in, so a regenerated table is byte-stable. */
const KIND_ORDER: readonly string[] = [
  'function',
  'class',
  'const',
  'interface',
  'type',
  'enum',
  'namespace',
  'module',
];

/**
 * Normalises one `deno doc` declaration kind for display.
 *
 * @param kind - The raw kind string from `deno doc --json`
 * @returns The label used in the README table
 */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** The kind `deno doc` reports at a re-export site it did not resolve inline. */
const UNRESOLVED = 'reference';

/**
 * Indexes every symbol `deno doc` DID resolve, by name, across all files.
 *
 * `deno doc` reports a re-exported symbol as `reference` at the re-export site
 * even when the declaring file is in the same batch: `@setu-ts/cache-plugin`
 * re-exports `ICacheStore` from `common`, and the cache-plugin barrel reports
 * `reference` while the common barrel reports `interface` for that same symbol.
 * Left alone this puts "`ICacheStore` | reference" in a package README — a word
 * from the tool's internals that tells a reader nothing about what they can
 * import. 132 rows across the repo were affected.
 *
 * @param payload - Parsed `deno doc --json` output
 * @returns Symbol name to its resolved display kind
 */
export function buildKindIndex(
  payload: { nodes?: Record<string, { symbols?: unknown[] }> },
): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of Object.values(payload.nodes ?? {})) {
    for (const entry of node.symbols ?? []) {
      const symbol = entry as { name?: string; declarations?: { kind?: string }[] };
      if (symbol.name === undefined) continue;
      for (const declaration of symbol.declarations ?? []) {
        if (declaration.kind === undefined || declaration.kind === UNRESOLVED) continue;
        if (!index.has(symbol.name)) index.set(symbol.name, kindLabel(declaration.kind));
      }
    }
  }
  return index;
}

/**
 * Extracts the exported symbols of one file from a `deno doc --json` payload.
 *
 * A symbol may carry several declarations (an interface merged with a const of
 * the same name, for instance); each distinct kind is reported once, because
 * the table answers "what can I import and what is it".
 *
 * @param payload - Parsed `deno doc --json` output
 * @param fileUrl - The `file://` URL of the barrel to read
 * @returns The exported symbols, sorted by kind then name
 */
export function symbolsForFile(
  payload: { nodes?: Record<string, { symbols?: unknown[] }> },
  fileUrl: string,
  kindIndex?: ReadonlyMap<string, string>,
): readonly ExportedSymbol[] {
  const node = payload.nodes?.[fileUrl];
  if (node?.symbols === undefined) return [];

  const seen = new Set<string>();
  const out: ExportedSymbol[] = [];
  for (const raw of node.symbols) {
    const symbol = raw as {
      name?: string;
      declarations?: { kind?: string; declarationKind?: string }[];
    };
    if (symbol.name === undefined || symbol.declarations === undefined) continue;
    for (const declaration of symbol.declarations) {
      if (declaration.declarationKind !== 'export') continue;
      if (declaration.kind === undefined) continue;
      const reported = kindLabel(declaration.kind);
      // A re-export takes the kind the DECLARING barrel reported for it.
      const kind = reported === UNRESOLVED ? (kindIndex?.get(symbol.name) ?? reported) : reported;
      const key = `${symbol.name} ${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: symbol.name, kind });
    }
  }

  return out.sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return byKind !== 0 ? byKind : a.name.localeCompare(b.name);
  });
}

/** The heading the generated table lives under. */
export const EXPORTS_HEADING = '## Exports';

/**
 * Renders the `## Exports` section for a package.
 *
 * @param groups - The package's exports, one entry per import specifier
 * @returns The Markdown section, with no trailing newline
 */
export function renderExportsTable(groups: readonly PackageExports[]): string {
  const lines: string[] = [EXPORTS_HEADING, ''];
  const multi = groups.length > 1;

  for (const group of groups) {
    if (multi) lines.push(`### \`${group.specifier}\``, '');
    lines.push('| Export | Kind |', '| --- | --- |');
    for (const symbol of group.symbols) {
      lines.push(`| \`${symbol.name}\` | ${symbol.kind} |`);
    }
    lines.push('');
  }

  lines.push(
    `Generated from the package barrel by \`deno task docs:exports\`; ` +
      `\`deno task check:docs\` fails when it drifts.`,
  );
  return lines.join('\n');
}

/**
 * Reads the export names a README's `## Exports` table currently claims.
 *
 * @param readme - The README contents
 * @returns The claimed `name kind` pairs, or null when the section is absent
 */
export function parseExportsTable(readme: string): Set<string> | null {
  const start = readme.indexOf(`\n${EXPORTS_HEADING}\n`);
  if (start === -1) return null;
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  const claimed = new Set<string>();
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([a-zA-Z]+)\s*\|$/);
    if (match === null) continue;
    claimed.add(`${match[1]} ${match[2]}`);
  }
  return claimed;
}

/**
 * Compares a README's claimed exports against the barrel's real exports.
 *
 * @param readme - The README contents
 * @param groups - The package's real exports
 * @returns Human-readable drift messages; empty when the table is accurate
 */
export function diffExportsTable(
  readme: string,
  groups: readonly PackageExports[],
): readonly string[] {
  const claimed = parseExportsTable(readme);
  if (claimed === null) return ['has no `## Exports` section'];

  const real = new Set<string>();
  for (const group of groups) {
    for (const symbol of group.symbols) real.add(`${symbol.name} ${symbol.kind}`);
  }

  const messages: string[] = [];
  const missing = [...real].filter((k) => !claimed.has(k));
  const extra = [...claimed].filter((k) => !real.has(k));
  const show = (keys: string[]): string =>
    keys.map((k) => {
      const [name, kind] = k.split(' ');
      return `${name} (${kind})`;
    }).sort().join(', ');

  if (missing.length > 0) messages.push(`table omits ${missing.length}: ${show(missing)}`);
  if (extra.length > 0) {
    messages.push(`table claims ${extra.length} that do not exist: ${show(extra)}`);
  }
  return messages;
}
