/** Validated MCP options and declarations. @module */
import { McpPluginConfigurationError } from './errors.ts';
import { VERSION } from './version.ts';

/** One explicitly exposed route; annotations are derived from the route.
 * @since 0.13.0
 */
export interface McpToolDeclaration {
  /** Case-sensitive tool name (1–64 ASCII letters, digits, underscores, dots or hyphens). */
  readonly name: string;
  /** Model-facing description. */
  readonly description: string;
  /** Optional display title. */
  readonly title?: string;
  /** Exact method and registered route pattern. */
  readonly route: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly path: string;
  };
  /** Declares a POST/PATCH operation safe to repeat without idempotency middleware. */
  readonly repeatable?: true;
}

/** Options for the stateless MCP endpoint.
 * @since 0.13.0
 */
export interface McpPluginOptions {
  /** Optional explicit declarations, merged with route markers at bootstrap. */
  readonly tools?: readonly McpToolDeclaration[];
  /** Endpoint path, default `/mcp`. */
  readonly path?: string;
  /** Server identity, default `setu-mcp` and the package version. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** Instructions exposed to clients. */
  readonly instructions?: string;
  /** Permitted absolute HTTP(S) browser origins, including same-origin UIs. */
  readonly allowedOrigins?: readonly string[];
  /** Legacy client posture, default `stateless`. */
  readonly legacy?: 'stateless' | 'reject';
  /** Maximum inner response bytes: a positive integer up to 64 MiB, default 1 MiB. */
  readonly maxResultBytes?: number;
  /** Per-call deadline in milliseconds: 1–600000, default 30000. */
  readonly timeoutMs?: number;
}

/** Upper bound on `maxResultBytes` (64 MiB). */
const MAX_RESULT_BYTES_LIMIT = 64 * 1024 * 1024;

/** Internal defaults resolved once at construction. */
export type ResolvedOptions = Required<Omit<McpPluginOptions, 'instructions'>> &
  Pick<McpPluginOptions, 'instructions'>;

/** Plain record guard shared by schema and wire boundary readers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses malformed options before any routes are registered. */
export function resolveOptions(options: McpPluginOptions): ResolvedOptions {
  const fail = (message: string): never => {
    throw new McpPluginConfigurationError(message);
  };
  if (!isRecord(options)) fail('MCP options must be an object.');
  const path = options.path === undefined ? '/mcp' : options.path;
  const validPath = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.startsWith('/') &&
    !/[?#\s]/.test(value) &&
    !value.startsWith('//');
  if (!validPath(path)) fail('MCP path must be an absolute route path.');
  const declarations = options.tools === undefined ? [] : options.tools;
  if (!Array.isArray(declarations)) fail('MCP tools must be an array.');
  const names = new Set<string>();
  const tools = declarations.map((tool) => {
    const refuse = (message: string): never =>
      fail(
        isRecord(tool) && isRecord(tool.route)
          ? `${tool.route.method} ${tool.route.path}: ${message}`
          : message,
      );
    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name)
    )
      refuse('Invalid MCP tool name.');
    if (typeof tool.description !== 'string' || tool.description.trim().length === 0)
      refuse('MCP description must be non-empty.');
    if (tool.title !== undefined && typeof tool.title !== 'string') refuse('Invalid MCP title.');
    if (
      !isRecord(tool.route) ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.route.method) ||
      !validPath(tool.route.path)
    )
      refuse('Invalid MCP route.');
    if (names.has(tool.name)) refuse(`Duplicate MCP tool: ${tool.name}`);
    names.add(tool.name);
    if (tool.route.path === path) refuse('An MCP tool cannot bind to its own endpoint.');
    if (tool.repeatable !== undefined && tool.repeatable !== true)
      refuse('MCP repeatable must be true when present.');
    return Object.freeze({ ...tool, route: Object.freeze({ ...tool.route }) });
  });
  const serverInfo =
    options.serverInfo === undefined ? { name: 'setu-mcp', version: VERSION } : options.serverInfo;
  if (
    !isRecord(serverInfo) ||
    typeof serverInfo.name !== 'string' ||
    typeof serverInfo.version !== 'string'
  )
    fail('Invalid MCP serverInfo.');
  if (options.instructions !== undefined && typeof options.instructions !== 'string')
    fail('Invalid MCP instructions.');
  const legacy = options.legacy === undefined ? 'stateless' : options.legacy;
  if (legacy !== 'stateless' && legacy !== 'reject') fail('Invalid MCP legacy mode.');
  const maxResultBytes =
    options.maxResultBytes === undefined ? 1024 * 1024 : options.maxResultBytes;
  // Capped so a large value cannot quietly make the read unbounded (§8a.6).
  if (
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes <= 0 ||
    maxResultBytes > MAX_RESULT_BYTES_LIMIT
  )
    fail('Invalid MCP maxResultBytes.');
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    fail('Invalid MCP timeoutMs.');
  const allowedOrigins = options.allowedOrigins === undefined ? [] : options.allowedOrigins;
  if (!Array.isArray(allowedOrigins)) fail('Invalid MCP allowedOrigins.');
  for (const origin of allowedOrigins) {
    try {
      const url = new URL(origin);
      if (
        typeof origin !== 'string' ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin
      )
        fail('Invalid MCP origin.');
    } catch {
      fail('Invalid MCP origin.');
    }
  }
  return Object.freeze({
    tools: Object.freeze(tools),
    path,
    serverInfo: Object.freeze({ ...serverInfo }),
    legacy,
    maxResultBytes,
    timeoutMs,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });
}
