/**
 * Zod to OpenAPI 3.1 schema transformer.
 *
 * Supports BOTH zod major versions: v3 is converted by the historical
 * `_def.typeName` recursion; v4 (whose private internals diverged —
 * `_def.typeName` is undefined on every node) is routed through
 * `schema.toJSONSchema()` and adapted from JSON Schema draft 2020-12 to
 * OpenAPI 3.1. Neither version is imported: detection is duck-typed, so the
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

type ZodDef = {
  typeName: string;
  [key: string]: unknown;
};

type ZodSchema = {
  _def: ZodDef;
  [key: string]: unknown;
};

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
 * Zod schema about to be transformed, on both majors.
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
 * Converts a Zod schema to an OpenAPI 3.1 schema object.
 *
 * Zod v3 and v4 are both supported, detected per schema by duck typing
 * (`toJSONSchema` presence marks v4). An unrecognized schema degrades to `{}`
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
   * @returns The OpenAPI schema object representation
   */
  transform(schema: unknown): OpenApiSchemaObject {
    // Consulted BEFORE the version dispatch, so a hook sees every node the
    // caller asked about — including one it may want to name even though this
    // transformer would degrade it to `{}`.
    const replacement = this.#onSchema?.(schema);
    if (replacement !== undefined) return replacement;

    // Zod v4: recognized by the public `toJSONSchema` method (its private
    // `_def.typeName` is gone, which is why the v3 recursion below cannot see
    // these nodes at all).
    const candidate = schema as Partial<Zod4SchemaLike> | undefined | null;
    if (typeof candidate?.toJSONSchema === 'function') {
      return this.#transformZod4(candidate as Zod4SchemaLike);
    }

    const zodSchema = schema as ZodSchema | undefined;

    // Check if it's a Zod schema by looking for _def
    if (!zodSchema?._def) {
      // Not a Zod schema, return empty schema
      this.#channels?.onUnrepresentable?.({ reason: 'not a recognized zod schema' });
      return {};
    }

    const def = zodSchema._def;
    const typeName = def.typeName;

    switch (typeName) {
      case 'ZodString':
        return this.transformString(zodSchema, def);
      case 'ZodNumber':
        return this.transformNumber(zodSchema, def);
      case 'ZodBoolean':
        return { type: 'boolean' };
      case 'ZodBigInt':
        return { type: 'integer' };
      case 'ZodArray':
        return this.transformArray(zodSchema, def);
      case 'ZodObject':
        return this.transformObject(zodSchema, def);
      case 'ZodOptional':
        return this.transformOptional(zodSchema, def);
      case 'ZodNullable':
        return this.transformNullable(zodSchema, def);
      case 'ZodEnum':
        return this.transformEnum(def);
      case 'ZodLiteral':
        return this.transformLiteral(def);
      case 'ZodUnion':
        return this.transformUnion(zodSchema, def);
      case 'ZodIntersection':
        return this.transformIntersection(zodSchema, def);
      case 'ZodRecord':
        return this.transformRecord(zodSchema, def);
      case 'ZodDate':
        return { type: 'string', format: 'date-time' };
      case 'ZodEffects':
        return this.transformEffects(zodSchema, def);
      case 'ZodPipeline':
        return this.transformPipeline(zodSchema, def);
      case 'ZodDefault':
        return this.transformDefault(zodSchema, def);
      default:
        // Unknown Zod type, return empty schema (graceful degradation)
        this.#channels?.onUnrepresentable?.({
          reason: `unsupported zod type ${String(typeName)}`,
        });
        return {};
    }
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
   * @returns The adapted OpenAPI schema object
   */
  #transformZod4(schema: Zod4SchemaLike): OpenApiSchemaObject {
    const previousRoot = this.#zod4ConversionRoot;
    this.#zod4ConversionRoot = schema;
    try {
      const js = schema.toJSONSchema({
        reused: 'ref',
        cycles: 'ref',
        io: 'output',
        unrepresentable: 'any',
        override: (ctx: Zod4OverrideContext) => this.#overrideZod4(ctx),
      });
      return this.#adaptDocument(js);
    } finally {
      this.#zod4ConversionRoot = previousRoot;
    }
  }

  /**
   * The `override` bridge. Consults the SAME hook the zod v3 path uses, keyed
   * on the real zod node identity, and splices any replacement into the
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
   * dialect key, the `$defs` section and root-cycle pointers passes through
   * verbatim. With definition channels attached, surviving `$defs` are
   * hoisted into `components/schemas` through the channels and their pointers
   * rewritten; a `$def` that a hook splice already turned into a bare alias
   * `$ref` is REMAPPED to its target and dropped rather than delivered as a
   * pointless one-key component. Without channels the `$defs` stay inline,
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
      const adapted = mapRefs(
        defs[key],
        (ref) =>
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

  private transformString(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'string' };
    // Zod uses 'kind' for the check type, not 'type'
    const checks = def.checks as
      | readonly { kind: string; value?: number | { value: number }; exact?: boolean }[]
      | undefined;

    if (checks) {
      for (const check of checks) {
        if (check.kind === 'email') {
          schema.format = 'email';
        } else if (check.kind === 'uri' || check.kind === 'url') {
          schema.format = 'uri';
        } else if (check.kind === 'uuid') {
          schema.format = 'uuid';
        } else if (check.kind === 'min') {
          // Zod 3.x stores min/max value as { value: number, message: string } or plain number
          const checkValue = check.value;
          const val = typeof checkValue === 'number'
            ? checkValue
            : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
            ? (checkValue as { value: number }).value
            : undefined;
          if (typeof val === 'number') schema.minLength = val;
        } else if (check.kind === 'max') {
          const checkValue = check.value;
          const val = typeof checkValue === 'number'
            ? checkValue
            : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
            ? (checkValue as { value: number }).value
            : undefined;
          if (typeof val === 'number') schema.maxLength = val;
        }
      }
    }

    return schema;
  }

  private transformNumber(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const schema: OpenApiSchemaObject = { type: 'number' };
    // Zod uses 'kind' for the check type, not 'type'
    const checks = def.checks as
      | readonly {
        kind: string;
        value?: number | { value: number; message: string };
        inclusive?: boolean;
      }[]
      | undefined;

    if (checks) {
      for (const check of checks) {
        const checkValue = check.value;
        const val = typeof checkValue === 'number'
          ? checkValue
          : (checkValue && typeof checkValue === 'object' && 'value' in checkValue)
          ? (checkValue as { value: number }).value
          : undefined;

        if (check.kind === 'min' && typeof val === 'number') {
          schema.minimum = val;
        } else if (check.kind === 'max' && typeof val === 'number') {
          schema.maximum = val;
        }
      }
    }

    return schema;
  }

  private transformArray(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const typeDef = def.type as ZodSchema | undefined;
    const schema: OpenApiSchemaObject = {
      type: 'array',
      items: typeDef ? this.transform(typeDef) : {},
    };

    // ZodArray stores min/max as { value: number, message: string } or just number or null
    const minLength = def.minLength as { value?: number } | number | null | undefined;
    const maxLength = def.maxLength as { value?: number } | number | null | undefined;

    const minVal = (minLength && typeof minLength === 'object' && minLength.value !== undefined)
      ? minLength.value
      : (typeof minLength === 'number' ? minLength : undefined);
    const maxVal = (maxLength && typeof maxLength === 'object' && maxLength.value !== undefined)
      ? maxLength.value
      : (typeof maxLength === 'number' ? maxLength : undefined);

    if (typeof minVal === 'number') {
      schema.minItems = minVal;
    }
    if (typeof maxVal === 'number') {
      schema.maxItems = maxVal;
    }

    return schema;
  }

  private transformObject(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const shapeFn = def.shape as (() => Record<string, ZodSchema>) | undefined;
    const shape = typeof shapeFn === 'function' ? shapeFn() : {};
    const properties: Record<string, OpenApiSchemaObject> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = this.transform(value);

      // A field is optional if it's ZodOptional OR ZodDefault (has a default value)
      const typeName = value._def?.typeName as string | undefined;
      const isOptional = typeName === 'ZodOptional' || typeName === 'ZodDefault';

      if (!isOptional) {
        required.push(key);
      }
    }

    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties,
    };

    if (required.length > 0) {
      schema.required = required;
    }

    const unknownKeys = def.unknownKeys as string | undefined;
    if (unknownKeys === 'passthrough') {
      schema.additionalProperties = true;
    }

    return schema;
  }

  private transformOptional(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerType = def.innerType as ZodSchema | undefined;
    return innerType ? this.transform(innerType) : {};
  }

  private transformNullable(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    // OpenAPI 3.1 (JSON Schema 2020-12) removed the 3.0 `nullable` keyword;
    // nullability is expressed via a `null` type. Represent it as
    // `anyOf: [<inner>, { type: 'null' }]`, which is valid 3.1 and preserves
    // the inner schema (plan §3.3: unwrap ZodNullable to its inner type).
    const innerType = def.innerType as ZodSchema | undefined;
    const innerSchema = innerType ? this.transform(innerType) : {};
    return { anyOf: [innerSchema, { type: 'null' as const }] };
  }

  private transformEnum(def: ZodDef): OpenApiSchemaObject {
    // ZodEnum stores values in def.values (array)
    const values = def.values as readonly string[] | undefined;

    if (values && Array.isArray(values)) {
      return { enum: [...values] };
    }

    // Fallback: try def.options
    const options = def.options as readonly string[] | undefined;
    if (options && Array.isArray(options)) {
      return { enum: [...options] };
    }

    return { enum: [] };
  }

  private transformLiteral(def: ZodDef): OpenApiSchemaObject {
    const value = def.value as string | number | boolean;
    return { const: value };
  }

  private transformUnion(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const options = def.options as readonly ZodSchema[] | undefined;
    return {
      anyOf: options ? options.map((option) => this.transform(option)) : [],
    };
  }

  private transformIntersection(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const left = def.left as ZodSchema | undefined;
    const right = def.right as ZodSchema | undefined;
    return {
      allOf: [
        left ? this.transform(left) : {},
        right ? this.transform(right) : {},
      ],
    };
  }

  private transformRecord(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const valueType = def.valueType as ZodSchema | undefined;
    return {
      type: 'object',
      additionalProperties: valueType ? this.transform(valueType) : {},
    };
  }

  private transformEffects(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerSchema = def.schema as ZodSchema | undefined;
    return innerSchema ? this.transform(innerSchema) : {};
  }

  private transformPipeline(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const outSchema = def.out as ZodSchema | undefined;
    return outSchema ? this.transform(outSchema) : {};
  }

  private transformDefault(_zodSchema: ZodSchema, def: ZodDef): OpenApiSchemaObject {
    const innerType = def.innerType as ZodSchema | undefined;
    const defaultValue = def.defaultValue as (() => unknown) | undefined;
    const schema = innerType ? this.transform(innerType) : {};
    if (defaultValue) {
      try {
        schema.default = defaultValue();
      } catch {
        // Ignore errors getting default value
      }
    }
    return schema;
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
