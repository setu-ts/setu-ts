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

/**
 * Split a raw name into identifier parts on every run of characters outside
 * `[A-Za-z0-9]`.
 *
 * The leading `.../` strip discards a `$ref` pointer prefix such as
 * `#/components/schemas/`, keeping only the component name.
 */
function identifierParts(raw: string): string[] {
  return raw.replace(/^.*\//, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/**
 * Prefix a leading digit run so the result is a legal identifier, and escape a
 * reserved word. Falls back to `fallback` when nothing survives sanitization.
 */
function finishIdentifier(joined: string, fallback: string): string {
  let result = joined.replace(/^[0-9]+/, (digits) => `n${digits}`);
  if (RESERVED.has(result)) result = `_${result}`;
  return result || fallback;
}

/**
 * Derive a safe lower-camelCase TypeScript identifier for a value (an operation
 * method, a parameter, a path variable).
 *
 * Interior casing of each part is PRESERVED — only the boundary characters are
 * re-cased — so `listUsers` stays `listUsers` and `get-users-{id}` becomes
 * `getUsersId`. Lower-casing whole parts would both mangle familiar names and
 * manufacture false collisions between `getUserId` and `getUserID`.
 */
export function sanitizeIdentifier(raw: string): string {
  const joined = identifierParts(raw)
    .map((part, i) =>
      i === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join('');
  return finishIdentifier(joined, 'operation');
}

/**
 * Derive a safe PascalCase TypeScript identifier for a TYPE (a component schema
 * or a generated argument interface).
 *
 * Types are PascalCase by convention, and using a distinct casing from
 * {@linkcode sanitizeIdentifier} keeps a component named `User` from reading as
 * the value `user` in generated source.
 */
export function sanitizeTypeName(raw: string): string {
  const joined = identifierParts(raw)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return finishIdentifier(joined, 'Schema');
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
    return sanitizeTypeName(name);
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

/** Whether the operation's JSON request body is declared required. */
function isBodyRequired(op: SdkOpenApiOperation): boolean {
  if (!op.requestBody) return false;
  return (op.requestBody as SdkOpenApiRequestBody).required === true;
}

/** A parameter reduced to the two facts the emitter needs. */
interface RenderedParam {
  /** Sanitized identifier used for the arg field and the request key. */
  readonly name: string;
  /** Original wire name, preserved for the query key / header name. */
  readonly wireName: string;
  /** Rendered TypeScript type. */
  readonly type: string;
  readonly required: boolean;
}

/**
 * Everything the two emission passes need about one operation, computed ONCE.
 *
 * Both the `*Args` interface pass and the method-body pass previously re-derived
 * parameters, body schema, and the args type name independently, so a change to
 * one rule had to be mirrored in the other to stay consistent.
 */
interface OpShape {
  readonly entry: OpEntry;
  readonly pathParams: RenderedParam[];
  readonly queryParams: RenderedParam[];
  readonly headerParams: RenderedParam[];
  readonly bodyType: string | undefined;
  readonly bodyRequired: boolean;
  readonly argsTypeName: string;
  /** True when the operation has any `opts` field at all. */
  readonly hasArgs: boolean;
  /**
   * True when at least one `opts` field is required, which makes the `opts`
   * parameter itself required — otherwise a caller could omit `opts` entirely
   * and skip a required query parameter or a required request body.
   */
  readonly argsRequired: boolean;
  readonly returnType: string;
}

function buildOpShape(entry: OpEntry): OpShape {
  const { operation, path, method } = entry;
  const split = splitParams(operation, path, method);

  const render = (p: SdkOpenApiParameter, forcedRequired?: boolean): RenderedParam => ({
    name: sanitizeIdentifier(p.name),
    wireName: p.name,
    // A parameter with no `schema` is treated as a string: that is the only
    // shape that can be serialized into a URL or a header without guessing.
    type: renderSchema(p.schema ?? { type: 'string' }, new Set(), path, method),
    required: forcedRequired ?? p.required === true,
  });

  // OpenAPI requires `required: true` on a path parameter. Forcing it here also
  // prevents emitting `a?: string, b: string`, which is a TypeScript error
  // ("a required parameter cannot follow an optional parameter").
  const pathParams = split.pathParams.map((p) => render(p, true));
  const queryParams = split.queryParams.map((p) => render(p));
  const headerParams = split.headerParams.map((p) => render(p));

  const bodySchema = getBodySchema(operation);
  const bodyType = bodySchema ? renderSchema(bodySchema, new Set(), path, method) : undefined;
  const bodyRequired = bodyType !== undefined && isBodyRequired(operation);

  const successTypes = getSuccessTypes(operation, path, method);
  const returnType = successTypes.length === 1 && successTypes[0] === 'void'
    ? 'void'
    : successTypes.join(' | ');

  const hasArgs = queryParams.length > 0 || headerParams.length > 0 || bodyType !== undefined;

  return {
    entry,
    pathParams,
    queryParams,
    headerParams,
    bodyType,
    bodyRequired,
    argsTypeName: sanitizeTypeName(entry.operationId) + 'Args',
    hasArgs,
    argsRequired: bodyRequired ||
      queryParams.some((p) => p.required) ||
      headerParams.some((p) => p.required),
    returnType,
  };
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

/**
 * Render an OpenAPI path template as a TypeScript template-literal expression.
 *
 * Leading slashes are stripped so the emitted path is relative — `HttpClient`
 * rejects a leading-slash path. Every `{name}` placeholder is substituted and
 * percent-encoded, INCLUDING placeholders that share a segment with literal text
 * (`/files/{id}.json`); an anchored whole-segment match would emit `{id}.json`
 * as a literal and silently drop the substitution.
 */
function buildPathLiteral(path: string): string {
  const normalized = path.replace(/^\/+/, '');
  // `[^}]*` is non-greedy by construction, so `{a}x{b}` yields TWO placeholders
  // rather than one spanning the interior brace.
  const placeholder = /\{([^}]*)\}/g;
  let out = '';
  let cursor = 0;
  for (let m = placeholder.exec(normalized); m !== null; m = placeholder.exec(normalized)) {
    out += escapeTemplateLiteral(normalized.slice(cursor, m.index));
    out += `\${encodeURIComponent(${sanitizeIdentifier(m[1]!)})}`;
    cursor = m.index + m[0].length;
  }
  // A path with no placeholders needs no interpolation; emit a plain string
  // literal rather than a template literal that substitutes nothing.
  if (cursor === 0) return `'${escapeSingleQuote(normalized)}'`;
  out += escapeTemplateLiteral(normalized.slice(cursor));
  return `\`${out}\``;
}

/**
 * Escape a LITERAL chunk of an emitted template literal.
 *
 * Applied only to the non-substitution text, before substitutions are spliced
 * in, so a backtick, a backslash, or a `${` that came from the source path
 * cannot break out of or inject into the emitted literal.
 */
function escapeTemplateLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
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

  // This repo (and a generated file's likely home) lints with `deno lint`, not
  // ESLint; an `eslint-disable` pragma here would suppress nothing.
  L('// deno-lint-ignore-file');
  L('/**');
  L(' * Auto-generated SDK client. Do not edit manually.');
  L(' */');
  L('');
  L(`import type { ClientResponse, IHttpClient } from '${opts.sdkImport}';`);
  L('');

  if (schemas) {
    // Two component names can sanitize onto ONE type name (`User` / `user`),
    // which would emit duplicate `export type` declarations — a syntax error in
    // the generated file. Fail with both originals instead.
    const usedTypes = new Map<string, string>();
    for (const [name, schema] of Object.entries(schemas)) {
      const typeName = sanitizeTypeName(name);
      const clash = usedTypes.get(typeName);
      if (clash !== undefined) {
        throw new OpenApiCodegenError(
          `Duplicate component type name '${typeName}': schemas '${clash}' and '${name}'`,
        );
      }
      usedTypes.set(typeName, name);
      L(`export type ${typeName} = ${renderSchema(schema)};`);
    }
    L('');
  }

  const shapes = operations.map(buildOpShape);

  // Pass 1 — the `*Args` interface for each operation that takes any.
  // Path parameters are deliberately excluded: they are positional function
  // arguments, since a path cannot be built without them.
  for (const shape of shapes) {
    // An operation with no args emits nothing here — not even a blank line, which
    // would leave a run of blank lines between the interfaces that do get emitted.
    if (!shape.hasArgs) continue;
    L(`export interface ${shape.argsTypeName} {`);
    for (const p of [...shape.queryParams, ...shape.headerParams]) {
      L(`    ${p.name}${p.required ? '' : '?'}: ${p.type};`);
    }
    if (shape.bodyType !== undefined) {
      L(`    body${shape.bodyRequired ? '' : '?'}: ${shape.bodyType};`);
    }
    L('}');
    L('');
  }

  L(`export function ${opts.factoryName}(client: IHttpClient) {`);

  // Pass 2 — the method for each operation.
  for (const shape of shapes) {
    const { entry, returnType } = shape;
    // `opts` is accessed unconditionally when required, so no optional chain.
    const optsRef = shape.argsRequired ? 'opts' : 'opts?';

    L('');
    L(`    /** ${escapeSingleQuote(entry.operationId)} */`);

    const paramList = shape.pathParams.map((p) => `${p.name}: ${p.type}`);
    if (shape.hasArgs) {
      paramList.push(`opts${shape.argsRequired ? '' : '?'}: ${shape.argsTypeName}`);
    }

    L(`    function ${entry.safeName}(${
      paramList.join(', ')
    }): Promise<ClientResponse<${returnType}>> {`);

    L(`        return client.request<${returnType}>({`);
    L(`            method: '${entry.method.toUpperCase()}',`);
    L(`            path: ${buildPathLiteral(entry.path)},`);

    if (shape.queryParams.length) {
      // No cast: the arg field is already declared with this parameter's rendered
      // type, so it assigns to `ClientRequest.query` directly. A cast here would
      // silence nothing and would hide a genuinely unassignable query type.
      const qParts = shape.queryParams.map((p) =>
        `'${escapeSingleQuote(p.wireName)}': ${optsRef}.${p.name}`
      );
      L(`            query: { ${qParts.join(', ')} },`);
    }
    if (shape.headerParams.length) {
      // Built in an IIFE rather than an object literal so an omitted optional
      // header is absent entirely instead of present-and-`undefined`, and so a
      // non-string header value (an `integer` schema) is stringified.
      L(`            headers: (() => {`);
      L(`                const headers: Record<string, string> = {};`);
      for (const p of shape.headerParams) {
        L(
          `                if (${optsRef}.${p.name} !== undefined) headers['${
            escapeSingleQuote(p.wireName)
          }'] = String(${optsRef}.${p.name});`,
        );
      }
      L(`                return headers;`);
      L(`            })(),`);
    }
    if (shape.bodyType !== undefined) {
      L(`            json: ${optsRef}.body,`);
    }

    L('        });');
    L('    }');
  }

  L('');
  L('    return {');
  for (const shape of shapes) {
    L(`        ${shape.entry.safeName},`);
  }
  L('    };');
  L('}');
  L('');

  return lines.join('\n');
}
