/**
 * Zod to OpenAPI 3.1 schema transformer.
 *
 * Supports zod >=4.6.6 <5 through its public `schema.toJSONSchema()`
 * method, adapted from JSON Schema draft 2020-12 to OpenAPI 3.1.
 * Zod is never imported: detection is duck-typed, so the
 * transformer stays dependency-free (AI_GUIDELINES §12.2).
 *
 * @module
 */

/**
 * OpenAPI 3.1 schema object.
 *
 * @since 0.1.0
 */
export interface OpenApiSchemaObject {
  /** Type of the value (string, number, integer, boolean, array, object, null). */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  /** Format (e.g., 'email', 'uri', 'uuid', 'date-time'). */
  format?: string;
  /** For arrays: schema of items. */
  items?: OpenApiSchemaObject;
  /** For objects: properties map. */
  properties?: Record<string, OpenApiSchemaObject>;
  /** For objects: required property names. */
  required?: readonly string[];
  /** For objects: additional properties schema. */
  additionalProperties?: boolean | OpenApiSchemaObject;
  /** For strings: minimum length. */
  minLength?: number;
  /** For strings: maximum length. */
  maxLength?: number;
  /** For numbers: minimum value. */
  minimum?: number;
  /** For numbers: maximum value. */
  maximum?: number;
  /** For numbers: exclusive minimum. */
  exclusiveMinimum?: number;
  /** For numbers: exclusive maximum. */
  exclusiveMaximum?: number;
  /** For arrays: minimum items. */
  minItems?: number;
  /** For arrays: maximum items. */
  maxItems?: number;
  /** Enum values. */
  enum?: readonly (string | number | boolean)[];
  /** Const value. */
  const?: string | number | boolean;
  /** AnyOf for unions. */
  anyOf?: readonly OpenApiSchemaObject[];
  /** AllOf for intersections. */
  allOf?: readonly OpenApiSchemaObject[];
  /** Default value. */
  default?: unknown;
  /** Reference to a component schema. */
  $ref?: string;
}

/**
 * A zod v4 schema, recognized structurally by its `toJSONSchema` method.
 * Declared with the exact parameter shape the converter accepts so the
 * adapter can drive it without importing zod.
 */
interface Zod4SchemaLike {
  toJSONSchema: (params?: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The context object zod v4 hands to its `override` callback: the ORIGINAL
 * zod schema node and the MUTABLE generated JSON-Schema node for it.
 */
interface Zod4OverrideContext {
  zodSchema: unknown;
  jsonSchema: Record<string, unknown>;
  path: (string | number)[];
}

/** Prefix zod v4 uses for its mechanical `$defs` pointers. */
const DEFS_REF_PREFIX = '#/$defs/';
/** Prefix of a component reference in the generated document. */
const COMPONENT_REF_PREFIX = '#/components/schemas/';

/**
 * Zod v4 def types that legitimately produce an EMPTY JSON-Schema node.
 * Any OTHER type ending up empty is unrepresentable and worth reporting.
 */
const LEGITIMATELY_EMPTY_TYPES: ReadonlySet<string> = new Set(['any', 'unknown']);

/**
 * Consulted for every schema {@linkcode ZodToOpenApi.transform} is about to
 * convert — the top-level one AND every sub-schema it recurses into.
 *
 * Returning `undefined` means "transform normally". Returning a schema object
 * REPLACES the transform for that node, which is how a document generator
 * substitutes a `$ref` to a reusable component without the transformer
 * knowing anything about components.
 *
 * On the zod v4 path the hook is bridged onto zod's own `override` callback,
 * which carries the original zod node — so the hook always receives the real
 * Zod schema about to be transformed.
 *
 * @param schema - The Zod schema about to be transformed
 * @returns A replacement schema object, or `undefined` to transform normally
 *
 * @since 0.3.0
 */
export type SchemaNodeHook = (schema: unknown) => OpenApiSchemaObject | undefined;

/**
 * Deletes every own enumerable key of `target` and assigns `source`'s keys in
 * place. Zod v4's `override` contract requires mutating `ctx.jsonSchema`
 * directly — swapping the reference would be discarded.
 *
 * @param target - The generated JSON-Schema node to overwrite
 * @param source - The replacement schema's keys
 */
function replaceOwnKeys(target: Record<string, unknown>, source: OpenApiSchemaObject): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/**
 * Reads the short def type name off a zod v4 schema (`'date'`, `'bigint'`,
 * `'object'`, …), for diagnostics only — never for dispatch.
 *
 * @param zodSchema - The zod v4 schema node
 * @returns The def type, or `'unknown'` when it cannot be read
 */
function zod4DefType(zodSchema: unknown): string {
  const def = (zodSchema as { _zod?: { def?: { type?: unknown } } })._zod?.def;
  return typeof def?.type === 'string' ? def.type : 'unknown';
}

/**
 * Walks a JSON-Schema tree collecting every `$ref` string, without copying.
 *
 * @param node - The node to walk
 * @param visit - Called once per `$ref` value found
 */
function collectRefs(node: unknown, visit: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') visit(value);
    else collectRefs(value, visit);
  }
}

/**
 * Copies a JSON-Schema tree, mapping every `$ref` through `map`.
 *
 * @param node - The node to copy
 * @param map - Applied to each `$ref` value
 * @returns The copied tree with rewritten references
 */
function mapRefs(node: unknown, map: (ref: string) => string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => mapRefs(item, map));
  }
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === '$ref' && typeof value === 'string' ? map(value) : mapRefs(value, map);
  }
  return out;
}

/**
 * Keywords whose value IS a schema. `items` is listed here because 2020-12
 * makes it a single schema; a pre-2020-12 document spelling it as a list is
 * still handled, so an adapted document never depends on the draft.
 */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Keywords whose value is a LIST of schemas. */
const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/** Keywords whose value maps author-chosen NAMES to schemas. */
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

/**
 * Whether a value can be walked as a name-to-schema map.
 *
 * @param value - The value found under a map-valued keyword
 * @returns `true` for a plain object whose values are worth visiting
 */
function isSchemaMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rewrites every collapsed `type` array into this transformer's canonical
 * `anyOf` spelling, in place and at any depth.
 *
 * Draft 2020-12 — and therefore OpenAPI 3.1 — permits both spellings of a
 * type union, and zod's public `toJSONSchema` changed which one it emits
 * across its v4 releases: through 4.4 every union became
 * `anyOf: [{ type: 'string' }, { type: 'null' }]`, and from 4.5 a
 * union whose every arm is a bare `{ type: X }` collapses to
 * `type: ['string', 'null']`. Measured on 4.4.3 against 4.5.4; an arm
 * carrying anything else (a constraint, a `format`, a `const`, an `items`)
 * keeps the `anyOf` spelling in both.
 *
 * Normalizing rather than passing the collapse through buys three things.
 * {@linkcode OpenApiSchemaObject.type} stays a single type name, which is only true
 * because nothing downstream of here can see an array. And `anyOf` is the
 * spelling OpenAPI 3.0 downgrade tooling understands, where a `type` array
 * is 3.1-only. Without it an application's zod PATCH version silently
 * decided whether a primitive union earned a `components/schemas` entry
 * (`isStructuralShape` keys on `anyOf`), so a regenerated SDK client changed
 * shape for no API reason — which is how this reached the weekly
 * dependency-drift gate (issue #253) rather than a pull request.
 *
 * The rewrite is lossless for ANY sibling set, including one no measured zod
 * version produces: sibling keywords stay on the outer object rather than
 * being distributed into the arms, and `anyOf` and (say) `minLength` are
 * independent assertions over the same instance exactly as `type` and
 * `minLength` were. Distributing them would instead apply a string
 * constraint to the `null` arm.
 *
 * @param node - The generated JSON-Schema tree, mutated in place
 */
function expandTypeUnions(node: unknown): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;

  // Descend ONLY into schema positions. A JSON Schema node mixes subschemas
  // with arbitrary instance data — `default`, `const`, `enum`, `examples` and
  // any vendor extension hold VALUES, not schemas — and walking those rewrote
  // application data: `z.object({ type: z.array(z.string()) }).default(…)`
  // emits `default: { type: ['primary', 'secondary'] }`, whose `type` key is a
  // field name holding a list of strings, not a type union. Recursing into it
  // replaced the user's default with `{ anyOf: [{ type: 'primary' }, … ] }`.
  for (const [keyword, value] of Object.entries(record)) {
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      // `items` is one schema in 2020-12 and a list in older drafts.
      if (Array.isArray(value)) {
        for (const item of value) expandTypeUnions(item);
      } else expandTypeUnions(value);
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
      for (const item of value) expandTypeUnions(item);
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isSchemaMap(value)) {
      // Keys here are author-chosen names, so every VALUE is a schema — a
      // property may legitimately be called `properties` or `type`.
      for (const item of Object.values(value)) expandTypeUnions(item);
    }
  }

  const type = record.type;
  if (!Array.isArray(type)) return;
  delete record.type;
  if (type.length === 1) {
    // A one-member union is a plain type, and `anyOf: [{ type: 'string' }]`
    // would be a noisier way to say `type: 'string'`. A sibling `anyOf` is no
    // problem here: a scalar `type` and an `anyOf` already conjoin.
    record.type = type[0];
    return;
  }
  // A zero-member union matches nothing, spelled `anyOf: []`.
  const arms = type.map((member) => ({ type: member }));
  if (record.anyOf === undefined) {
    record.anyOf = arms;
    return;
  }
  // `type` and a sibling `anyOf` are INDEPENDENT assertions over the same
  // instance, so the union cannot just take the `anyOf` key — that silently
  // drops the sibling. `allOf` is the keyword that conjoins, so the union
  // moves there and both survive.
  const existing = Array.isArray(record.allOf) ? record.allOf : [];
  record.allOf = [...existing, { anyOf: arms }];
}

/**
 * Which side of a schema a document site is describing.
 *
 * A zod schema has two shapes, and for anything carrying a `.default()`, a
 * `.transform()`, a `.coerce`, or the ordinary key-stripping of `z.object`,
 * they differ. `'input'` is what a client may SEND; `'output'` is what the
 * server holds after parsing. A request body, a query string, a path parameter
 * and a header are all `'input'`; a response body is `'output'`.
 *
 * Getting this wrong is not cosmetic — it makes a document contradict the
 * server it describes. Measured against zod 4.4 on the three object modes:
 *
 * | schema           | unknown key at runtime | `'output'` says          | `'input'` says   |
 * | ---------------- | ---------------------- | ------------------------ | ---------------- |
 * | `z.object`       | accepted, stripped     | `additionalProperties: false` | (absent)    |
 * | `z.strictObject` | rejected               | `additionalProperties: false` | `false`     |
 * | `z.looseObject`  | accepted, kept         | `additionalProperties: {}`    | `{}`        |
 *
 * — so on a REQUEST body the output view documents a restriction the server
 * does not apply, while a strict schema keeps its `false` under either view. A
 * `.default()` field is likewise `required` in the output view (the parsed
 * object always has it) and optional in the input view (the client may omit
 * it, which is what a default is FOR).
 *
 * @since 0.2.0
 */
export type SchemaIo = 'input' | 'output';

/**
 * Converts a Zod schema to an OpenAPI 3.1 schema object.
 *
 * Zod >=4.6.6 <5 is supported, detected by its public `toJSONSchema`
 * method. An unrecognized schema, including a legacy Zod v3 schema, degrades to `{}`
 * — never a throw — and, when a diagnostics channel is attached, reports what
 * it could not represent.
 *
 * @since 0.1.0
 */
export class ZodToOpenApi {
  /** Optional per-node hook; see {@linkcode SchemaNodeHook}. */
  readonly #onSchema: SchemaNodeHook | undefined;
  /**
   * Optional outbound channels. They exist so a document generator can hoist
   * surviving zod v4 `$defs` into `components/schemas` and learn about nodes
   * the transformer could not represent. Omitting them keeps every `$def`
   * INLINE with `#/$defs/…` pointers — valid draft 2020-12 ONLY while the
   * caller keeps the returned tree intact, `$defs` section included. A
   * consumer that embeds the fragment elsewhere (a parameter object, another
   * document) strands those pointers with no `$defs` to resolve against, so
   * attach these channels whenever the result is embedded rather than kept
   * self-contained.
   */
  readonly #channels:
    | {
        /** Claims a unique component name for a surviving `$def`. */
        readonly onDefinitionClaim?: (hint: string) => string;
        /** Delivers an adapted `$def` under the name claimed for it. */
        readonly onDefinition?: (name: string, schema: OpenApiSchemaObject) => void;
        /** Reports a node that could not be represented (still emits `{}`). */
        readonly onUnrepresentable?: (diagnostic: { readonly reason: string }) => void;
      }
    | undefined;
  /**
   * The root node of the zod v4 conversion currently running. Zod's
   * `override` callback fires for the ROOT too, and {@linkcode transform}
   * already consulted the hook for it on entry — consulting it twice would
   * double-count every top-level schema and falsely hoist single-use ones.
   * Saved/restored because hoisting a child re-enters {@linkcode transform}.
   */
  #zod4ConversionRoot: unknown = undefined;

  /**
   * Creates a transformer.
   *
   * @param onSchema - Optional hook consulted for every schema node, so a
   * caller can substitute a `$ref` for a reused schema at ANY depth rather
   * than only at the root. Omit it for a plain transform.
   * @param channels - Optional outbound channels for zod v4 `$defs` and
   * unrepresentable-node diagnostics. Entirely optional: without them the
   * zod v4 path still produces a complete, self-contained schema.
   */
  constructor(
    onSchema?: SchemaNodeHook,
    channels?: {
      readonly onDefinitionClaim?: (hint: string) => string;
      readonly onDefinition?: (name: string, schema: OpenApiSchemaObject) => void;
      readonly onUnrepresentable?: (diagnostic: { readonly reason: string }) => void;
    },
  ) {
    this.#onSchema = onSchema;
    this.#channels = channels;
  }

  /**
   * Transforms a Zod schema into an OpenAPI schema object.
   *
   * @param schema - The Zod schema to convert (unknown to accept any Zod schema)
   * @param io - Which side this site describes; see {@linkcode SchemaIo}.
   *   Defaults to `'output'`, so an existing single-argument call is unchanged
   * @returns The OpenAPI schema object representation
   */
  transform(schema: unknown, io: SchemaIo = 'output'): OpenApiSchemaObject {
    // Consulted BEFORE recognition, so a hook sees every node the
    // caller asked about — including one it may want to name even though this
    // transformer would degrade it to `{}`.
    const replacement = this.#onSchema?.(schema);
    if (replacement !== undefined) return replacement;

    // Recognize schemas by the public conversion method.
    const candidate = schema as Partial<Zod4SchemaLike> | undefined | null;
    if (typeof candidate?.toJSONSchema === 'function') {
      return this.#transformZod4(candidate as Zod4SchemaLike, io);
    }

    this.#channels?.onUnrepresentable?.({ reason: 'not a recognized zod schema' });
    return {};
  }

  /**
   * The zod v4 path: convert wholesale through `toJSONSchema()` with an
   * `override` callback that bridges the existing {@linkcode SchemaNodeHook},
   * then adapt the draft-2020-12 output to OpenAPI 3.1.
   *
   * `reused: 'ref'` is load-bearing: zod's `override` callback is SKIPPED for
   * occurrences of a reused schema after the first (colinhacks/zod#5499), so
   * per-site splicing alone cannot be trusted. With `reused: 'ref'` zod emits
   * mechanical `$defs` pointers for every occurrence beyond the first,
   * independent of `override`.
   *
   * @param schema - The duck-typed zod v4 schema
   * @param io - Which side this site describes; see {@linkcode SchemaIo}
   * @returns The adapted OpenAPI schema object
   */
  #transformZod4(schema: Zod4SchemaLike, io: SchemaIo): OpenApiSchemaObject {
    const previousRoot = this.#zod4ConversionRoot;
    this.#zod4ConversionRoot = schema;
    try {
      const js = schema.toJSONSchema({
        reused: 'ref',
        cycles: 'ref',
        io,
        unrepresentable: 'any',
        override: (ctx: Zod4OverrideContext) => this.#overrideZod4(ctx),
      });
      return this.#adaptDocument(js);
    } finally {
      this.#zod4ConversionRoot = previousRoot;
    }
  }

  /**
   * The `override` bridge. Consults the hook keyed on real zod node identity, and splices any replacement into the
   * mutable generated node. Nodes zod left EMPTY (its `unrepresentable: 'any'`
   * behavior) are reported through the diagnostics channel — zod v4.4 offers
   * no handler form for this, so the empty node IS the signal.
   *
   * @param ctx - The zod v4 override context
   */
  #overrideZod4(ctx: Zod4OverrideContext): void {
    // The conversion ROOT was already consulted by `transform` on entry;
    // consulting it again here would double-count it.
    const isConversionRoot = ctx.zodSchema === this.#zod4ConversionRoot;
    const replacement = isConversionRoot ? undefined : this.#onSchema?.(ctx.zodSchema);
    if (replacement !== undefined) {
      replaceOwnKeys(ctx.jsonSchema, replacement);
      return;
    }
    if (
      Object.keys(ctx.jsonSchema).length === 0 &&
      !LEGITIMATELY_EMPTY_TYPES.has(zod4DefType(ctx.zodSchema))
    ) {
      this.#channels?.onUnrepresentable?.({
        reason: `zod v4 type '${zod4DefType(ctx.zodSchema)}' has no JSON Schema representation`,
      });
    }
  }

  /**
   * Adapts a draft-2020-12 document to OpenAPI 3.1 (design rows R1–R10).
   *
   * OpenAPI 3.1's Schema Object IS draft 2020-12, so everything except the
   * dialect key, collapsed `type` arrays, the `$defs` section and root-cycle
   * pointers passes through verbatim. With definition channels attached,
   * surviving `$defs` are hoisted into `components/schemas` through the
   * channels and their pointers rewritten; a `$def` that a hook splice already
   * turned into a bare alias `$ref` is REMAPPED to its target and dropped
   * rather than delivered as a pointless one-key component. Without channels
   * the `$defs` stay inline,
   * which is self-contained only while the caller keeps the whole returned
   * tree intact — see the {@linkcode ZodToOpenApi} constructor note. The
   * document generator always attaches channels (both its deduplicating and
   * its parameter-site transformer), so this plain path is reachable only by
   * a direct `ZodToOpenApi` consumer.
   *
   * A `$ref: '#'` (zod breaks root cycles with a document-root pointer) forces
   * the whole schema to be hoisted under a claimed component name, because an
   * inline operation schema cannot carry a meaningful document-root pointer.
   *
   * @param root - The generated draft-2020-12 document (mutated)
   * @returns The adapted OpenAPI schema object
   */
  #adaptDocument(root: Record<string, unknown>): OpenApiSchemaObject {
    // R1: the document declares `openapi: '3.1.0'`; a per-node dialect key is
    // noise some tooling mis-nests.
    delete root.$schema;

    // Before the channel branch and before `$defs` is detached, so the one
    // walk reaches the main tree AND every definition — and both return
    // paths, the plain one and the hoisting one, are normalized.
    expandTypeUnions(root);

    const claim = this.#channels?.onDefinitionClaim;
    const deliver = this.#channels?.onDefinition;

    if (claim === undefined || deliver === undefined) {
      // Plain path: keep `$defs` inline and any `'#'` cycle pointer as-is.
      return root as unknown as OpenApiSchemaObject;
    }

    // A document with no reused schemas carries no `$defs` at all; the root
    // force-hoist below must still apply to it.
    const defs = (root.$defs ?? {}) as Record<string, Record<string, unknown>>;
    delete root.$defs;

    // Alias resolution: a hook splice lands INSIDE the mechanical $def (both
    // occurrences point at it), so a hooked def becomes a bare `$ref` to a
    // components entry. Those defs are dropped and their pointers remapped.
    const aliases = new Map<string, string>();
    const resolving = new Set<string>();
    const resolveAlias = (key: string): string | undefined => {
      const known = aliases.get(key);
      if (known !== undefined) return known;
      if (resolving.has(key)) return undefined;
      const raw = defs[key];
      const ref = raw && typeof raw.$ref === 'string' ? raw.$ref : undefined;
      if (ref === undefined) return undefined;
      let target: string | undefined;
      resolving.add(key);
      if (ref.startsWith(COMPONENT_REF_PREFIX)) target = ref;
      else if (ref.startsWith(DEFS_REF_PREFIX)) {
        target = resolveAlias(ref.slice(DEFS_REF_PREFIX.length));
      }
      resolving.delete(key);
      if (target !== undefined) aliases.set(key, target);
      return target;
    };
    for (const key of Object.keys(defs)) resolveAlias(key);

    // Reachability: only defs the main tree (transitively) points at survive;
    // everything else would be an orphaned component.
    const reachable = new Set<string>();
    const queue: string[] = [];
    collectRefs(root, (ref) => {
      if (ref.startsWith(DEFS_REF_PREFIX)) queue.push(ref.slice(DEFS_REF_PREFIX.length));
    });
    while (queue.length > 0) {
      const key = queue.pop();
      if (key === undefined || reachable.has(key) || aliases.has(key)) continue;
      reachable.add(key);
      collectRefs(defs[key], (ref) => {
        if (ref.startsWith(DEFS_REF_PREFIX)) queue.push(ref.slice(DEFS_REF_PREFIX.length));
      });
    }

    // Claim names BEFORE adapting content: defs can be mutually referential
    // (a nested cyclic subschema becomes a self-referencing $def), so a name
    // must never depend on the content being finished.
    const claimed = new Map<string, string>();
    for (const key of reachable) {
      if (!aliases.has(key)) claimed.set(key, claim(key));
    }
    const refTargetFor = (key: string): string => {
      const alias = aliases.get(key);
      if (alias !== undefined) return alias;
      return `${COMPONENT_REF_PREFIX}${claimed.get(key)}`;
    };

    // Deliver each surviving def with its internal pointers rewritten.
    for (const [key, name] of claimed) {
      const adapted = mapRefs(defs[key], (ref) =>
        ref.startsWith(DEFS_REF_PREFIX) ? refTargetFor(ref.slice(DEFS_REF_PREFIX.length)) : ref,
      );
      deliver(name, adapted as unknown as OpenApiSchemaObject);
    }

    // Rewrite the main tree. A root-cycle `'#'` pointer force-hoists the whole
    // schema (R7): claim the name first, rewrite the pointer, deliver the
    // component and hand the caller a `$ref` instead.
    let sawRootCycle = false;
    collectRefs(root, (ref) => {
      if (ref === '#') sawRootCycle = true;
    });
    const rootName = sawRootCycle ? claim('Schema') : undefined;

    const mapped = mapRefs(root, (ref) => {
      if (ref === '#' && rootName !== undefined) {
        return `${COMPONENT_REF_PREFIX}${rootName}`;
      }
      if (ref.startsWith(DEFS_REF_PREFIX)) {
        return refTargetFor(ref.slice(DEFS_REF_PREFIX.length));
      }
      return ref;
    });

    if (rootName !== undefined) {
      deliver(rootName, mapped as unknown as OpenApiSchemaObject);
      return { $ref: `${COMPONENT_REF_PREFIX}${rootName}` };
    }
    return mapped as unknown as OpenApiSchemaObject;
  }
}

/**
 * Convenience function for one-off Zod to OpenAPI conversion.
 *
 * @param schema - The Zod schema to convert
 * @returns The OpenAPI schema object
 * @since 0.1.0
 */
export function zodToOpenApi(schema: unknown): OpenApiSchemaObject {
  return new ZodToOpenApi().transform(schema);
}
