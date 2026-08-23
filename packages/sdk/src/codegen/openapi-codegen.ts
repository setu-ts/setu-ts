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
  SdkOpenApiPathItem,
  SdkOpenApiRequestBody,
  SdkOpenApiSchema,
} from './openapi-types.ts';

/** Options for `generateOpenApiClient`. */
export interface OpenApiCodegenOptions {
  /** Name of the exported factory function. Defaults to `'createApi'`. */
  readonly factoryName?: string;
  /** Import specifier for SDK types. Defaults to `'@setu-ts/sdk'`. */
  readonly sdkImport?: string;
  /**
   * Name of the exported interface describing the generated client, and the
   * factory's return type. Defaults to `'Api'`.
   *
   * The factory needs a written-out return type or JSR rejects the generated
   * file as a slow type, which blocks `.d.ts` generation — so a consumer could
   * not publish a package containing it. Naming the interface is also the only
   * way a consumer can name the client's type at all.
   *
   * Configure it when a component schema in the document is already called
   * `Api`: every emitted type name is claimed from one registry, so the clash
   * throws rather than emitting two declarations of one name.
   */
  readonly apiTypeName?: string;
}

interface ResolvedOptions {
  readonly factoryName: string;
  readonly sdkImport: string;
  readonly apiTypeName: string;
}

function resolveOptions(options?: OpenApiCodegenOptions): ResolvedOptions {
  return {
    factoryName: options?.factoryName ?? 'createApi',
    sdkImport: options?.sdkImport ?? '@setu-ts/sdk',
    apiTypeName: options?.apiTypeName ?? 'Api',
  };
}

/**
 * Claims each emitted TYPE name exactly once — component schemas, `*Args`
 * interfaces, `*Error` unions and the `Api` interface all draw from here.
 *
 * Two names that sanitize onto one identifier would emit two declarations of
 * it, a syntax error in the generated file, from a generator whose stated
 * contract is that it throws rather than emit source that does not compile.
 * The registry previously covered component schemas alone, so a component
 * named `ListUsersArgs` beside an operation `listUsers` already collided.
 */
class TypeNameRegistry {
  readonly #claimed = new Map<string, string>();

  /**
   * Claims `name` on behalf of `origin`.
   *
   * @param name - The emitted TypeScript identifier
   * @param origin - What the name was derived from, for the diagnostic
   * @returns The same `name`
   * @throws {OpenApiCodegenError} When another origin already claimed it
   */
  claim(name: string, origin: string): string {
    const previous = this.#claimed.get(name);
    if (previous !== undefined) {
      throw new OpenApiCodegenError(
        `Duplicate generated name '${name}': '${previous}' and '${origin}'`,
      );
    }
    this.#claimed.set(name, origin);
    return name;
  }
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

/**
 * Escape document text for emission inside a single-line block comment.
 *
 * `escapeSingleQuote` is the wrong escaper here: it neutralizes string-literal
 * delimiters, which a comment does not care about, and leaves a comment
 * terminator intact. An `operationId` carrying one therefore closed the comment
 * early and injected the remainder as executable code into the generated factory
 * body — a payload that type-checked and ran, so neither `deno check` nor a
 * glance at the spec caught it.
 *
 * Escaping the slash of every terminator is sufficient and keeps the text
 * legible. Line breaks are collapsed so a multi-line value cannot break out of
 * the single-line comment either.
 */
function escapeBlockComment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '*\\/');
}

function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${escapeSingleQuote(value)}'`;
  return 'unknown';
}

/**
 * The empty-object type emitted where a schema describes an object that admits
 * NO properties (`additionalProperties: false` with none declared).
 *
 * Not `{}`: in TypeScript that means "anything but `null`/`undefined`", the
 * opposite of what the schema says, and `deno lint`'s `ban-types` rejects it —
 * which is the only reason the generator used to emit a blanket
 * `deno-lint-ignore-file`.
 */
const EMPTY_OBJECT_TYPE = 'Record<PropertyKey, never>';

/** One level of generated indentation. Two spaces, matching `deno fmt`. */
const INDENT = '  ';

/**
 * The line width `deno fmt` uses, and the width every scaffolded project's
 * emitted `fmt` config sets (`deno.json` `fmt.lineWidth`).
 */
const LINE_WIDTH = 100;

/**
 * Renders a function or method signature, wrapping its parameter list exactly
 * the way `deno fmt` does when the one-line form exceeds
 * {@linkcode LINE_WIDTH}.
 *
 * ONE implementation, used by both the `Api` interface pass and the factory's
 * method pass, so the two cannot disagree about where a line breaks — the
 * M70h `renderList` lesson, where a second copy with a guessed width emitted
 * 123-column lines that failed the generated project's own `fmt` gate.
 *
 * A zero-parameter signature is never wrapped: `deno fmt` cannot break an
 * empty list either, so a long one stays long in both.
 *
 * @param indent - Leading whitespace for the signature's first line
 * @param prefix - Everything before the `(` (`function foo`, or just `foo`)
 * @param params - Rendered parameter declarations
 * @param suffix - Everything after the `)` (`: Promise<…> {` or `: Promise<…>;`)
 * @returns The emitted lines
 */
function renderSignature(
  indent: string,
  prefix: string,
  params: readonly string[],
  suffix: string,
): string[] {
  const single = `${indent}${prefix}(${params.join(', ')})${suffix}`;
  if (single.length <= LINE_WIDTH || params.length === 0) return [single];
  return [
    `${indent}${prefix}(`,
    ...params.map((p) => `${indent}${INDENT}${p},`),
    `${indent})${suffix}`,
  ];
}

/**
 * Renders `additionalProperties` for an object with no own declared properties.
 *
 * Shared by the two sites that reach it — `properties` absent, and `properties`
 * present but EMPTY — because reading an empty map as a closed object made two
 * spellings of one schema contradict each other.
 *
 * @param ap - The schema's `additionalProperties`
 * @param seen - Cycle guard carried through the recursion
 * @param path - Path, for diagnostics
 * @param method - Method, for diagnostics
 * @param depth - Current indentation depth
 * @returns The rendered index-signature type
 */
function renderAdditional(
  ap: boolean | SdkOpenApiSchema,
  seen: Set<SdkOpenApiSchema>,
  path: string | undefined,
  method: string | undefined,
  depth: number,
): string {
  if (typeof ap === 'boolean') return ap ? 'Record<string, unknown>' : EMPTY_OBJECT_TYPE;
  return `Record<string, ${renderSchema(ap, seen, path, method, depth)}>`;
}

function renderSchema(
  schema: SdkOpenApiSchema | undefined,
  seen: Set<SdkOpenApiSchema> = new Set(),
  path?: string,
  method?: string,
  depth = 0,
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
    return schema.anyOf.map((s) => renderSchema(s, next, path, method, depth)).join(' | ') ||
      'unknown';
  }
  if (schema.oneOf) {
    return schema.oneOf.map((s) => renderSchema(s, next, path, method, depth)).join(' | ') ||
      'unknown';
  }
  if (schema.allOf) {
    return schema.allOf.map((s) => renderSchema(s, next, path, method, depth)).join(' & ') ||
      'unknown';
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 1) {
    return types.filter(Boolean).map((t) => rtp(t!, schema, next, path, method, depth)).join(' | ');
  }
  return types[0] ? rtp(types[0], schema, next, path, method, depth) : 'unknown';
}

function rtp(
  type: string,
  schema: SdkOpenApiSchema,
  seen: Set<SdkOpenApiSchema>,
  path?: string,
  method?: string,
  depth = 0,
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
      return schema.items
        ? `${renderSchema(schema.items, seen, path, method, depth)}[]`
        : 'unknown[]';
    case 'object':
      return ros(schema, seen, path, method, depth);
    default:
      return 'unknown';
  }
}

function ros(
  schema: SdkOpenApiSchema,
  seen: Set<SdkOpenApiSchema>,
  path?: string,
  method?: string,
  depth = 0,
): string {
  if (schema.properties) {
    const keys = Object.entries(schema.properties);
    // An object type that declares no properties is the empty object, and
    // emitting `{\n\n}` for it is both `ban-types` and a lie about its meaning.
    //
    // `additionalProperties` still decides what the schema ACCEPTS, though, so
    // it is only the closed empty object when nothing else is allowed. Reading
    // `properties: {}` as closed regardless made two spellings of one schema
    // contradict each other: with the empty key it rendered
    // `Record<PropertyKey, never>`, which rejects every payload the schema
    // accepts, while without it the branch below rendered `Record<string, …>`.
    if (keys.length === 0) {
      if (schema.additionalProperties === undefined) return EMPTY_OBJECT_TYPE;
      return renderAdditional(schema.additionalProperties, seen, path, method, depth);
    }

    const req = new Set(schema.required ?? []);
    // Properties sit one level deeper than the brace that opens them, and the
    // CLOSING brace sits back at the opening line's level — which is what
    // `deno fmt` produces and what the old fixed 4-space body did not.
    const inner = INDENT.repeat(depth + 1);
    const outer = INDENT.repeat(depth);
    const propLines: string[] = [];
    for (const [key, val] of keys) {
      const opt = req.has(key) ? '' : '?';
      propLines.push(
        `${inner}'${escapeSingleQuote(key)}'${opt}: ${
          renderSchema(val, seen, path, method, depth + 1)
        };`,
      );
    }
    const body = `{\n${propLines.join('\n')}\n${outer}}`;
    if (schema.additionalProperties !== undefined) {
      if (typeof schema.additionalProperties === 'boolean') {
        if (schema.additionalProperties) return `${body} & Record<string, unknown>`;
        return body;
      }
      const ap = renderSchema(schema.additionalProperties, seen, path, method, depth);
      return `${body} & Record<string, ${ap}>`;
    }
    return body;
  }
  if (schema.additionalProperties !== undefined) {
    return renderAdditional(schema.additionalProperties, seen, path, method, depth);
  }
  return 'Record<string, unknown>';
}

interface OpEntry {
  readonly path: string;
  readonly method: string;
  readonly operation: SdkOpenApiOperation;
  /** Path-item-level parameters merged with the operation's own (§`mergeParameters`). */
  readonly parameters: SdkOpenApiParameter[];
  readonly operationId: string;
  readonly safeName: string;
}

// Every operation slot declared on `SdkOpenApiPathItem`. `trace` belongs here:
// omitting it silently dropped a declared operation — no method emitted and no
// diagnostic — rather than generating it or rejecting it.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Merge path-item-level parameters with an operation's own.
 *
 * OpenAPI lets a path item declare parameters shared by all its operations, with
 * the operation's own entry overriding one that has the same `name` AND `in`.
 * `SdkOpenApiPathItem.parameters` was declared but never read, so shared
 * parameters were silently discarded — which, for a shared PATH parameter, then
 * emitted source referencing an undeclared identifier.
 */
function mergeParameters(
  item: SdkOpenApiPathItem,
  op: SdkOpenApiOperation,
): SdkOpenApiParameter[] {
  const shared = item.parameters ?? [];
  if (shared.length === 0) return [...(op.parameters ?? [])];

  const own = op.parameters ?? [];
  const ownKeys = new Set(own.map((p) => `${p.in}:${p.name}`));
  return [...shared.filter((p) => !ownKeys.has(`${p.in}:${p.name}`)), ...own];
}

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
      entries.push({
        path,
        method,
        operation: op,
        parameters: mergeParameters(item, op),
        operationId: op.operationId,
        safeName,
      });
    }
  }
  return entries;
}

function splitParams(
  parameters: readonly SdkOpenApiParameter[],
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
  for (const p of parameters) {
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
  /**
   * Declared non-2xx responses, as `{ status, body }` arms.
   *
   * Empty when the document declares none, in which case no error union and no
   * guard is emitted for the operation — an exported type nothing references
   * is dead surface.
   */
  readonly errorArms: readonly {
    readonly status: number;
    /** The type written into the union arm — an alias name when one was needed. */
    readonly type: string;
  }[];
  /**
   * Multi-line types hoisted out of this operation's own use sites.
   *
   * Emitted as exported aliases ahead of everything that references them, so no
   * object literal is ever written at an indentation `deno fmt` disagrees with.
   */
  readonly aliases: readonly HoistedAlias[];
  /** Name of the emitted error union, claimed only when `errorArms` is non-empty. */
  readonly errorTypeName: string;
  /** Name of the emitted narrowing guard. */
  readonly errorGuardName: string;
}

/**
 * Parses a response key that names ONE concrete HTTP status.
 *
 * `parseInt` is unusable here: `parseInt('4XX', 10)` returns `4`, so a range
 * code passed a `Number.isFinite` guard and became a `status: 4` arm that no
 * response can ever carry — while a real `404` went unnarrowed. Only `default`
 * actually parses to `NaN`. The whole key must therefore match a status.
 *
 * @param code - The response key from the document
 * @returns The status, or `undefined` for `default` and range codes such as `4XX`
 */
function parseStatusCode(code: string): number | undefined {
  return /^[1-5][0-9]{2}$/.test(code) ? Number(code) : undefined;
}

/** A rendered type lifted out of its use site into its own exported alias. */
interface HoistedAlias {
  readonly name: string;
  readonly body: string;
}

/**
 * Keep a rendered type on ONE line, hoisting a multi-line one into an alias.
 *
 * An emitted type lands at several indentation levels — an `Args` member, an
 * `Api` signature, and the `client.request<…>` type argument — and the SAME
 * rendered string is used at more than one of them, so NO single indent is
 * correct for a multi-line object literal. `deno fmt` reindents it and the
 * generated file then fails the `fmt` gate every scaffolded project runs, which
 * is the whole of X11-9. Hoisting removes the question: every reference is a
 * single-line name, and the shape also becomes nameable by a consumer.
 *
 * @param rendered - The rendered type
 * @param name - Produces the alias name; called only when hoisting
 * @param aliases - Collector the alias is appended to
 * @returns `rendered` when single-line, else the claimed alias name
 */
function hoistMultiline(
  rendered: string,
  name: () => string,
  aliases: HoistedAlias[],
): string {
  if (!rendered.includes('\n')) return rendered;
  const claimed = name();
  aliases.push({ name: claimed, body: rendered });
  return claimed;
}

/**
 * Collects an operation's declared non-2xx responses.
 *
 * `getSuccessTypes` reads only 2xx, so a document's 4xx schemas — the part a
 * client most needs help with — typed nothing at all: a non-2xx throws
 * `HttpClientError`, whose `body` is `unknown`.
 *
 * @param op - The operation
 * @param path - Path, for diagnostics
 * @param method - Method, for diagnostics
 * @returns One arm per declared non-2xx status, in ascending status order
 */
function getErrorArms(
  op: SdkOpenApiOperation,
  path: string,
  method: string,
  operationId: string,
  types: TypeNameRegistry,
  aliases: HoistedAlias[],
): OpShape['errorArms'] {
  if (!op.responses) return [];
  const arms: { status: number; type: string }[] = [];
  for (const [code, resp] of Object.entries(op.responses)) {
    // `default` and a range code such as `4XX` name no single status, so neither
    // can become a discriminated arm.
    const status = parseStatusCode(code);
    if (status === undefined || (status >= 200 && status < 300)) continue;
    const media = resp.content?.['application/json'];
    const rendered = media?.schema
      ? renderSchema(media.schema, new Set(), path, method)
      : 'unknown';

    // A multi-line body must be hoisted, or `deno fmt` reformats the union arm's
    // intersection into a leading-`&` block. `hoistMultiline` owns that rule for
    // every emitted type, not just this one.
    arms.push({
      status,
      type: hoistMultiline(
        rendered,
        () =>
          types.claim(
            `${sanitizeTypeName(operationId)}Error${status}Body`,
            `the ${status} response body of operation '${operationId}'`,
          ),
        aliases,
      ),
    });
  }
  return arms.sort((a, b) => a.status - b.status);
}

/** Every `{placeholder}` name in a path template, in order of appearance. */
function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
}

/**
 * Reject a path template and its declared `path` parameters disagreeing.
 *
 * Both directions are a defect that the generator used to emit silently:
 *
 * - A placeholder with NO declared parameter emitted `encodeURIComponent(id)`
 *   while the method signature had no `id`, so the generated file did not
 *   compile (`TS2304: Cannot find name 'id'`) — a failure that surfaced in the
 *   consumer's build with no hint at which operation caused it.
 * - A declared `in: 'path'` parameter NOT in the template emitted a positional
 *   argument that is never used, so a caller's value was silently dropped.
 */
function assertPathParamsMatchTemplate(
  path: string,
  method: string,
  pathParams: readonly SdkOpenApiParameter[],
): void {
  const placeholders = pathPlaceholders(path);

  // Compare on the DERIVED identifier: `buildPathLiteral` sanitizes each
  // placeholder, so `user-id` in the template is satisfied by a `user-id`
  // parameter, and two placeholders deriving onto one identifier are a
  // duplicate-argument defect of their own.
  const derivedDeclared = new Set(pathParams.map((p) => sanitizeIdentifier(p.name)));
  const seen = new Set<string>();

  for (const raw of placeholders) {
    const derived = sanitizeIdentifier(raw);
    if (!derivedDeclared.has(derived)) {
      throw new OpenApiCodegenError(
        `Path template '${path}' declares placeholder '{${raw}}' with no matching ` +
          `'in: path' parameter; the generated method would reference an undeclared '${derived}'`,
        path,
        method,
      );
    }
    if (seen.has(derived)) {
      throw new OpenApiCodegenError(
        `Path template '${path}' has two placeholders deriving onto one argument '${derived}'`,
        path,
        method,
      );
    }
    seen.add(derived);
  }

  for (const p of pathParams) {
    if (!seen.has(sanitizeIdentifier(p.name))) {
      throw new OpenApiCodegenError(
        `Parameter '${p.name}' is declared 'in: path' but does not appear in the path ` +
          `template '${path}'; its value would be silently dropped`,
        path,
        method,
      );
    }
  }
}

function buildOpShape(entry: OpEntry, types: TypeNameRegistry): OpShape {
  const { path, method } = entry;
  const split = splitParams(entry.parameters, path, method);
  assertPathParamsMatchTemplate(path, method, split.pathParams);

  const aliases: HoistedAlias[] = [];

  const render = (p: SdkOpenApiParameter, forcedRequired?: boolean): RenderedParam => ({
    name: sanitizeIdentifier(p.name),
    wireName: p.name,
    // A parameter with no `schema` is treated as a string: that is the only
    // shape that can be serialized into a URL or a header without guessing.
    type: hoistMultiline(
      renderSchema(p.schema ?? { type: 'string' }, new Set(), path, method),
      () =>
        types.claim(
          `${sanitizeTypeName(entry.operationId)}${sanitizeTypeName(p.name)}Param`,
          `the '${p.name}' parameter of operation '${entry.operationId}'`,
        ),
      aliases,
    ),
    required: forcedRequired ?? p.required === true,
  });

  // OpenAPI requires `required: true` on a path parameter. Forcing it here also
  // prevents emitting `a?: string, b: string`, which is a TypeScript error
  // ("a required parameter cannot follow an optional parameter").
  const pathParams = split.pathParams.map((p) => render(p, true));
  const queryParams = split.queryParams.map((p) => render(p));
  const headerParams = split.headerParams.map((p) => render(p));

  const bodySchema = getBodySchema(entry.operation);
  const bodyType = bodySchema
    ? hoistMultiline(
      renderSchema(bodySchema, new Set(), path, method),
      () =>
        types.claim(
          `${sanitizeTypeName(entry.operationId)}Body`,
          `the request body of operation '${entry.operationId}'`,
        ),
      aliases,
    )
    : undefined;
  const bodyRequired = bodyType !== undefined && isBodyRequired(entry.operation);

  const errorArms = getErrorArms(
    entry.operation,
    path,
    method,
    entry.operationId,
    types,
    aliases,
  );

  const successTypes = getSuccessTypes(
    entry.operation,
    path,
    method,
    entry.operationId,
    types,
    aliases,
  );
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
    argsTypeName: hasArgs
      ? types.claim(
        sanitizeTypeName(entry.operationId) + 'Args',
        `arguments of operation '${entry.operationId}'`,
      )
      : sanitizeTypeName(entry.operationId) + 'Args',
    hasArgs,
    argsRequired: bodyRequired ||
      queryParams.some((p) => p.required) ||
      headerParams.some((p) => p.required),
    returnType,
    errorArms,
    aliases,
    errorTypeName: errorArms.length > 0
      ? types.claim(
        sanitizeTypeName(entry.operationId) + 'Error',
        `error responses of operation '${entry.operationId}'`,
      )
      : '',
    errorGuardName: errorArms.length > 0
      ? types.claim(
        `is${sanitizeTypeName(entry.operationId)}Error`,
        `the error guard of operation '${entry.operationId}'`,
      )
      : `is${sanitizeTypeName(entry.operationId)}Error`,
  };
}

function getSuccessTypes(
  op: SdkOpenApiOperation,
  path: string,
  method: string,
  operationId: string,
  types: TypeNameRegistry,
  aliases: HoistedAlias[],
): string[] {
  if (!op.responses) return ['void'];
  const out: string[] = [];
  for (const [code, resp] of Object.entries(op.responses)) {
    const s = parseStatusCode(code);
    if (s !== undefined && s >= 200 && s < 300) {
      const media = resp.content?.['application/json'];
      if (media?.schema) {
        // A success type is written at TWO indentation levels — the `Api`
        // signature and the `client.request<…>` argument — so a multi-line one
        // cannot be correct at both. Hoisting is the only fix available here.
        out.push(hoistMultiline(
          renderSchema(media.schema, new Set(), path, method),
          () =>
            types.claim(
              `${sanitizeTypeName(operationId)}Response${s}`,
              `the ${s} response body of operation '${operationId}'`,
            ),
          aliases,
        ));
      } else out.push('void');
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
function buildPathLiteral(path: string, indent: string, prefix: string): string[] {
  const normalized = path.replace(/^\/+/, '');
  // `[^}]*` is non-greedy by construction, so `{a}x{b}` yields TWO placeholders
  // rather than one spanning the interior brace.
  const placeholder = /\{([^}]*)\}/g;
  // Literal chunks and substitutions in source order. Both forms below are
  // rendered from this ONE list, so they cannot describe different paths.
  const parts: { literal: boolean; text: string }[] = [];
  let cursor = 0;
  for (let m = placeholder.exec(normalized); m !== null; m = placeholder.exec(normalized)) {
    if (m.index > cursor) {
      parts.push({ literal: true, text: normalized.slice(cursor, m.index) });
    }
    parts.push({ literal: false, text: sanitizeIdentifier(m[1]!) });
    cursor = m.index + m[0].length;
  }

  // A path with no placeholders needs no interpolation; emit a plain string
  // literal rather than a template literal that substitutes nothing.
  if (cursor === 0) return [`${indent}${prefix}'${escapeSingleQuote(normalized)}',`];
  if (cursor < normalized.length) {
    parts.push({ literal: true, text: normalized.slice(cursor) });
  }

  const template = parts
    .map((part) =>
      part.literal ? escapeTemplateLiteral(part.text) : `\${encodeURIComponent(${part.text})}`
    )
    .join('');
  const single = `${indent}${prefix}\`${template}\`,`;
  if (single.length <= LINE_WIDTH) return [single];

  // Too long for one line. A template literal is NOT usable here: `deno fmt`
  // rewraps a long one by breaking at whichever `${` happens to fit, which no
  // generator can predict — so the emitted file would fail the `fmt` gate every
  // scaffolded project runs. An array `.join('')` is exactly equivalent (it
  // concatenates the same chunks in the same order, mixed segments included)
  // and wraps one element per line, a shape `deno fmt` leaves alone (probed).
  return [
    `${indent}${prefix}[`,
    ...parts.map((part) =>
      part.literal
        ? `${indent}${INDENT}'${escapeSingleQuote(part.text)}',`
        : `${indent}${INDENT}encodeURIComponent(${part.text}),`
    ),
    `${indent}].join(''),`,
  ];
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

  // Names are claimed, and shapes built, BEFORE anything is emitted: the import
  // line depends on whether any operation declares an error response, and a
  // component name must win a clash against a generated one.
  const types = new TypeNameRegistry();
  // The emitted import lines BIND these identifiers, so a component schema
  // named `ClientResponse` produced both an import and an `export type` of the
  // same name and the generated file did not compile. Reserved before anything
  // else is claimed, so the diagnostic names the collision instead.
  // `HttpClientError` is reserved unconditionally although its import is
  // conditional: the guard names that force it are claimed during shape
  // building, below, so whether it is needed is not yet known here — and the
  // name belongs to the SDK either way.
  for (const imported of ['ClientResponse', 'IHttpClient', 'HttpClientError']) {
    types.claim(imported, 'an identifier imported from @setu-ts/sdk');
  }
  const apiTypeName = types.claim(sanitizeTypeName(opts.apiTypeName), 'the `apiTypeName` option');
  // The factory is a module-level VALUE, and a generated error guard is too, so
  // both share this namespace: `factoryName: 'isGetUserError'` beside an
  // operation deriving that guard emitted two functions of one name.
  // Claimed VERBATIM: the emitter writes `opts.factoryName` as given, so
  // sanitizing here would reserve `CreateApi` while emitting `createApi`.
  types.claim(opts.factoryName, 'the `factoryName` option');

  const componentLines: string[] = [];
  if (schemas) {
    for (const [name, schema] of Object.entries(schemas)) {
      const typeName = types.claim(sanitizeTypeName(name), `component schema '${name}'`);
      componentLines.push(`export type ${typeName} = ${renderSchema(schema)};`);
    }
  }

  const shapes = operations.map((entry) => buildOpShape(entry, types));
  const anyErrors = shapes.some((shape) => shape.errorArms.length > 0);

  // No lint pragma. The generator emits only lint-clean constructs, and a
  // NARROWED ignore cannot be emitted unconditionally either: `deno lint`
  // reports an ignore that matches nothing as `ban-unused-ignore`, so a named
  // rule would fail every document that does not trip it. The blanket form the
  // generator used to emit existed for `{}` alone, which `EMPTY_OBJECT_TYPE`
  // replaced.
  L('/**');
  L(' * Auto-generated SDK client. Do not edit manually.');
  L(' */');
  L('');
  L(`import type { ClientResponse, IHttpClient } from '${opts.sdkImport}';`);
  if (anyErrors) {
    // A VALUE import, not a type-only one: the generated guards narrow with
    // `instanceof`.
    L(`import { HttpClientError } from '${opts.sdkImport}';`);
  }
  L('');

  if (componentLines.length > 0) {
    for (const line of componentLines) L(line);
    L('');
  }

  // Pass 0 — every hoisted type, ahead of everything that references it.
  //
  // One block for all four sources (a request body, a parameter, a success
  // response, an error body), because `hoistMultiline` is the single owner of
  // the rule; splitting emission per source is what let the multi-line indent
  // defect survive in three of them while the fourth was correct.
  const hoisted = shapes.flatMap((shape) => shape.aliases);
  if (hoisted.length > 0) {
    for (const alias of hoisted) L(`export type ${alias.name} = ${alias.body};`);
    L('');
  }

  // Pass 1 — the `*Args` interface for each operation that takes any.
  // Path parameters are deliberately excluded: they are positional function
  // arguments, since a path cannot be built without them.
  for (const shape of shapes) {
    // An operation with no args emits nothing here — not even a blank line, which
    // would leave a run of blank lines between the interfaces that do get emitted.
    if (!shape.hasArgs) continue;
    L(`export interface ${shape.argsTypeName} {`);
    for (const p of [...shape.queryParams, ...shape.headerParams]) {
      L(`${INDENT}${p.name}${p.required ? '' : '?'}: ${p.type};`);
    }
    if (shape.bodyType !== undefined) {
      L(`${INDENT}body${shape.bodyRequired ? '' : '?'}: ${shape.bodyType};`);
    }
    L('}');
    L('');
  }

  // Pass 2 — the error union and narrowing guard for each operation that
  // declares a non-2xx response.
  //
  // The union is discriminated on the literal `status`, which is what makes it
  // usable: `HttpClientError<A> | HttpClientError<B>` is NOT discriminated,
  // because `status` is `number` on both arms. Intersecting the runtime class
  // with the literal-status union gives both `instanceof` narrowing and a
  // `body` the compiler can tell apart.
  for (const shape of shapes) {
    if (shape.errorArms.length === 0) continue;
    type ErrorArm = { readonly status: number; readonly type: string };
    const arm = (a: ErrorArm) => `HttpClientError<${a.type}> & { readonly status: ${a.status} }`;
    // An over-width intersection has its own canonical `deno fmt` form: a
    // leading-`&` block, mirroring the leading-`|` one a union takes. Both are
    // stable at ANY length (probed), so the only decision is whether the
    // one-line form fits — measured off the emitted string, never estimated.
    // This matters at ordinary sizes: an operationId of ~17 characters with an
    // inline error body already pushes the single-arm declaration past 100.
    const armBlock = (a: ErrorArm, indent: string): [string, string] => [
      `${indent}& HttpClientError<${a.type}>`,
      `${indent}& { readonly status: ${a.status} }`,
    ];
    if (shape.errorArms.length === 1) {
      // A single-arm union is not a union: `deno fmt` strips the leading `|`
      // AND the parentheses, so emitting them would fail the fmt gate.
      const only = shape.errorArms[0]!;
      const oneLine = `export type ${shape.errorTypeName} = ${arm(only)};`;
      if (oneLine.length <= LINE_WIDTH) {
        L(oneLine);
      } else {
        L(`export type ${shape.errorTypeName} =`);
        const [head, tail] = armBlock(only, INDENT);
        L(head);
        L(`${tail};`);
      }
    } else {
      // Two or more arms: `deno fmt` ALWAYS breaks a union of parenthesized
      // intersections onto leading-`|` lines, even a short one (probed).
      L(`export type ${shape.errorTypeName} =`);
      shape.errorArms.forEach((a, i) => {
        const end = i === shape.errorArms.length - 1 ? ';' : '';
        const oneLine = `${INDENT}| (${arm(a)})${end}`;
        if (oneLine.length <= LINE_WIDTH) {
          L(oneLine);
          return;
        }
        L(`${INDENT}| (`);
        for (const line of armBlock(a, INDENT.repeat(2))) L(line);
        L(`${INDENT})${end}`);
      });
    }
    // The guard's own signature goes over width on operationId length ALONE,
    // with no inline schema involved, so it wraps through the same helper the
    // operation signatures use rather than a second mechanism.
    for (
      const line of renderSignature(
        '',
        `export function ${shape.errorGuardName}`,
        ['e: unknown'],
        `: e is ${shape.errorTypeName} {`,
      )
    ) L(line);
    const clauses = shape.errorArms.map((a) => `e.status === ${a.status}`);
    const oneLine = `${INDENT}return e instanceof HttpClientError && (${clauses.join(' || ')});`;
    if (oneLine.length <= LINE_WIDTH) {
      L(oneLine);
    } else {
      // Five three-digit statuses already reach 140 columns, and `deno fmt`
      // rewraps a long `&&`/`||` chain in a shape no generator should try to
      // reproduce. The width here is MEASURED off the emitted string rather
      // than estimated from a prefix, and the wrapped form below is stable at
      // every arity (probed), so nothing depends on guessing.
      L(`${INDENT}if (!(e instanceof HttpClientError)) return false;`);
      L(`${INDENT}return (`);
      clauses.forEach((c, i) => {
        L(`${INDENT.repeat(2)}${c}${i === clauses.length - 1 ? '' : ' ||'}`);
      });
      L(`${INDENT});`);
    }
    L('}');
    L('');
  }

  // Pass 3 — the interface the factory returns.
  //
  // Without it `createApi` has an INFERRED return type, which JSR rejects as a
  // slow type: it blocks `.d.ts` generation, so a consumer could not publish a
  // package containing the generated file — while the file's own header tells
  // them not to edit it.
  L(`export interface ${apiTypeName} {`);
  for (const shape of shapes) {
    const params = shape.pathParams.map((p) => `${p.name}: ${p.type}`);
    if (shape.hasArgs) {
      params.push(`opts${shape.argsRequired ? '' : '?'}: ${shape.argsTypeName}`);
    }
    for (
      const line of renderSignature(
        INDENT,
        shape.entry.safeName,
        params,
        `: Promise<ClientResponse<${shape.returnType}>>;`,
      )
    ) L(line);
  }
  L('}');
  L('');

  L(`export function ${opts.factoryName}(client: IHttpClient): ${apiTypeName} {`);

  // Pass 4 — the method for each operation.
  const i1 = INDENT;
  const i2 = INDENT.repeat(2);
  const i3 = INDENT.repeat(3);
  const i4 = INDENT.repeat(4);
  for (const shape of shapes) {
    const { entry, returnType } = shape;
    // `opts` is accessed unconditionally when required, so no optional chain.
    const optsRef = shape.argsRequired ? 'opts' : 'opts?';

    if (shape !== shapes[0]) L('');
    L(`${i1}/** ${escapeBlockComment(entry.operationId)} */`);

    const paramList = shape.pathParams.map((p) => `${p.name}: ${p.type}`);
    if (shape.hasArgs) {
      paramList.push(`opts${shape.argsRequired ? '' : '?'}: ${shape.argsTypeName}`);
    }

    for (
      const line of renderSignature(
        i1,
        `function ${entry.safeName}`,
        paramList,
        `: Promise<ClientResponse<${returnType}>> {`,
      )
    ) L(line);

    L(`${i2}return client.request<${returnType}>({`);
    L(`${i3}method: '${entry.method.toUpperCase()}',`);
    for (const line of buildPathLiteral(entry.path, i3, 'path: ')) L(line);

    if (shape.queryParams.length) {
      // No cast: the arg field is already declared with this parameter's rendered
      // type, so it assigns to `ClientRequest.query` directly. A cast here would
      // silence nothing and would hide a genuinely unassignable query type.
      const qParts = shape.queryParams.map((p) =>
        `'${escapeSingleQuote(p.wireName)}': ${optsRef}.${p.name}`
      );
      L(`${i3}query: { ${qParts.join(', ')} },`);
    }
    if (shape.headerParams.length) {
      // Built in an IIFE rather than an object literal so an omitted optional
      // header is absent entirely instead of present-and-`undefined`, and so a
      // non-string header value (an `integer` schema) is stringified.
      L(`${i3}headers: (() => {`);
      L(`${i4}const headers: Record<string, string> = {};`);
      for (const p of shape.headerParams) {
        L(
          `${i4}if (${optsRef}.${p.name} !== undefined) {`,
        );
        L(
          `${i4}${INDENT}headers['${
            escapeSingleQuote(p.wireName)
          }'] = String(${optsRef}.${p.name});`,
        );
        L(`${i4}}`);
      }
      L(`${i4}return headers;`);
      L(`${i3}})(),`);
    }
    if (shape.bodyType !== undefined) {
      L(`${i3}json: ${optsRef}.body,`);
    }

    L(`${i2}});`);
    L(`${i1}}`);
  }

  L('');
  L(`${i1}return {`);
  for (const shape of shapes) {
    L(`${i2}${shape.entry.safeName},`);
  }
  L(`${i1}};`);
  L('}');
  L('');

  return lines.join('\n');
}
