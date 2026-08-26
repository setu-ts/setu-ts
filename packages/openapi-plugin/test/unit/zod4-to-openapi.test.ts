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
import { z as z4 } from 'npm:zod@^4.4.0';
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
