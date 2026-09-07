/**
 * Zod v4 to OpenAPI transformer tests (fix A9-1).
 *
 * Zod v4 diverges from v3 on every private-internal node (`_def.typeName` is
 * undefined), so the transformer used to fall through to `{}` for EVERY
 * zod-4 schema. These tests pin the zod-4 path: `schema.toJSONSchema()` with
 * an `override` bridge onto {@linkcode SchemaNodeHook}, adapted from JSON
 * Schema 2020-12 to OpenAPI 3.1, plus the `x-setu-unrepresentable`
 * diagnostics channel for nodes zod cannot represent.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z as z3Floor } from 'npm:zod@3.24.0';
import { z as z4 } from 'npm:zod@^4.4.0';
import { z as z4Floor } from 'npm:zod@4.4.0';
// Pinned, not ranged: 4.5 is the first version that collapses a union of bare
// types into a `type` array, and the case must not go vacuous on a lockfile
// that resolves 4.4.x. See the `issue #253` block.
import { z as z4Collapsing } from 'npm:zod@4.5.4';
import { z as z3 } from 'npm:zod@^3.24.0';

import type { OpenApiSchemaObject, SchemaNodeHook } from '../../src/transformers/zod-to-openapi.ts';
import { ZodToOpenApi } from '../../src/transformers/zod-to-openapi.ts';

describe('ZodToOpenApi — zod v4 (plain transform)', () => {
  it('populates an object body instead of the silent `{}`', () => {
    const result = new ZodToOpenApi().transform(z4.object({ id: z4.string() }));

    expect(result).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('drops the root `$schema` dialect key (R1)', () => {
    const result = new ZodToOpenApi().transform(z4.object({ id: z4.string() }));
    expect('$schema' in result).toBe(false);
  });

  it('passes formats and string constraints through verbatim (R2/R3)', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({
        email: z4.string().email(),
        id: z4.string().uuid(),
        when: z4.string().datetime(),
        name: z4.string().min(2).max(10),
      }),
    ) as { properties: Record<string, OpenApiSchemaObject> };

    expect(result.properties.email.format).toBe('email');
    expect(result.properties.id.format).toBe('uuid');
    expect(result.properties.when.format).toBe('date-time');
    expect(result.properties.name.minLength).toBe(2);
    expect(result.properties.name.maxLength).toBe(10);
  });

  it('maps numbers and integers with bounds', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({ n: z4.number().min(1).max(9), i: z4.number().int() }),
    ) as { properties: Record<string, OpenApiSchemaObject> };

    expect(result.properties.n.minimum).toBe(1);
    expect(result.properties.n.maximum).toBe(9);
    expect(result.properties.i.type).toBe('integer');
  });

  it('maps enums with their values', () => {
    const result = new ZodToOpenApi().transform(z4.object({ c: z4.enum(['a', 'b', 'c']) }));
    expect((result.properties?.c as OpenApiSchemaObject).enum).toEqual(['a', 'b', 'c']);
  });

  it('maps arrays with items and item bounds', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({ tags: z4.array(z4.string()).min(1).max(5) }),
    ) as OpenApiSchemaObject & { $defs?: Record<string, unknown> };
    const tags = result.properties?.tags as OpenApiSchemaObject;
    expect(tags.type).toBe('array');
    expect(tags.minItems).toBe(1);
    expect(tags.maxItems).toBe(5);
    // A single-use element may be extracted into an inline `$defs` entry on
    // the plain path; either shape must carry a usable element schema.
    const items = tags.items as OpenApiSchemaObject;
    if (items.$ref !== undefined) {
      expect(items.$ref).toMatch(/^#\/\$defs\//);
      expect(result.$defs).toBeDefined();
    } else {
      expect(items).toEqual({ type: 'string' });
    }
  });

  it('keeps optional fields out of `required` and maps nullable/unions', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({
        req: z4.string(),
        opt: z4.string().optional(),
        maybe: z4.string().nullable(),
        either: z4.union([z4.string(), z4.number()]),
      }),
    );

    // Zod v4 semantics: an OPTIONAL field leaves `required`, but a nullable
    // or union field is still required — it just permits more types.
    //
    // The two `anyOf` assertions below are a guarantee of THIS transformer,
    // not a pass-through of whichever spelling zod chose. Both encodings of a
    // type union are legal draft 2020-12, and zod switched between them
    // inside the declared `>=4.4.0 <5` range — 4.5 collapses a union of bare
    // types to `type: ['string', 'null']` — so `expandTypeUnions` normalizes
    // it back. Do not relax these to accept either encoding: that would let
    // an application's zod patch version decide the document's shape, which
    // is the defect issue #253 reported.
    expect(result.required).toEqual(['req', 'maybe', 'either']);
    expect(result.properties?.maybe).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(result.properties?.either).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('maps records, literals and defaults', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({
        flags: z4.record(z4.string(), z4.boolean()),
        kind: z4.literal('v'),
        withDefault: z4.string().default('x'),
      }),
    );

    expect(result.properties?.flags).toEqual({
      type: 'object',
      propertyNames: { type: 'string' },
      additionalProperties: { type: 'boolean' },
    });
    expect(result.properties?.kind).toEqual({ type: 'string', const: 'v' });
    expect((result.properties?.withDefault as OpenApiSchemaObject).default).toBe('x');
  });

  it('degrades unrepresentable nodes to `{}` without throwing', () => {
    const result = new ZodToOpenApi().transform(
      z4.object({ when: z4.date(), big: z4.bigint(), plain: z4.string() }),
    );

    expect(result.properties?.when).toEqual({});
    expect(result.properties?.big).toEqual({});
    expect(result.properties?.plain).toEqual({ type: 'string' });
  });

  it('reports unrepresentable nodes through the injected channel while still returning `{}`', () => {
    const reasons: string[] = [];
    const transformer = new ZodToOpenApi(undefined, {
      onUnrepresentable: (diagnostic) => reasons.push(diagnostic.reason),
    });

    const result = transformer.transform(z4.object({ when: z4.date() }));

    expect(result.properties?.when).toEqual({});
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain('date');
  });

  it('does NOT report legitimately empty schemas (`any`/`unknown`) as unrepresentable', () => {
    const reasons: string[] = [];
    const transformer = new ZodToOpenApi(undefined, {
      onUnrepresentable: (diagnostic) => reasons.push(diagnostic.reason),
    });

    transformer.transform(z4.object({ anything: z4.any(), whatever: z4.unknown() }));

    expect(reasons).toEqual([]);
  });

  it('retains `$defs` inline with `#/$defs/…` pointers when no definition channel is attached (R6 fallback)', () => {
    const address = z4.object({ city: z4.string() });
    const person = z4.object({ home: address, billing: address });

    const result = new ZodToOpenApi().transform(person) as OpenApiSchemaObject & {
      $defs?: Record<string, unknown>;
    };

    expect(result.properties?.home).toEqual({ $ref: '#/$defs/__schema0' });
    const defs = result.$defs as Record<string, unknown>;
    expect(defs.__schema0).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });
  });

  it('rewrites cycle refs by force-hoisting the root when a definition channel is attached (R7)', () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const Tree: z4.ZodType<Node> = z4.lazy(() =>
      z4.object({ name: z4.string(), children: z4.array(Tree) })
    );

    const delivered: { name: string; schema: OpenApiSchemaObject }[] = [];
    const transformer = new ZodToOpenApi(undefined, {
      onDefinitionClaim: () => `Component${delivered.length + 1}`,
      onDefinition: (_name, schema) => {
        delivered.push({ name: _name, schema });
      },
    });

    const result = transformer.transform(Tree);

    // The root was hoisted and the caller got a `$ref`; no bare `'#'` survives.
    expect(result).toEqual({ $ref: '#/components/schemas/Component1' });
    expect(JSON.stringify(delivered)).not.toContain('"$ref":"#"');
    expect(delivered).toHaveLength(1);
    const root = delivered[0].schema as {
      properties?: Record<string, OpenApiSchemaObject>;
    };
    expect(root.properties?.name).toEqual({ type: 'string' });
    expect(root.properties?.children).toBeDefined();
  });
});

describe('ZodToOpenApi — collapsed `type` arrays (issue #253)', () => {
  /**
   * A schema that duck-types as zod v4 and returns a fixed document.
   *
   * These cases drive the normalization through the PUBLIC surface without
   * depending on which zod the lockfile resolves: the collapsed spelling only
   * appears from 4.5, so with a 4.4 lock every one of them would otherwise be
   * dead. The documents below are the real 4.5.4 output, measured — see the
   * real-zod pin at the end of this block, which is what keeps this fake
   * honest.
   */
  const zod4Like = (document: Record<string, unknown>) => ({
    toJSONSchema: () => structuredClone(document),
  });

  it('rewrites a nullable primitive into `anyOf`', () => {
    const result = new ZodToOpenApi().transform(
      zod4Like({ type: ['string', 'null'] }),
    );

    expect(result).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });

  it('preserves arm order for a union of more than two types', () => {
    const result = new ZodToOpenApi().transform(
      zod4Like({ type: ['string', 'number', 'boolean'] }),
    );

    expect(result).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    });
  });

  it('keeps sibling keywords on the outer object rather than distributing them', () => {
    // Distributing `minLength` into the arms would assert a string constraint
    // on the `null` arm. Kept outside, `anyOf` and `minLength` are
    // independent assertions over the same instance — exactly as `type` and
    // `minLength` were before the rewrite.
    const result = new ZodToOpenApi().transform(
      zod4Like({ type: ['string', 'null'], minLength: 2, default: 'x' }),
    );

    expect(result).toEqual({
      minLength: 2,
      default: 'x',
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('spells a one-member array as a plain type', () => {
    const result = new ZodToOpenApi().transform(zod4Like({ type: ['string'] }));

    expect(result).toEqual({ type: 'string' });
  });

  it('spells a zero-member array as `anyOf: []`, agreeing with the v3 empty union', () => {
    const result = new ZodToOpenApi().transform(zod4Like({ type: [] }));

    expect(result).toEqual({ anyOf: [] });
    // The v3 path's own spelling for an option-less union, so the two agree.
    expect(result).toEqual(
      new ZodToOpenApi().transform({ _def: { typeName: 'ZodUnion', options: undefined } }),
    );
  });

  it('rewrites at every depth — properties, items and `$defs`', () => {
    const result = new ZodToOpenApi().transform(
      zod4Like({
        type: 'object',
        properties: {
          maybe: { type: ['string', 'null'] },
          list: { type: 'array', items: { type: ['number', 'null'] } },
          reused: { $ref: '#/$defs/__schema0' },
        },
        required: ['maybe', 'list', 'reused'],
        $defs: { __schema0: { type: ['boolean', 'null'] } },
      }),
    ) as OpenApiSchemaObject & { $defs?: Record<string, OpenApiSchemaObject> };

    const properties = result.properties ?? {};
    expect(properties.maybe).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(properties.list.items).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
    // No definition channels attached, so `$defs` stays inline (R6 fallback)
    // — and the walk must have reached inside it all the same.
    expect(result.$defs?.__schema0).toEqual({
      anyOf: [{ type: 'boolean' }, { type: 'null' }],
    });
  });

  it('rewrites inside a hoisted definition on the channel path', () => {
    // The channel path detaches `$defs` and re-delivers each definition, so a
    // rewrite applied only to the main tree would miss every component.
    const delivered: { name: string; schema: OpenApiSchemaObject }[] = [];
    const result = new ZodToOpenApi(undefined, {
      onDefinitionClaim: (hint) => `Component-${hint}`,
      onDefinition: (name, schema) => delivered.push({ name, schema }),
    }).transform(
      zod4Like({
        type: 'object',
        properties: {
          a: { $ref: '#/$defs/__schema0' },
          b: { $ref: '#/$defs/__schema0' },
        },
        required: ['a', 'b'],
        $defs: { __schema0: { type: 'object', properties: { n: { type: ['string', 'null'] } } } },
      }),
    ) as OpenApiSchemaObject;

    expect(delivered.length).toBe(1);
    const hoisted = delivered[0].schema.properties ?? {};
    expect(hoisted.n).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(result.properties?.a).toEqual({ $ref: '#/components/schemas/Component-__schema0' });
  });

  it('leaves a schema that already spells its union as `anyOf` untouched', () => {
    const already = { anyOf: [{ type: 'string' }, { type: 'null' }] };

    expect(new ZodToOpenApi().transform(zod4Like(already))).toEqual(already);
  });

  it('emits `anyOf` from a REAL zod that collapses the spelling (4.5)', () => {
    // The fake above asserts the rewrite; this asserts the rewrite is aimed
    // at something real. Pinned at 4.5.4 rather than resolved through
    // `^4.4.0`, so the case survives a lockfile that resolves 4.4.x — where
    // zod emits `anyOf` itself and the assertion would pass vacuously.
    const result = new ZodToOpenApi().transform(
      z4Collapsing.object({
        maybe: z4Collapsing.string().nullable(),
        either: z4Collapsing.union([z4Collapsing.string(), z4Collapsing.number()]),
      }),
    ) as { properties?: Record<string, OpenApiSchemaObject> };

    expect(result.properties?.maybe).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(result.properties?.either).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('agrees byte for byte with the zod version that does NOT collapse (4.4)', () => {
    // The property the normalization exists for: one schema, one document,
    // whichever zod inside the declared range the application brings.
    // The schema is written once per namespace rather than passed to a
    // shared builder: the two installs carry their own version in their
    // types (the compiler rejects the cast with `minor: 4 is not comparable
    // to 5`), which is also the evidence that these really are two libraries.
    const collapsing = new ZodToOpenApi().transform(
      z4Collapsing.object({
        maybe: z4Collapsing.string().nullable(),
        either: z4Collapsing.union([z4Collapsing.string(), z4Collapsing.number()]),
        constrained: z4Collapsing.string().min(2).nullable(),
      }),
    );
    const floor = new ZodToOpenApi().transform(
      z4Floor.object({
        maybe: z4Floor.string().nullable(),
        either: z4Floor.union([z4Floor.string(), z4Floor.number()]),
        constrained: z4Floor.string().min(2).nullable(),
      }),
    );

    expect(JSON.stringify(collapsing)).toBe(JSON.stringify(floor));
  });
});

describe('ZodToOpenApi — declared Zod range floors', () => {
  it('transforms the supported Zod v3.24.0 floor', () => {
    const result = new ZodToOpenApi().transform(
      z3Floor.object({ id: z3Floor.string() }),
    ) as { properties?: Record<string, OpenApiSchemaObject> };

    expect(result.properties?.id).toEqual({ type: 'string' });
  });

  it('transforms the supported Zod v4.4.0 floor', () => {
    const result = new ZodToOpenApi().transform(
      z4Floor.object({ id: z4Floor.string() }),
    ) as { properties?: Record<string, OpenApiSchemaObject> };

    expect(result.properties?.id).toEqual({ type: 'string' });
  });
});

describe('ZodToOpenApi — zod v3 byte-identity pins', () => {
  // The zod-4 work must not move a single byte of the zod-3 output. These
  // three pins assert EXACT equality with the pre-fix shapes.
  it('pins a plain object', () => {
    expect(new ZodToOpenApi().transform(z3.object({ name: z3.string() }))).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('pins a constrained string', () => {
    expect(new ZodToOpenApi().transform(z3.string().email().min(5))).toEqual({
      type: 'string',
      format: 'email',
      minLength: 5,
    });
  });

  it('pins optional handling', () => {
    expect(
      new ZodToOpenApi().transform(z3.object({ n: z3.number().optional() })),
    ).toEqual({
      type: 'object',
      properties: { n: { type: 'number' } },
    });
  });
});

describe('ZodToOpenApi — diagnostics on the zod v3 arms', () => {
  it('reports an unrecognized zod v3 type through the channel while still returning `{}`', () => {
    const reasons: string[] = [];
    const transformer = new ZodToOpenApi(undefined, {
      onUnrepresentable: (diagnostic) => reasons.push(diagnostic.reason),
    });

    const unknownZod3 = { _def: { typeName: 'ZodSomeFutureType' } };
    expect(transformer.transform(unknownZod3)).toEqual({});
    expect(reasons).toEqual(['unsupported zod type ZodSomeFutureType']);
  });

  it('reports a non-zod input through the channel while still returning `{}`', () => {
    const reasons: string[] = [];
    const transformer = new ZodToOpenApi(undefined, {
      onUnrepresentable: (diagnostic) => reasons.push(diagnostic.reason),
    });

    expect(transformer.transform('not a schema')).toEqual({});
    expect(reasons).toEqual(['not a recognized zod schema']);
  });

  it('falls back to `def.options` when a zod v3 enum carries no `values`', () => {
    const optionsEnum = { _def: { typeName: 'ZodEnum', options: ['a', 'b'] } };
    expect(new ZodToOpenApi().transform(optionsEnum)).toEqual({ enum: ['a', 'b'] });
  });
});

describe('ZodToOpenApi — hook bridge over the zod v4 path', () => {
  it('lets the hook replace a reused node inside the generated tree', () => {
    // With `reused: 'ref'`, both occurrences of Address become refs to one
    // mechanical $def; the hook splice lands INSIDE that def, so every site
    // ends up pointing at the hook's component.
    const address = z4.object({ city: z4.string() });
    const person = z4.object({ home: address, billing: address });

    const hook: SchemaNodeHook = (schema) =>
      schema === address ? { $ref: '#/components/schemas/Address' } : undefined;

    const result = new ZodToOpenApi(hook).transform(person) as OpenApiSchemaObject & {
      $defs?: Record<string, unknown>;
    };

    expect(result.properties?.home).toEqual({ $ref: '#/$defs/__schema0' });
    // The def itself became the alias the hook spliced in.
    expect(result.$defs).toEqual({ __schema0: { $ref: '#/components/schemas/Address' } });
  });

  it('still transforms normally when the hook answers `undefined`', () => {
    const result = new ZodToOpenApi(() => undefined).transform(
      z4.object({ id: z4.string() }),
    );

    expect(result).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });
});
