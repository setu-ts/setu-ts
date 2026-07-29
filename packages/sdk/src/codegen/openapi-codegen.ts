/**
 * Pure OpenAPI 3.1 to TypeScript client source generator.
 *
 * `generateOpenApiClient` accepts an `SdkOpenApiDocument` and returns a
 * deterministic TypeScript source string with zero I/O.
 *
 * @module
 * @since 0.1.0
 */

import { OpenApiCodegenError } from '../errors.ts';
import type {
  SdkOpenApiDocument,
  SdkOpenApiOperation,
  SdkOpenApiParameter,
  SdkOpenApiRequestBody,
  SdkOpenApiSchema,
} from './openapi-types.ts';

/** Options for `generateOpenApiClient`. */
export interface OpenApiCodegenOptions {
  /** Name of the exported factory function. Defaults to `'createApi'`. */
  readonly factoryName?: string;
  /** Import specifier for SDK types. Defaults to `'@hono-enterprise/sdk'`. */
  readonly sdkImport?: string;
}

interface ResolvedOptions {
  readonly factoryName: string;
  readonly sdkImport: string;
}

function resolveOptions(options?: OpenApiCodegenOptions): ResolvedOptions {
  return {
    factoryName: options?.factoryName ?? 'createApi',
    sdkImport: options?.sdkImport ?? '@hono-enterprise/sdk',
  };
}

const RESERVED = new Set([
  'abstract',
  'arguments',
  'as',
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'native',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'sync',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'volatile',
  'while',
  'with',
  'yield',
]);

/** Derive a safe lower-camelCase TypeScript identifier. */
export function sanitizeIdentifier(raw: string): string {
  const cleaned = raw.replace(/^.*\//, '');
  const parts = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts
    .map((part, i) =>
      i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join('');
  let result = joined.replace(/^[0-9]+/, (digits) => `n${digits}`);
  if (RESERVED.has(result)) result = `_${result}`;
  return result || 'operation';
}

function escapeSingleQuote(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${escapeSingleQuote(value)}'`;
  return 'unknown';
}

function renderSchema(
  schema: SdkOpenApiSchema | undefined,
  seen: Set<SdkOpenApiSchema> = new Set(),
  path?: string,
  method?: string,
): string {
  if (!schema) return 'unknown';
  if (seen.has(schema)) return 'unknown';
  const next = new Set(seen);
  next.add(schema);

  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (!name) throw new OpenApiCodegenError(`Invalid $ref: ${schema.$ref}`, path, method);
    return sanitizeIdentifier(name);
  }
  if (schema.enum) return schema.enum.map(renderLiteral).join(' | ') || 'unknown';
  if (schema.const !== undefined) return renderLiteral(schema.const);
  if (schema.anyOf) {
    return schema.anyOf.map((s) => renderSchema(s, next, path, method)).join(' | ') || 'unknown';
  }
  if (schema.oneOf) {
    return schema.oneOf.map((s) => renderSchema(s, next, path, method)).join(' | ') || 'unknown';
  }
  if (schema.allOf) {
    return schema.allOf.map((s) => renderSchema(s, next, path, method)).join(' & ') || 'unknown';
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 1) {
    return types.filter(Boolean).map((t) => rtp(t!, schema, next, path, method)).join(' | ');
  }
  return types[0] ? rtp(types[0], schema, next, path, method) : 'unknown';
}

function rtp(
  type: string,
  schema: SdkOpenApiSchema,
  seen: Set<SdkOpenApiSchema>,
  path?: string,
  method?: string,
): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return schema.items ? `${renderSchema(schema.items, seen, path, method)}[]` : 'unknown[]';
    case 'object':
      return ros(schema, seen, path, method);
    default:
      return 'unknown';
  }
}

function ros(
  schema: SdkOpenApiSchema,
  seen: Set<SdkOpenApiSchema>,
  path?: string,
  method?: string,
): string {
  if (schema.properties) {
    const req = new Set(schema.required ?? []);
    const propLines: string[] = [];
    for (const [key, val] of Object.entries(schema.properties)) {
      const opt = req.has(key) ? '' : '?';
      propLines.push(
        `    '${escapeSingleQuote(key)}'${opt}: ${renderSchema(val, seen, path, method)};`,
      );
    }
    const body = propLines.join('\n');
    if (schema.additionalProperties !== undefined) {
      if (typeof schema.additionalProperties === 'boolean') {
        if (schema.additionalProperties) return `{\n${body}\n} & Record<string, unknown>`;
        return `{\n${body}\n}`;
      }
      const ap = renderSchema(schema.additionalProperties, seen, path, method);
      return `{\n${body}\n} & Record<string, ${ap}>`;
    }
    return `{\n${body}\n}`;
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties === 'boolean') {
      return schema.additionalProperties ? 'Record<string, unknown>' : '{}';
    }
    return `Record<string, ${renderSchema(schema.additionalProperties, seen, path, method)}>`;
  }
  return 'Record<string, unknown>';
}

interface OpEntry {
  readonly path: string;
  readonly method: string;
  readonly operation: SdkOpenApiOperation;
  readonly operationId: string;
  readonly safeName: string;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

function collectOperations(doc: SdkOpenApiDocument): OpEntry[] {
  const entries: OpEntry[] = [];
  const used = new Map<string, { orig: string; path: string; method: string }>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, SdkOpenApiOperation | undefined>)[method];
      if (!op) continue;
      if (!op.operationId) {
        throw new OpenApiCodegenError(
          `Missing operationId for ${method.toUpperCase()} ${path}`,
          path,
          method,
        );
      }
      const safeName = sanitizeIdentifier(op.operationId);
      const existing = used.get(safeName);
      if (existing) {
        throw new OpenApiCodegenError(
          `Duplicate operation name '${safeName}': ${existing.orig} (${existing.method} ${existing.path}) and ${op.operationId} (${method} ${path})`,
          path,
          method,
        );
      }
      used.set(safeName, { orig: op.operationId, path, method });
      entries.push({ path, method, operation: op, operationId: op.operationId, safeName });
    }
  }
  return entries;
}

function splitParams(
  op: SdkOpenApiOperation,
  path: string,
  method: string,
): {
  pathParams: SdkOpenApiParameter[];
  queryParams: SdkOpenApiParameter[];
  headerParams: SdkOpenApiParameter[];
} {
  const pathParams: SdkOpenApiParameter[] = [];
  const queryParams: SdkOpenApiParameter[] = [];
  const headerParams: SdkOpenApiParameter[] = [];
  for (const p of op.parameters ?? []) {
    if (p.in === 'cookie') {
      throw new OpenApiCodegenError(
        `Unsupported parameter location 'cookie' for '${p.name}'`,
        path,
        method,
      );
    }
    if (p.in === 'path') pathParams.push(p);
    else if (p.in === 'query') queryParams.push(p);
    else headerParams.push(p);
  }
  return { pathParams, queryParams, headerParams };
}

function getBodySchema(op: SdkOpenApiOperation): SdkOpenApiSchema | undefined {
  if (!op.requestBody) return undefined;
  const rb = op.requestBody as SdkOpenApiRequestBody;
  return rb.content?.['application/json']?.schema;
}

function getSuccessTypes(op: SdkOpenApiOperation, path: string, method: string): string[] {
  if (!op.responses) return ['void'];
  const out: string[] = [];
  for (const [code, resp] of Object.entries(op.responses)) {
    const s = parseInt(code, 10);
    if (s >= 200 && s < 300) {
      const media = resp.content?.['application/json'];
      if (media?.schema) out.push(renderSchema(media.schema, new Set(), path, method));
      else out.push('void');
    }
  }
  return out.length ? out : ['void'];
}

function buildPathLiteral(path: string): string {
  // Strip a single leading slash so the emitted path is relative (HTTP client
  // rejects leading-slash paths). Preserve interior `/` separators between
  // segments.
  const normalized = path.replace(/^\/+/, '');
  const segments = normalized.split('/').map((seg) => {
    const m = seg.match(/^\{(.+)\}$/);
    if (m) {
      const safe = sanitizeIdentifier(m[1]);
      return `encodeURIComponent(${safe})`;
    }
    return `'${escapeSingleQuote(seg)}'`;
  });
  return segments.length === 1 ? segments[0] : segments.join(' + "/" + ');
}

/**
 * Generate TypeScript client source from an OpenAPI 3.1 document.
 * Pure function with zero I/O and deterministic output.
 */
export function generateOpenApiClient(
  document: SdkOpenApiDocument,
  options?: OpenApiCodegenOptions,
): string {
  const opts = resolveOptions(options);
  const operations = collectOperations(document);
  const schemas = document.components?.schemas;

  const lines: string[] = [];
  const L = (s: string = '') => lines.push(s);

  L('/* eslint-disable */');
  L('/**');
  L(' * Auto-generated SDK client. Do not edit manually.');
  L(' */');
  L('');
  L(`import type { ClientResponse, IHttpClient } from '${opts.sdkImport}';`);
  L('');

  if (schemas) {
    for (const [name, schema] of Object.entries(schemas)) {
      L(`export type ${sanitizeIdentifier(name)} = ${renderSchema(schema)};`);
    }
    L('');
  }

  for (const op of operations) {
    const { pathParams: _pathParams, queryParams, headerParams } = splitParams(
      op.operation,
      op.path,
      op.method,
    );
    const bodySchema = getBodySchema(op.operation);
    const typeName = sanitizeIdentifier(op.operationId) + 'Args';
    // Args interface contains ONLY query, header, and body parameters (flat, no wrapper).
    // Path parameters are excluded - they appear as separate function arguments.
    const argsFields: string[] = [];

    if (queryParams.length || headerParams.length || bodySchema) {
      for (const p of queryParams) {
        const pname = sanitizeIdentifier(p.name);
        const ptype = renderSchema(p.schema ?? { type: 'string' }, new Set(), op.path, op.method);
        argsFields.push(`    ${pname}${p.required ? '' : '?'}: ${ptype};`);
      }
      for (const p of headerParams) {
        const pname = sanitizeIdentifier(p.name);
        const ptype = renderSchema(p.schema ?? { type: 'string' }, new Set(), op.path, op.method);
        argsFields.push(`    ${pname}${p.required ? '' : '?'}: ${ptype};`);
      }
      if (bodySchema) {
        const btype = renderSchema(bodySchema, new Set(), op.path, op.method);
        argsFields.push(`    body?: ${btype};`);
      }
    }

    if (argsFields.length) {
      L(`export interface ${typeName} {`);
      argsFields.forEach((f) => L(f));
      L('}');
    }
    L('');
  }

  L(`export function ${opts.factoryName}(client: IHttpClient) {`);

  for (const op of operations) {
    const { pathParams, queryParams, headerParams } = splitParams(
      op.operation,
      op.path,
      op.method,
    );
    const bodySchema = getBodySchema(op.operation);
    const successTypes = getSuccessTypes(op.operation, op.path, op.method);
    const returnType = successTypes.length === 1 && successTypes[0] === 'void'
      ? 'void'
      : successTypes.join(' | ');

    L('');
    L(`    /** ${escapeSingleQuote(op.operationId)} */`);

    const paramList: string[] = [];
    for (const p of pathParams) {
      const pname = sanitizeIdentifier(p.name);
      const ptype = renderSchema(p.schema ?? { type: 'string' }, new Set(), op.path, op.method);
      paramList.push(`${pname}${p.required ? '' : '?'}: ${ptype}`);
    }
    // Generate the *Args interface name and add typed opts parameter if needed.
    const typeName = sanitizeIdentifier(op.operationId) + 'Args';
    if (queryParams.length || headerParams.length || bodySchema) {
      paramList.push(`opts?: ${typeName}`);
    }

    L(`    function ${op.safeName}(${
      paramList.join(', ')
    }): Promise<ClientResponse<${returnType}>> {`);

    const pathExpr = buildPathLiteral(op.path);
    L(`        return client.request<${returnType}>({`);
    L(`            method: '${op.method.toUpperCase()}',`);
    L(`            path: ${pathExpr},`);

    if (queryParams.length) {
      const qParts = queryParams.map((p) => {
        const pname = sanitizeIdentifier(p.name);
        const ptype = renderSchema(p.schema ?? { type: 'string' }, new Set(), op.path, op.method);
        return `'${escapeSingleQuote(p.name)}': (opts?.${pname} as ${ptype} | undefined)`;
      });
      L(`            query: { ${qParts.join(', ')} },`);
    }
    if (headerParams.length) {
      const hChecks = headerParams.map((p) => {
        const pname = sanitizeIdentifier(p.name);
        const origName = escapeSingleQuote(p.name);
        return `if (opts?.${pname} !== undefined) headers['${origName}'] = String(opts?.${pname});`;
      });
      L(`            headers: (() => {`);
      L(`                const headers: Record<string, string> = {};`);
      for (const check of hChecks) {
        L(`                ${check}`);
      }
      L(`                return headers;`);
      L(`            })(),`);
    }
    if (bodySchema) {
      L(`            json: opts?.body,`);
    }

    L('        });');
    L('    }');
  }

  L('');
  L('    return {');
  for (const op of operations) {
    L(`        ${op.safeName},`);
  }
  L('    };');
  L('}');
  L('');

  return lines.join('\n');
}
