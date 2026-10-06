/** Development-only source policies, shared by scaffold, enable and add. @module */
import type { IFileSystem } from '@setu-ts/common';
import type { GeneratedFile } from '../utils/file-writer.ts';
import { joinPath } from '../utils/file-writer.ts';
import { PLUGIN_HEALTH_INDICATORS } from '../utils/plugin-claims.ts';
import { scanArtifacts } from '../utils/artifact-scanner.ts';
import { scanSeamSpecs } from '../seams/registry.ts';
import { generatorMode } from '../utils/generator-mode.ts';
import { readEnvFilePath } from '../templates/env-file.ts';

/** CLI-owned policy module, refreshed when a plugin is installed. */
export const DEVTOOL_SOURCES_MODULE = 'src/devtool/diagnostics.ts';

/** Names the CLI can approve without executing application code. */
export interface IDevtoolSourceNames {
  /** Project alias used by the trace source. */
  readonly project: string;
  /** Names discovered from generated artifact families. */
  readonly artifacts?: Readonly<Record<string, readonly string[]>>;
  /** Configuration key names, never their values. */
  readonly envKeys?: readonly string[];
  /** Whether a recognized RBAC option enables authorization observations. */
  readonly authorization?: boolean;
  /** Custom transports require application-owned diagnostics. */
  readonly customBackplane?: boolean;
}

interface ISourceRow {
  /** Owning plugin package. */
  readonly pkg: string;
  /** Key in the generated policy object. */
  readonly key: string;
  /** Exported plugin factory name. */
  readonly symbol: string;
  /** Exported diagnostics option type. */
  readonly type: string;
  /** Type owner when shared by several plugins. */
  readonly typePackage?: string;
}

const ROWS: readonly ISourceRow[] = [
  { pkg: 'cache-plugin', key: 'cache', symbol: 'CachePlugin', type: 'CacheDiagnosticsOptions' },
  {
    pkg: 'storage-plugin',
    key: 'storage',
    symbol: 'StoragePlugin',
    type: 'StorageDiagnosticsOptions',
  },
  {
    pkg: 'websocket-plugin',
    key: 'websocket',
    symbol: 'WebSocketPlugin',
    type: 'RealtimeDiagnosticsOptions',
    typePackage: 'common',
  },
  {
    pkg: 'sse-plugin',
    key: 'sse',
    symbol: 'SsePlugin',
    type: 'RealtimeDiagnosticsOptions',
    typePackage: 'common',
  },
  {
    pkg: 'realtime-backplane-plugin',
    key: 'backplane',
    symbol: 'RealtimeBackplanePlugin',
    type: 'RealtimeDiagnosticsOptions',
    typePackage: 'common',
  },
  { pkg: 'events-plugin', key: 'events', symbol: 'EventsPlugin', type: 'EventsDiagnosticsOptions' },
  {
    pkg: 'scheduler-plugin',
    key: 'scheduler',
    symbol: 'SchedulerPlugin',
    type: 'SchedulerDiagnosticsOptions',
  },
  { pkg: 'queue-plugin', key: 'queue', symbol: 'QueuePlugin', type: 'QueueDiagnosticsOptions' },
  { pkg: 'health-plugin', key: 'health', symbol: 'HealthPlugin', type: 'HealthDiagnosticsOptions' },
  { pkg: 'config-plugin', key: 'config', symbol: 'ConfigPlugin', type: 'ConfigDiagnosticsOptions' },
  {
    pkg: 'telemetry-plugin',
    key: 'telemetry',
    symbol: 'TelemetryPlugin',
    type: 'TraceDiagnosticsOptions',
  },
  {
    pkg: 'auth-plugin',
    key: 'auth',
    symbol: 'AuthPlugin',
    type: 'AuthorizationDiagnosticsOptions',
  },
];

/**
 * Masks comments and literals, preserving positions and line breaks.
 *
 * Classifies only a restricted language in which this hand-written lexer is EXACT:
 * plain `'…'`/`"…"` strings with no escape, no template literal, no backslash in
 * code, and no regex literal or division. In that language a string cannot contain
 * its own quote and nothing nests, so every comment and string is found exactly.
 * Anything else is unclassified (`undefined`) and receives manual guidance rather
 * than an automatic edit. Narrower recognizers were bypassed four audit rounds in
 * a row by escapes, nested template substitutions and Unicode-escaped identifiers;
 * refusing the constructs is what makes the checks built on this mask sound.
 * CLI-generated configurations use none of them outside comments.
 * @param source - Developer-owned configuration text
 * @returns Code-only text, or undefined for unclassified source
 */
export function maskSourceCode(source: string): string | undefined {
  return maskSource(source, true);
}

/**
 * Masks comments only, keeping string literals verbatim. Same classification as
 * {@linkcode maskSourceCode}: undefined exactly when that is. A binding name inside
 * a string is visible here and not there, which is how the checks that must not
 * miss a use detect one.
 * @param source - Developer-owned configuration text
 * @returns Text with comments blanked, or undefined for unclassified source
 */
export function maskComments(source: string): string | undefined {
  return maskSource(source, false);
}

/** Line terminators as JavaScript defines them; each ends a `//` comment. */
function isLineTerminator(c: string): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

/** Code outside comments and strings is printable ASCII and plain whitespace. */
function isCodeChar(c: string): boolean {
  return (c >= ' ' && c <= '~') || c === '\t' || c === '\n' || c === '\r';
}

/**
 * Identifiers whose presence in code takes the configuration out of what a lexer
 * can decide: reflection, prototype mutation and global object access can change
 * what an options object holds without the text saying so (audit round 5).
 */
const UNDECIDABLE_IDENTIFIERS: ReadonlySet<string> = new Set([
  'Object',
  'Reflect',
  'Proxy',
  'constructor',
  'prototype',
  '__proto__',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'globalThis',
  'self',
  'window',
  'eval',
  'Function',
  'require',
]);

/**
 * Every package the framework publishes. A `@setu-ts/` name outside this list is
 * an import-map alias that can point anywhere (audit round 6), so it is no more
 * recognizable than any other bare specifier. A drift test pins it to the
 * workspace members.
 */
export const FRAMEWORK_PACKAGES: ReadonlySet<string> = new Set([
  'audit-plugin',
  'auth-plugin',
  'cache-plugin',
  'cli',
  'cloudflare-plugin',
  'common',
  'config-plugin',
  'cqrs-plugin',
  'database-plugin',
  'decorator-plugin',
  'di-plugin',
  'diagnostics-plugin',
  'events-plugin',
  'exceptions',
  'feature-flags-plugin',
  'full-stack-starter',
  'graphql-plugin',
  'grpc-plugin',
  'health-plugin',
  'http-security-plugin',
  'kernel',
  'localization-plugin',
  'logger-plugin',
  'mail-plugin',
  'messaging-plugin',
  'metrics-plugin',
  'microservice-starter',
  'multi-tenancy-plugin',
  'notification-plugin',
  'openapi-plugin',
  'queue-plugin',
  'react-router-plugin',
  'realtime-backplane-plugin',
  'resilience-plugin',
  'rest-starter',
  'runtime',
  'scheduler-plugin',
  'sdk',
  'secrets-plugin',
  'service-discovery-plugin',
  'session-plugin',
  'sse-plugin',
  'static-plugin',
  'storage-plugin',
  'telemetry-plugin',
  'testing',
  'validation-plugin',
  'view-plugin',
  'websocket-plugin',
  'worker-pool-plugin',
]);

/**
 * Whether a static module specifier names something whose contents the CLI can
 * reason about: a known framework package (optionally with a subpath) or a
 * relative file. A bare specifier — including an unknown `@setu-ts/` name — can be
 * remapped by an import map to anything (audit rounds 5 and 6).
 */
function isRecognizedSpecifier(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  if (!specifier.startsWith('@setu-ts/')) return false;
  const rest = specifier.slice('@setu-ts/'.length);
  const slash = rest.indexOf('/');
  return FRAMEWORK_PACKAGES.has(slash < 0 ? rest : rest.slice(0, slash));
}

/**
 * Whether a manifest maps a `@setu-ts/` import key to something other than that
 * same framework package — an unknown name, or a known name pointed at a different
 * package. Either makes the configuration's imports mean something its text does
 * not say, so automatic edits are withheld (audit round 6). A value naming the
 * package as `jsr:@setu-ts/<pkg>`, its npm-compatibility name `setu-ts__<pkg>`, or
 * a path through a `<pkg>/` directory (a workspace checkout) is the same package.
 *
 * @param manifest - Raw `deno.json` or `package.json` text
 * @returns Whether any framework import is retargeted
 */
export function importMapRetargets(manifest: string): boolean {
  for (const entry of manifest.matchAll(/"@setu-ts\/([^"]*)"[ \t\r\n]*:[ \t\r\n]*"([^"]*)"/g)) {
    const key = entry[1]!.replace(/\/$/, '');
    const value = entry[2]!;
    if (!FRAMEWORK_PACKAGES.has(key)) return true;
    const same = value === `jsr:@setu-ts/${key}` || value.includes(`@setu-ts/${key}@`) ||
      value.includes(`@setu-ts/${key}/`) || value.includes(`setu-ts__${key}@`) ||
      value.includes(`/${key}/`);
    if (!same) return true;
  }
  return false;
}

/** Words before which `[` opens an array literal rather than indexing a value. */
const LITERAL_BRACKET_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'of',
  'in',
  'typeof',
  'case',
  'await',
  'yield',
  'else',
  'do',
  'void',
  'delete',
  'throw',
  'readonly',
  'satisfies',
  'as',
]);

/**
 * Whether masked code indexes a value with `[…]`. A computed member access reaches
 * a property no identifier names — `x['constructor']['prototype']` — so it is as
 * undecidable as the identifiers it spells (audit round 6). An array literal, and
 * a `T[]` type (an empty bracket pair), are not member access.
 */
function indexesValue(code: string, kept: string): boolean {
  let previous = -1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '[' && previous >= 0) {
      // The bracket's contents are read with string literals KEPT: in the code
      // mask `['constructor']` is blank and would pass for a `T[]` type.
      let next = i + 1;
      while (next < kept.length && /\s/.test(kept[next]!)) next += 1;
      const empty = kept[next] === ']';
      const before = code[previous]!;
      if (!empty && (before === ')' || before === ']' || before === '.')) return true;
      if (!empty && isIdentifierChar(before)) {
        let start = previous;
        while (start > 0 && isIdentifierChar(code[start - 1]!)) start -= 1;
        if (!LITERAL_BRACKET_KEYWORDS.has(code.slice(start, previous + 1))) return true;
      }
    }
    if (!/\s/.test(c)) previous = i;
  }
  return false;
}

/**
 * Parses one named-import item — `Name` or `Name as alias` — in a single linear
 * pass. `type Name` items and anything else return undefined. Replaces a
 * `split(/\s+as\s+/)` that backtracked quadratically on a long run of spaces
 * (audit round 6, R-R6).
 *
 * @param item - One comma-separated entry from an import's braces
 * @returns The imported symbol and its local binding, or undefined
 */
export function parseImportItem(
  item: string,
): { readonly symbol: string; readonly local: string } | undefined {
  const tokens = item.split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 1) return { symbol: tokens[0]!, local: tokens[0]! };
  if (tokens.length === 3 && tokens[1] === 'as') return { symbol: tokens[0]!, local: tokens[2]! };
  return undefined;
}

/**
 * The one masking state machine; `blankLiterals` selects which mask it emits.
 *
 * Returns undefined — unclassified — for anything outside the restricted language
 * in which this lexer is exact and the configuration's meaning is decidable from
 * its text: a template literal, an escape, a backslash, `#` (hashbang, private
 * names), an HTML-like comment, a regex literal or division, a raw line terminator
 * in a string, non-ASCII code, a dynamic `import(…)`, a static import of anything
 * but a framework package or a relative file, or an identifier in
 * {@linkcode UNDECIDABLE_IDENTIFIERS}. Comments may contain anything; a `//`
 * comment ends at every JavaScript line terminator, U+2028 and U+2029 included.
 */
function maskSource(source: string, blankLiterals: boolean): string | undefined {
  let mode: 'code' | 'line' | 'block' | "'" | '"' = 'code';
  const code: string[] = [];
  const comments: string[] = [];
  const blank = (c: string) => c === '\n' || c === '\r' ? c : ' ';
  const push = (masked: string, kept: string) => {
    code.push(masked);
    comments.push(kept);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && (next === '/' || next === '*')) {
        mode = next === '/' ? 'line' : 'block';
        push('  ', '  ');
        i++;
      } else if (
        c === '/' || c === '`' || c === '\\' || c === '#' ||
        source.startsWith('<!--', i) || source.startsWith('-->', i) || !isCodeChar(c)
      ) {
        return undefined;
      } else if (c === "'" || c === '"') {
        mode = c;
        push(' ', c);
      } else push(c, c);
    } else if (mode === 'line') {
      if (isLineTerminator(c)) {
        mode = 'code';
        // U+2028/U+2029 end the comment like a newline; keep offsets one-for-one.
        push(blank(c), blank(c));
      } else push(' ', ' ');
    } else if (mode === 'block') {
      if (c === '*' && next === '/') {
        push('  ', '  ');
        i++;
        mode = 'code';
      } else push(blank(c), blank(c));
    } else {
      if (c === '\\' || isLineTerminator(c)) return undefined;
      push(' ', c);
      if (c === mode) mode = 'code';
    }
  }
  if (mode !== 'code' && mode !== 'line') return undefined;
  const masked = code.join('');
  for (const word of masked.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (UNDECIDABLE_IDENTIFIERS.has(word[0])) return undefined;
  }
  // Specifiers are read from the comment-only mask: comments there are spaces (so
  // `from /* c */ 'x'` is seen) while string quotes survive — in the code mask the
  // literal itself is blank and a whitespace skip would run straight through it.
  const kept = comments.join('');
  if (indexesValue(masked, kept)) return undefined;
  for (const keyword of masked.matchAll(/\b(?:import|from)\b/g)) {
    let at = keyword.index + keyword[0].length;
    while (kept[at] === ' ' || kept[at] === '\t' || kept[at] === '\n' || kept[at] === '\r') at += 1;
    if (keyword[0] === 'import' && kept[at] === '(') return undefined;
    const quote = kept[at];
    if (quote !== "'" && quote !== '"') continue;
    const close = kept.indexOf(quote, at + 1);
    if (!isRecognizedSpecifier(kept.slice(at + 1, close))) return undefined;
  }
  return blankLiterals ? masked : kept;
}

/** Returns the executable body of the recognized synchronous createApp factory. */
export function factoryScope(source: string): {
  readonly code: string;
  readonly header: number;
  readonly start: number;
  readonly end: number;
} | undefined {
  const code = maskSourceCode(source);
  if (code === undefined) return undefined;
  const header = /^export function createApp\s*\(/m.exec(code);
  if (header === null) return undefined;
  let cursor = header.index + header[0].length;
  let depth = 1;
  for (; cursor < code.length && depth > 0; cursor++) {
    if (code[cursor] === '(') depth++;
    if (code[cursor] === ')') depth--;
  }
  if (depth !== 0) return undefined;
  // Hand-scanned, not a regex: two `\s*` around an optional group backtracked
  // quadratically on a long run of spaces (audit round 5, R-R5).
  const skipSpace = (at: number) => {
    while (at < code.length && /\s/.test(code[at]!)) at += 1;
    return at;
  };
  let open = skipSpace(cursor);
  for (const annotation of [': IKernelApplication', ': IApplication']) {
    if (code.startsWith(annotation, open)) {
      open = skipSpace(open + annotation.length);
      break;
    }
  }
  if (code[open] !== '{') return undefined;
  const start = open + 1;
  depth = 1;
  for (cursor = start; cursor < code.length; cursor++) {
    if (code[cursor] === '{') depth++;
    if (code[cursor] === '}' && --depth === 0) {
      return { code, header: header.index, start, end: cursor };
    }
  }
  return undefined;
}

/** Longest import clause the scanner follows before treating text as non-import. */
const MAX_IMPORT_CLAUSE = 4096;

/** Whitespace the import scanner skips; a newline outside braces ends the attempt. */
function isBlank(c: string): boolean {
  return c === ' ' || c === '\t';
}

/** Identifier characters, checked without a regex per character. */
function isIdentifierChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '_' || c === '$';
}

/**
 * Scans the import clause starting after the `import` keyword: optional `type`, a
 * default binding, `,`, `{ … }` or `* as name`, up to the `from` keyword, refusing
 * any other character — and a newline outside braces, which deno fmt never emits
 * inside a clause. Returns the end of the clause, or -1, and in both cases the
 * index scanning stopped at, so the caller never rescans that text: one linear
 * pass over the file. Refusing means "not an import", which leaves the text
 * visible to the use checks — the fail-closed direction.
 */
function importClauseEnd(
  code: string,
  start: number,
): { readonly end: number; readonly stop: number } {
  const limit = Math.min(code.length, start + MAX_IMPORT_CLAUSE);
  let i = start;
  let tokens = 0;
  while (i < limit) {
    const c = code[i]!;
    if (isBlank(c)) {
      i += 1;
    } else if (c === ',' || c === '*') {
      i += 1;
      tokens += 1;
    } else if (c === '{') {
      const close = code.indexOf('}', i);
      if (close < 0 || close >= limit) return { end: -1, stop: limit };
      i = close + 1;
      tokens += 1;
    } else if (isIdentifierChar(c) && !(c >= '0' && c <= '9')) {
      let end = i + 1;
      while (end < limit && isIdentifierChar(code[end]!)) end += 1;
      if (code.slice(i, end) === 'from' && tokens > 0) return { end, stop: end };
      i = end;
      tokens += 1;
    } else {
      return { end: -1, stop: i };
    }
  }
  return { end: -1, stop: i };
}

/**
 * Blanks every static import declaration in masked text, preserving offsets, so a
 * reference search sees uses of a binding and never its own import. Each line
 * starting with the `import` keyword (not `import(`) is scanned by
 * {@linkcode importClauseEnd}; only a well-formed clause up to `from` is blanked.
 * Text a scan has already passed is never scanned again.
 *
 * @param code - Masked source from {@linkcode maskSourceCode} or {@linkcode maskComments}
 * @returns The same text with import clauses replaced by spaces
 */
export function maskImportDeclarations(code: string): string {
  const out = code.split('');
  let resume = 0;
  for (let line = 0; line < code.length; line = code.indexOf('\n', line) + 1 || code.length) {
    if (line < resume) continue;
    let i = line;
    while (isBlank(code[i] ?? '')) i += 1;
    const after = code[i + 6] ?? '';
    if (!code.startsWith('import', i) || isIdentifierChar(after) || after === '(') continue;
    const scan = importClauseEnd(code, i + 6);
    resume = scan.stop;
    if (scan.end < 0) continue;
    for (let k = i; k < scan.end; k++) if (out[k] !== '\n') out[k] = ' ';
  }
  return out.join('');
}

/**
 * How many times a framework package is named, as `@setu-ts/<pkg>` (with any
 * `jsr:`/`npm:` prefix, version or subpath) or as its npm-compatibility name
 * `setu-ts__<pkg>`, in comment-masked text. A check that trusts one recognized
 * import requires exactly one: a second import form could otherwise use the
 * package unseen (audit rounds 3 and 4). A longer package name (`<pkg>-x`) is not
 * counted.
 *
 * @param text - Configuration text with comments masked
 * @param pkg - Bare package name, e.g. `cache-plugin`
 * @returns The occurrence count
 */
export function packageSpecifierCount(text: string, pkg: string): number {
  let count = 0;
  for (const name of [`@setu-ts/${pkg}`, `setu-ts__${pkg}`]) {
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const next = text[at + name.length] ?? '';
      if (!isIdentifierChar(next) && next !== '-') count += 1;
    }
  }
  return count;
}

/**
 * Whether masked code refers to `name` as an identifier — called, aliased, passed,
 * spread or exported — anywhere other than as a member (`x.name`) or inside a longer
 * identifier (`RedisName`). Any such reference means the binding is already used.
 *
 * @param code - Masked source
 * @param name - An identifier
 * @returns Whether a reference exists
 */
export function referencesIdentifier(code: string, name: string): boolean {
  return identifierPattern(name).test(code);
}

/**
 * Whether masked code CALLS `name` directly (`name(`) — the precise "registered"
 * signal that suppresses registration guidance. Deliberately narrower than
 * {@linkcode referencesIdentifier}: refusing an automatic edit on any possible use
 * fails closed, while guidance fails open, so a refused edit is never also a
 * silent one (audit round 4).
 *
 * @param code - Masked source
 * @param name - An identifier
 * @returns Whether a direct call exists
 */
export function callsIdentifier(code: string, name: string): boolean {
  for (const reference of code.matchAll(identifierPattern(name, 'g'))) {
    let at = reference.index + name.length;
    while (isBlank(code[at] ?? '') || code[at] === '\n') at += 1;
    const close = matchingClose(code, at, '(');
    if (close < 0) continue;
    // A method, function or signature DECLARATION shares the shape `name(…)`;
    // what follows its parentheses — a body, a return type or an arrow — is what
    // tells it from a call (audit round 6, G-R6).
    let after = close + 1;
    while (isBlank(code[after] ?? '') || code[after] === '\n') after += 1;
    if (code[after] === '{' || code[after] === ':' || code.startsWith('=>', after)) continue;
    let before = reference.index;
    while (before > 0 && (isBlank(code[before - 1]!) || code[before - 1] === '\n')) before -= 1;
    if (code.slice(Math.max(0, before - 8), before).endsWith('function')) continue;
    return true;
  }
  return false;
}

/** The reference pattern shared by every use check, global for counting. */
function identifierPattern(name: string, flags = ''): RegExp {
  const escaped = name.replace(/[$]/g, '\\$&');
  return new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${escaped}(?![\\w$])`, flags);
}

/** Index of the bracket closing the one at `open`, counted over masked code. */
function matchingClose(code: string, open: number, opener: '(' | '{'): number {
  // The opener is required, not inferred: this is the one place that enforces "a
  // backplane reference must be a call" (and "an argument must be an object"), so
  // a reference followed by anything else is refused here and nowhere else.
  if (code[open] !== opener) return -1;
  const pairs: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c in pairs) stack.push(pairs[c]!);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Whether one backplane call argument is confirmed to select a supported
 * transport: empty, or a single plain object literal with no spread, computed key,
 * escape or template literal, naming `transport` at most once — as a bare key whose
 * value is exactly one plain quoted literal other than `custom`.
 */
function supportedBackplaneArgument(raw: string, masked: string): boolean {
  // Emptiness is judged on the RAW text: masking blanks a string argument to
  // spaces, so `('memory')` would otherwise read as no argument at all.
  if (raw.trim() === '') return true;
  const own = withoutSourceSpread(raw);
  if (own !== undefined) {
    return supportedBackplaneArgument(
      raw.slice(own.start, own.end),
      masked.slice(own.start, own.end),
    );
  }
  const trimmed = masked.trim();
  const open = masked.indexOf('{');
  if (
    !trimmed.startsWith('{') || matchingClose(masked, open, '{') !== masked.trimEnd().length - 1
  ) {
    return false;
  }
  // `__proto__` in an object literal sets the PROTOTYPE, which can carry a custom
  // transport without the literal naming one (audit round 3).
  if (/\\|\.\.\.|\[|`|__proto__/.test(raw)) return false;
  const mentions = raw.match(/transport/g)?.length ?? 0;
  if (mentions === 0) return true;
  if (mentions > 1) return false;
  const key = /(?:^|[{,])\s*transport\s*:/.exec(masked);
  if (key === null) return false;
  let at = key.index + key[0].length;
  while (/\s/.test(raw[at] ?? '')) at += 1;
  const quote = raw[at];
  if (quote !== "'" && quote !== '"') return false;
  const close = raw.indexOf(quote, at + 1);
  if (close < 0 || raw.slice(at + 1, close) === 'custom') return false;
  let after = close + 1;
  while (/\s/.test(raw[after] ?? '')) after += 1;
  return raw[after] === ',' || raw[after] === '}';
}

/**
 * Recognizes the argument shapes {@linkcode withSourceArgs} itself emits for the
 * backplane — `{ ...sources.backplane }` and `{ ...<original>, ...sources.backplane }` —
 * and returns the span of the original argument (empty for the first). Without
 * this, the CLI refused its own rewrite on the next run and dropped the row the
 * configuration still reads (audit round 6, T-R6). Hand-scanned, no regex.
 */
function withoutSourceSpread(
  raw: string,
): { readonly start: number; readonly end: number } | undefined {
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let start = 0;
  let end = raw.length;
  while (isSpace(raw[start])) start += 1;
  while (end > start && isSpace(raw[end - 1])) end -= 1;
  if (raw[start] !== '{' || raw[end - 1] !== '}') return undefined;
  start += 1;
  end -= 1;
  while (isSpace(raw[start])) start += 1;
  while (end > start && isSpace(raw[end - 1])) end -= 1;
  const tail = '...sources.backplane';
  if (!raw.slice(start, end).endsWith(tail)) return undefined;
  end -= tail.length;
  while (end > start && isSpace(raw[end - 1])) end -= 1;
  if (end === start) return { start, end };
  if (raw[end - 1] !== ',') return undefined;
  end -= 1;
  while (end > start && isSpace(raw[end - 1])) end -= 1;
  if (!raw.startsWith('...', start)) return undefined;
  start += 3;
  while (isSpace(raw[start])) start += 1;
  return { start, end };
}

/**
 * Whether the configuration is CONFIRMED to give the realtime backplane a
 * supported transport. Fails closed: the policy is emitted only when the plugin is
 * imported through the one recognized named import, referenced at least once, and
 * every reference is a call whose argument {@linkcode supportedBackplaneArgument}
 * accepts. An alias, a spread of options built elsewhere, a second import form or
 * any shape the CLI cannot classify without evaluating the file withholds it, since
 * the custom transport accepts no diagnostics policy (plan §10). A backplane
 * constructed in another module is not visible from `setu.config.ts`, so it never
 * confirms anything.
 */
function backplaneConfirmedSupported(source: string, code: string): boolean {
  const declaration = /^import \{ ([^}\n]+) \} from '@setu-ts\/realtime-backplane-plugin';$/m
    .exec(source);
  if (
    declaration === null ||
    code.slice(declaration.index, declaration.index + 6) !== 'import' ||
    packageSpecifierCount(maskComments(source)!, 'realtime-backplane-plugin') !== 1
  ) {
    return false;
  }
  const name = declaration[1]!.split(',').map(parseImportItem)
    .find((item) => item?.symbol === 'RealtimeBackplanePlugin')?.local;
  if (name === undefined || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  const uses = maskImportDeclarations(code);
  const pattern = identifierPattern(name, 'g');
  const references = [...uses.matchAll(pattern)];
  // A use inside a string or a template substitution is blanked from `uses`; seen
  // with literals kept, it must not exist (audit round 3).
  const visible = maskImportDeclarations(maskComments(source)!);
  if ([...visible.matchAll(pattern)].length !== references.length) return false;
  let calls = 0;
  for (const reference of references) {
    let at = reference.index + name.length;
    while (/\s/.test(uses[at] ?? '')) at += 1;
    const close = matchingClose(uses, at, '(');
    if (close < 0) return false;
    if (!supportedBackplaneArgument(source.slice(at + 1, close), uses.slice(at + 1, close))) {
      return false;
    }
    calls += 1;
  }
  return calls > 0;
}

/** Reads literal policy discriminants only at code positions, never within examples. */
function policyFlags(
  source: string,
): Required<Pick<IDevtoolSourceNames, 'authorization' | 'customBackplane'>> {
  const code = maskSourceCode(source);
  return {
    authorization: code !== undefined && /\brbac\s*:/.test(code),
    customBackplane: code === undefined || !backplaneConfirmedSupported(source, code),
  };
}

/** Restrict emitted aliases to bounded, printable identifiers and stable order. */
function approved(names: readonly string[], limit: number): readonly string[] {
  return [...new Set(names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)))]
    .sort().slice(0, limit);
}

/** Names are already restricted to ASCII identifiers, so these literals need no escaping. */
function allowlist(names: readonly string[], limit: number): string {
  const entries = approved(names, limit).map((name) => `'${name}': '${name}'`);
  return entries.length === 0 ? '{}' : `{\n        ${entries.join(',\n        ')},\n      }`;
}

function sourceRows(
  installed: ReadonlySet<string>,
  names: IDevtoolSourceNames,
): readonly ISourceRow[] {
  return ROWS.filter((row) =>
    installed.has(row.pkg) &&
    (row.key !== 'auth' || names.authorization === true) &&
    (row.key !== 'backplane' || names.customBackplane !== true)
  );
}

/** Renders each installed source against its owning package's committed option type. */
export function renderDevtoolSources(
  installed: ReadonlySet<string>,
  names: IDevtoolSourceNames,
): GeneratedFile {
  const rows = sourceRows(installed, names);
  const imports = [
    ...new Set(
      rows.map((row) =>
        `import type { ${row.type} } from '@setu-ts/${row.typePackage ?? row.pkg}';`
      ),
    ),
  ];
  const artifacts = names.artifacts ?? {};
  const indicators = [
    ...[...installed].flatMap((pkg) => PLUGIN_HEALTH_INDICATORS.get(pkg) ?? []),
    ...(artifacts['health-indicator'] ?? []),
  ];
  const project = approved([names.project], 1)[0] ?? 'app';
  const policies: Readonly<Record<string, readonly string[]>> = {
    cache: ["alias: 'cache'"],
    storage: ["alias: 'storage'"],
    websocket: ["alias: 'websocket'"],
    sse: ["alias: 'sse'"],
    backplane: ["alias: 'backplane'"],
    events: ["alias: 'events'", `events: ${allowlist(artifacts['event-handler'] ?? [], 64)}`],
    scheduler: ["alias: 'scheduler'", 'jobs: {}'],
    queue: ["instanceAlias: 'queue'", `queues: ${allowlist(artifacts['job'] ?? [], 64)}`],
    health: [`indicators: ${allowlist(indicators, 64)}`],
    config: [`keys: ${allowlist(names.envKeys ?? [], 128)}`],
    telemetry: [`serviceAlias: '${project}'`, 'operations: {}'],
    auth: ['roles: {}', 'permissions: {}'],
  };
  const entries = rows.map((row) => {
    const option = row.key === 'auth' ? 'authorizationDiagnostics' : 'diagnostics';
    return `  ${row.key}: {\n    ${option}: {\n      enabled: true,\n      ${
      policies[row.key]!.join(',\n      ')
    },\n    } satisfies ${row.type},\n  },`;
  });
  return {
    path: DEVTOOL_SOURCES_MODULE,
    managed: true,
    contents: `/**
 * CLI-managed development source allowlists. Refreshed by setu add.
 * Empty jobs, operations, roles and permissions approve no observations; add
 * the exact application names to those keys when configuring those sources.
 * SDK createObservedFetch is an application helper and is configured separately.
 * Sources are enabled only when createApp receives its devtool argument.
 */${imports.length === 0 ? '' : `\n${imports.join('\n')}`}

const ROWS_SOURCES = ${entries.length === 0 ? '{}' : `{\n${entries.join('\n')}\n}`};

/** Every source key, so a row this file no longer emits still spreads to nothing. */
interface AbsentSources {
${ROWS.map((row) => `  readonly ${row.key}?: Readonly<Record<never, never>>;`).join('\n')}
}

type Sources = Omit<AbsentSources, keyof typeof ROWS_SOURCES> & typeof ROWS_SOURCES;

/** Installed plugin options consumed by the development factory. */
export const DEVTOOL_SOURCES: Sources = ROWS_SOURCES;\n`,
  };
}

/** Wraps an emitter-owned option object with the optional development policy. */
export function withSourceArgs(
  pkg: string,
  args: string,
  installed: ReadonlySet<string>,
  names: IDevtoolSourceNames,
): string {
  const row = sourceRows(installed, names).find((entry) => entry.pkg === pkg);
  return row === undefined ? args : `{ ${args === '' ? '' : `...${args}, `}...sources.${row.key} }`;
}

/** Adds policies only to recognizable emitted factory calls, preserving unfamiliar composition. */
export function withDevtoolSourceWiring(
  source: string,
  installed: ReadonlySet<string>,
  customBackplane = false,
): {
  readonly source: string;
  readonly manual: readonly string[];
} {
  const scope = factoryScope(source);
  const flags = policyFlags(source);
  const names = {
    project: 'app',
    ...flags,
    customBackplane: flags.customBackplane || customBackplane,
  };
  const rows = sourceRows(installed, names);
  if (rows.length === 0) return { source, manual: [] };
  if (
    scope === undefined ||
    !scope.code.slice(scope.header, scope.start).includes(
      'devtool?: { plugins?: readonly IPlugin[];',
    )
  ) {
    return {
      source,
      manual: rows.map((row) => `${row.symbol}({ ...options, ...sources.${row.key} })`),
    };
  }
  let updated = source;
  const manual: string[] = [];
  for (const row of rows) {
    const imported = new RegExp(`^import \\{ ([^\\n]+) \\} from '@setu-ts/${row.pkg}';`, 'm').exec(
      updated,
    );
    if (
      imported !== null &&
      maskSourceCode(updated)?.slice(imported.index, imported.index + 6) !== 'import'
    ) {
      manual.push(`${row.symbol}({ ...options, ...sources.${row.key} })`);
      continue;
    }
    const symbol = imported?.[1]?.split(',').map(parseImportItem)
      .find((item) => item?.symbol === row.symbol)?.local;
    if (symbol === undefined || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
      manual.push(`${row.symbol}({ ...options, ...sources.${row.key} })`);
      continue;
    }
    const currentScope = factoryScope(updated)!;
    const updatedCode = currentScope.code.slice(currentScope.start, currentScope.end);
    if (updatedCode.includes(`...sources.${row.key}`)) continue;
    const escapedSymbol = symbol.replaceAll('$', '\\$');
    const call = new RegExp(`^[ \\t]*${escapedSymbol}\\((\\{[^()]*?\\}|)\\),[ \\t]*$`, 'm').exec(
      updatedCode,
    );
    if (call === null) {
      manual.push(`${symbol}({ ...options, ...sources.${row.key} })`);
      continue;
    }
    const offset = call.index + currentScope.start;
    const originalCall = updated.slice(offset, offset + call[0].length);
    const start = originalCall.indexOf('(') + 1;
    const end = originalCall.lastIndexOf(')');
    const replacement = originalCall.slice(0, start) +
      withSourceArgs(row.pkg, originalCall.slice(start, end), installed, names) +
      originalCall.slice(end);
    updated = updated.slice(0, offset) + replacement +
      updated.slice(offset + call[0].length);
  }
  if (updated === source) return { source, manual };
  const sourceImport = /^import \{ DEVTOOL_SOURCES \} from '\.\/src\/devtool\/diagnostics\.ts';$/m
    .exec(updated);
  if (
    sourceImport === null ||
    maskSourceCode(updated)?.slice(sourceImport.index, sourceImport.index + 6) !== 'import'
  ) {
    updated = "import { DEVTOOL_SOURCES } from './src/devtool/diagnostics.ts';\n" + updated;
  }
  const finalScope = factoryScope(updated)!;
  if (
    !finalScope.code.slice(finalScope.start, finalScope.end).includes(
      'const sources: Partial<typeof DEVTOOL_SOURCES>',
    )
  ) {
    const offset = finalScope.start;
    updated = updated.slice(0, offset) +
      '\n  const sources: Partial<typeof DEVTOOL_SOURCES> = devtool === undefined ? {} : DEVTOOL_SOURCES;' +
      updated.slice(offset);
  }
  return { source: updated, manual };
}

/** Reads approved artifact and env names through the CLI filesystem port, without booting. */
export async function readDevtoolSourceNames(
  fs: IFileSystem,
  dir: string,
  installed: ReadonlySet<string>,
  config: string,
): Promise<IDevtoolSourceNames> {
  const scan = await scanArtifacts(fs, dir, scanSeamSpecs(installed));
  const artifacts: Record<string, readonly string[]> = { ...scan.artifacts };
  if (generatorMode(installed) === 'functional') {
    try {
      artifacts['job'] = (await fs.readdir(joinPath(dir, 'src/jobs')))
        .filter((file) => file.endsWith('.job.ts')).map((file) => file.slice(0, -'.job.ts'.length));
    } catch {
      // No functional jobs have been generated yet.
    }
  }
  let envKeys: readonly string[] = [];
  const configuredPath = /\benvFilePath:\s*'([^']+)'/.exec(config)?.[1];
  const parsedPath = readEnvFilePath(
    configuredPath === undefined ? {} : { 'env-file': configuredPath },
  );
  const envExample = parsedPath.ok ? `${parsedPath.path ?? '.env'}.example` : '.env.example';
  try {
    const env = new TextDecoder().decode(await fs.readFile(joinPath(dir, envExample)));
    envKeys = env.split(/\r?\n/).flatMap((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []);
  } catch {
    // A project without an env example approves no configuration keys.
  }
  const flags = policyFlags(config);
  let retargeted = false;
  for (const manifest of ['deno.json', 'deno.jsonc', 'package.json']) {
    try {
      retargeted ||= importMapRetargets(
        new TextDecoder().decode(await fs.readFile(joinPath(dir, manifest))),
      );
    } catch {
      // An absent manifest maps nothing.
    }
  }
  return {
    project: dir.split('/').at(-1) ?? 'app',
    artifacts,
    envKeys,
    ...flags,
    customBackplane: flags.customBackplane || retargeted,
  };
}
