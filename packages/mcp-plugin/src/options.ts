/** Validated MCP options and declarations. @module */
import { McpPluginConfigurationError } from './errors.ts';
import { VERSION } from './version.ts';

/** One explicitly exposed route; annotations are derived from the route.
 * @since 0.13.0
 */
export interface McpToolDeclaration {
  /** Case-sensitive tool name (1–128 ASCII letters, digits, underscores, dots or hyphens). */
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
  /** Non-empty, explicit tool declarations. */
  readonly tools: readonly McpToolDeclaration[];
  /** Endpoint path, default `/mcp`. */
  readonly path?: string;
  /** Server identity, default `setu-mcp` and the package version. */
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** Instructions exposed to clients. */
  readonly instructions?: string;
  /** Extra permitted absolute HTTP(S) origins. */
  readonly allowedOrigins?: readonly string[];
  /** Legacy client posture, default `stateless`. */
  readonly legacy?: 'stateless' | 'reject';
  /** Maximum inner response bytes, default 1 MiB. */
  readonly maxResultBytes?: number;
}

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
  if (!Array.isArray(options.tools) || options.tools.length === 0)
    fail('MCP tools must be non-empty.');
  const names = new Set<string>();
  const tools = options.tools.map((tool) => {
    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)
    )
      fail('Invalid MCP tool name.');
    if (names.has(tool.name)) fail(`Duplicate MCP tool: ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.trim().length === 0)
      fail('MCP description must be non-empty.');
    if (tool.title !== undefined && typeof tool.title !== 'string') fail('Invalid MCP title.');
    if (
      !isRecord(tool.route) ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.route.method) ||
      !validPath(tool.route.path)
    )
      fail('Invalid MCP route.');
    if (tool.route.path === path) fail('An MCP tool cannot bind to its own endpoint.');
    if (tool.repeatable !== undefined && tool.repeatable !== true)
      fail('MCP repeatable must be true when present.');
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
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
    fail('Invalid MCP maxResultBytes.');
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
    allowedOrigins: Object.freeze([...allowedOrigins]),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });
}
