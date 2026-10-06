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
 * Incomplete comments/literals and slash expressions remain unclassified.
 * Distinguishing division from a regex requires syntax parsing; emitted factory
 * shapes use neither, so unfamiliar expressions receive manual guidance.
 * @param source - Developer-owned configuration text
 * @returns Code-only text, or undefined for an incomplete literal/comment
 */
export function maskSourceCode(source: string): string | undefined {
  return maskSource(source, true);
}

/**
 * Masks comments only, keeping string and template literals — including code
 * inside a `${…}` substitution — verbatim. Same classification as
 * {@linkcode maskSourceCode}: undefined exactly when that is. A use of a binding
 * hidden inside a literal is visible here and not there, which is how the checks
 * that must not miss a use (plan §10, audit round 3) detect one.
 * @param source - Developer-owned configuration text
 * @returns Text with comments blanked, or undefined for unclassified source
 */
export function maskComments(source: string): string | undefined {
  return maskSource(source, false);
}

/** The one masking state machine; `blankLiterals` selects which mask it emits. */
function maskSource(source: string, blankLiterals: boolean): string | undefined {
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  const result: string[] = [];
  const blank = (c: string) => c === '\n' || c === '\r' ? c : ' ';
  const literal = (c: string) => blankLiterals ? blank(c) : c;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && (next === '/' || next === '*')) {
        mode = next === '/' ? 'line' : 'block';
        result.push('  ');
        i++;
      } else if (c === '/') {
        return undefined;
      } else if (c === "'" || c === '"' || c === '`') {
        mode = c;
        result.push(literal(c));
      } else result.push(c);
    } else if (mode === 'line') {
      result.push(blank(c));
      if (c === '\n' || c === '\r') mode = 'code';
    } else if (mode === 'block') {
      if (c === '*' && next === '/') {
        result.push('  ');
        i++;
        mode = 'code';
      } else result.push(blank(c));
    } else {
      result.push(literal(c));
      if (c === '\\' && next !== undefined) {
        result.push(literal(next));
        i++;
      } else if (c === mode) mode = 'code';
    }
  }
  return mode === 'code' || mode === 'line' ? result.join('') : undefined;
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
  const opening = /^\s*(?:: I(?:Kernel)?Application)?\s*\{/.exec(code.slice(cursor));
  if (depth !== 0 || opening === null) return undefined;
  const start = cursor + opening[0].length;
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

/**
 * End of the import clause starting after the `import` keyword at `from`, or -1.
 * Follows the clause grammar — optional `type`, a default binding, `,`, `{ … }` or
 * `* as name` — up to the `from` keyword, refusing any other character. Linear and
 * bounded: a regex here backtracked cubically on long runs of whitespace (audit
 * round 3, N1). Refusing means "not an import", which leaves the text visible to
 * the use checks — the fail-closed direction.
 */
function importClauseEnd(code: string, start: number): number {
  const limit = Math.min(code.length, start + MAX_IMPORT_CLAUSE);
  let i = start;
  let tokens = 0;
  while (i < limit) {
    const c = code[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === ',' || c === '*') {
      i += 1;
      tokens += 1;
    } else if (c === '{') {
      const close = code.indexOf('}', i);
      if (close < 0 || close >= limit) return -1;
      i = close + 1;
      tokens += 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let end = i + 1;
      while (end < limit && /[\w$]/.test(code[end]!)) end += 1;
      if (code.slice(i, end) === 'from' && tokens > 0) return end;
      i = end;
      tokens += 1;
    } else {
      return -1;
    }
  }
  return -1;
}

/**
 * Blanks every static import declaration in masked text, preserving offsets, so a
 * reference search sees uses of a binding and never its own import. Each line
 * starting with the `import` keyword (not `import(`) is scanned by
 * {@linkcode importClauseEnd}; only a well-formed clause up to `from` is blanked.
 *
 * @param code - Masked source from {@linkcode maskSourceCode} or {@linkcode maskComments}
 * @returns The same text with import clauses replaced by spaces
 */
export function maskImportDeclarations(code: string): string {
  const out = code.split('');
  for (let line = 0; line < code.length; line = code.indexOf('\n', line) + 1 || code.length) {
    let i = line;
    while (code[i] === ' ' || code[i] === '\t') i += 1;
    if (!code.startsWith('import', i) || /[\w$(]/.test(code[i + 6] ?? '')) continue;
    const end = importClauseEnd(code, i + 6);
    if (end < 0) continue;
    for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
  }
  return out.join('');
}

/**
 * How many times a framework package is named as a module specifier, in any quote
 * style. A check that trusts one recognized import requires this to be exactly one:
 * a second import form (`import * as ns`, double quotes) could otherwise use the
 * package unseen (audit round 3).
 *
 * @param source - Raw configuration text
 * @param pkg - Bare package name, e.g. `cache-plugin`
 * @returns The occurrence count
 */
export function packageSpecifierCount(source: string, pkg: string): number {
  const specifier = `@setu-ts/${pkg}`;
  let count = 0;
  for (let at = source.indexOf(specifier); at >= 0; at = source.indexOf(specifier, at + 1)) {
    if (/['"`]/.test(source[at - 1] ?? '') && /['"`]/.test(source[at + specifier.length] ?? '')) {
      count += 1;
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

/** The reference pattern shared by every use check, global for counting. */
function identifierPattern(name: string, flags = ''): RegExp {
  const escaped = name.replace(/[$]/g, '\\$&');
  return new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${escaped}(?![\\w$])`, flags);
}

/** Index of the bracket closing the one at `open`, counted over masked code. */
function matchingClose(code: string, open: number): number {
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
  const trimmed = masked.trim();
  const open = masked.indexOf('{');
  if (!trimmed.startsWith('{') || matchingClose(masked, open) !== masked.trimEnd().length - 1) {
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
    packageSpecifierCount(source, 'realtime-backplane-plugin') !== 1
  ) {
    return false;
  }
  const binding = declaration[1]!.split(',').map((item) => item.trim().split(/\s+as\s+/))
    .find(([symbol]) => symbol === 'RealtimeBackplanePlugin');
  const name = binding?.[1] ?? binding?.[0];
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
    if (uses[at] !== '(') return false;
    const close = matchingClose(uses, at);
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

/** Installed plugin options consumed by the development factory. */
export const DEVTOOL_SOURCES = ${entries.length === 0 ? '{}' : `{\n${entries.join('\n')}\n}`};\n`,
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
export function withDevtoolSourceWiring(source: string, installed: ReadonlySet<string>): {
  readonly source: string;
  readonly manual: readonly string[];
} {
  const scope = factoryScope(source);
  const names = {
    project: 'app',
    ...policyFlags(source),
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
    const binding = imported?.[1]?.split(',').map((item) => item.trim().split(/\s+as\s+/))
      .find(([symbol]) => symbol === row.symbol);
    const symbol = binding?.[1] ?? binding?.[0];
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
  return {
    project: dir.split('/').at(-1) ?? 'app',
    artifacts,
    envKeys,
    ...policyFlags(config),
  };
}
