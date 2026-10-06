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
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  const result: string[] = [];
  const blank = (c: string) => c === '\n' || c === '\r' ? c : ' ';
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
        result.push(' ');
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
      result.push(blank(c));
      if (c === '\\' && next !== undefined) {
        result.push(blank(next));
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

/** Reads literal policy discriminants only at code positions, never within examples. */
function policyFlags(
  source: string,
): Required<Pick<IDevtoolSourceNames, 'authorization' | 'customBackplane'>> {
  const code = maskSourceCode(source);
  return {
    authorization: code !== undefined && /\brbac\s*:/.test(code),
    customBackplane: code === undefined ||
      [...source.matchAll(/\btransport\s*:\s*(['"])custom\1/g)].some((match) =>
        code.slice(match.index, match.index + 'transport'.length) === 'transport'
      ),
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
