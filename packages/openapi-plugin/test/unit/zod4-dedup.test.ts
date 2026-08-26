/**
 * Zod v4 generator-level tests (fix A9-1): cross-route dedup, nested reuse,
 * `addSchema` interop, and the `x-setu-unrepresentable` operation annotation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z as z4 } from 'npm:zod@^4.4.0';
import type { RouteInfo } from '@setu-ts/common';

import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';

function route(
  method: RouteInfo['method'],
  path: string,
  schema: RouteInfo['definition']['schema'],
): RouteInfo {
  return {
    method,
    path,
    definition: {
      handler: () => {
        throw new Error('not used');
      },
      ...(schema === undefined ? {} : { schema }),
    },
  };
}

const generator = () => new OpenApiGenerator({ title: 'T', version: '1' });

function bodySchema(
  doc: ReturnType<OpenApiGenerator['generate']>,
  path: string,
): unknown {
  return doc.paths[path]?.post?.requestBody?.content['application/json'].schema;
}

function responseSchema(
  doc: ReturnType<OpenApiGenerator['generate']>,
  path: string,
  status: string,
): unknown {
  return doc.paths[path]?.get?.responses[status]?.content?.['application/json']?.schema;
}

describe('OpenApiGenerator — zod v4 dedup', () => {
  it('dedups a zod v4 body reused across two routes into ONE component', () => {
    const shared = z4.object({ id: z4.string(), qty: z4.number() });
    const doc = generator().generate([
      route('POST', '/a', { body: shared }),
      route('POST', '/b', { body: shared }),
    ]);

    expect(bodySchema(doc, '/a')).toEqual({ $ref: '#/components/schemas/PostABody' });
    expect(bodySchema(doc, '/b')).toEqual({ $ref: '#/components/schemas/PostABody' });
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(['PostABody']);
    expect(doc.components?.schemas?.PostABody).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, qty: { type: 'number' } },
      required: ['id', 'qty'],
      additionalProperties: false,
    });
  });

  it('hoists a zod v4 subschema nested in two different parents', () => {
    const inner = z4.object({ v: z4.string() });
    const doc = generator().generate([
      route('GET', '/a', { response: { 200: z4.object({ one: inner }) } }),
      route('GET', '/b', { response: { 200: z4.object({ two: inner }) } }),
    ]);

    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names.length).toBeGreaterThanOrEqual(1);
    // Both sites reference the SAME hoisted child component.
    const refA = (responseSchema(doc, '/a', '200') as { properties?: Record<string, unknown> })
      .properties?.one;
    const refB = (responseSchema(doc, '/b', '200') as { properties?: Record<string, unknown> })
      .properties?.two;
    expect(refA).toEqual(refB);
    const name = ((refA as { $ref?: string }).$ref ?? '').split('/').pop();
    expect((refA as { $ref?: string }).$ref).toMatch(/^#\/components\/schemas\//);
    expect(name).toBeTruthy();
    expect(doc.components?.schemas?.[name as string]).toEqual({
      type: 'object',
      properties: { v: { type: 'string' } },
      required: ['v'],
      additionalProperties: false,
    });
  });

  it('honors a contributor-chosen addSchema name for a zod v4 schema', () => {
    const gen = generator();
    const named = z4.object({ id: z4.string() });
    gen.addSchema('Widget', named);
    const doc = gen.generate([route('GET', '/x', { response: { 200: named } })]);

    expect(responseSchema(doc, '/x', '200')).toEqual({
      $ref: '#/components/schemas/Widget',
    });
    expect(doc.components?.schemas?.Widget).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('hoists a mechanical $def into components when zod extracts reused subschemas', () => {
    // Zod v4 (`reused: 'ref'`) extracts every occurrence beyond the first of
    // a reused child into a mechanical $def; the generator claims a component
    // name for it and rewrites the pointers.
    const address = z4.object({ city: z4.string() });
    const doc = generator().generate([
      route('POST', '/people', {
        body: z4.object({ home: address, billing: address }),
      }),
    ]);

    const body = bodySchema(doc, '/people') as {
      properties?: Record<string, { $ref?: string }>;
    };
    const homeRef = body.properties?.home?.$ref ?? '';
    const billingRef = body.properties?.billing?.$ref ?? '';
    expect(homeRef).toMatch(/^#\/components\/schemas\//);
    expect(billingRef).toBe(homeRef);
    const name = homeRef.split('/').pop()!;
    expect(doc.components?.schemas?.[name]).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });
    // No mechanical `__schema<n>` names leak into the document.
    for (const componentName of Object.keys(doc.components?.schemas ?? {})) {
      expect(componentName).not.toContain('__schema');
    }
  });

  it('reserves a DISTINCT component name for each of TWO reused schemas in one body', () => {
    // THE DEFECT: `#claimComponentName()` checked only delivered components,
    // but one zod v4 conversion claims every surviving $def BEFORE delivering
    // any — so A's def and B's def were both claimed `PostXBody` and the
    // second delivery silently overwrote the first, leaving b1/b2 pointing at
    // A's shape (or vice versa).
    const A = z4.object({ a: z4.string() });
    const B = z4.object({ b: z4.string() });
    const doc = generator().generate([
      route('POST', '/x', { body: z4.object({ a1: A, a2: A, b1: B, b2: B }) }),
    ]);

    // Exactly two components survive — one per distinct reused schema.
    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names).toHaveLength(2);

    const body = bodySchema(doc, '/x') as {
      properties?: Record<string, { $ref?: string }>;
    };
    const refOf = (field: string): string => body.properties?.[field]?.$ref ?? '';
    expect(refOf('a1')).toBe(refOf('a2'));
    expect(refOf('b1')).toBe(refOf('b2'));
    expect(refOf('a1')).not.toBe(refOf('b1'));

    // Each pair resolves to ITS OWN schema's component, not the other's.
    const aName = refOf('a1').split('/').pop()!;
    const bName = refOf('b1').split('/').pop()!;
    expect(doc.components?.schemas?.[aName]).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(doc.components?.schemas?.[bName]).toEqual({
      type: 'object',
      properties: { b: { type: 'string' } },
      required: ['b'],
      additionalProperties: false,
    });
  });

  it('drops a $def that a hook splice already turned into an alias', () => {
    // When the hook replaces a REUSED node, the splice lands INSIDE the
    // mechanical $def, turning it into a bare `$ref` to the hook's component.
    // The adapter must remap every pointer to that component and drop the
    // would-be one-key alias.
    const address = z4.object({ city: z4.string() });
    const gen = new OpenApiGenerator({ title: 'T', version: '1' });
    gen.addSchema('Address', address);
    const doc = gen.generate([
      route('POST', '/people', {
        body: z4.object({ home: address, billing: address }),
      }),
    ]);

    const body = bodySchema(doc, '/people') as {
      properties?: Record<string, { $ref?: string }>;
    };
    expect(body.properties?.home).toEqual({ $ref: '#/components/schemas/Address' });
    expect(body.properties?.billing).toEqual({ $ref: '#/components/schemas/Address' });
    // The alias def was dropped, not delivered as a second component.
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(['Address']);
  });

  it('leaves a single-use zod v4 schema inline without components', () => {
    const doc = generator().generate([
      route('POST', '/a', { body: z4.object({ id: z4.string() }) }),
    ]);

    expect(doc.components).toBeUndefined();
    expect(bodySchema(doc, '/a')).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });
});

describe('OpenApiGenerator — x-setu-unrepresentable annotation', () => {
  it('annotates the operation owning an unrepresentable zod v4 field', () => {
    const doc = generator().generate([
      route('POST', '/dates', { body: z4.object({ when: z4.date() }) }),
      route('POST', '/clean', { body: z4.object({ id: z4.string() }) }),
    ]);

    const bad = doc.paths['/dates']?.post;
    const annotation = bad?.['x-setu-unrepresentable'];
    expect(annotation).toBeDefined();
    expect(annotation).toHaveLength(1);
    expect(annotation?.[0].at).toBe('post-dates');
    expect(annotation?.[0].reason).toContain('date');

    // Clean operations carry NO annotation.
    expect(doc.paths['/clean']?.post?.['x-setu-unrepresentable']).toBeUndefined();

    // The unrepresentable node still degrades to `{}` rather than throwing.
    expect(
      (bodySchema(doc, '/dates') as { properties?: Record<string, unknown> }).properties?.when,
    ).toEqual({});
  });

  it('does not annotate anything when every schema is representable', () => {
    const doc = generator().generate([
      route('POST', '/orders', {
        body: z4.object({ id: z4.string() }),
        response: { 201: z4.object({ ok: z4.boolean() }) },
      }),
    ]);

    expect(doc.paths['/orders']?.post?.['x-setu-unrepresentable']).toBeUndefined();
  });

  it('annotates an unrepresentable zod v4 field in query like it does in a body', () => {
    const doc = generator().generate([
      route('GET', '/search', { query: z4.object({ when: z4.date() }) }),
    ]);

    expect(doc.paths['/search']?.get?.['x-setu-unrepresentable']).toEqual([
      { at: 'get-search', reason: expect.stringContaining('date') },
    ]);
  });
});

describe('OpenApiGenerator — zod v4 parameter sites (review round 2)', () => {
  /** Collects every `$ref` string in a JSON tree. */
  function refsOf(value: unknown): string[] {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, val] of Object.entries(node)) {
        if (key === '$ref' && typeof val === 'string') refs.push(val);
        else walk(val);
      }
    };
    walk(value);
    return refs;
  }

  function assertEveryRefResolves(
    doc: ReturnType<OpenApiGenerator['generate']>,
  ): void {
    for (const ref of refsOf(doc)) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      expect(doc.components?.schemas?.[ref.slice('#/components/schemas/'.length)]).toBeDefined();
    }
  }

  it('emits no dangling $defs pointer when a zod v4 query/header/param schema reuses a subschema', () => {
    const Marker = z4.object({ tag: z4.string() });
    const doc = generator().generate([
      route('GET', '/q', { query: z4.object({ x: Marker, y: Marker }) }),
      route('GET', '/h', { headers: z4.object({ 'x-a': Marker, 'x-b': Marker }) }),
      route('GET', '/p/:first', { params: z4.object({ first: Marker, second: Marker }) }),
    ]);

    // THE DEFECT: the parameter schemas carried `#/$defs/__schemaN` pointers
    // (or, recursively, a bare `#`) while `components` stayed unset — an
    // invalid document.
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('#/$defs/');
    expect(raw).not.toContain('"$ref":"#"');
    assertEveryRefResolves(doc);

    // The reused subschema became a REAL component, referenced from the site
    // zod extracted (the second occurrence).
    const componentNames = Object.keys(doc.components?.schemas ?? {});
    expect(componentNames.length).toBeGreaterThanOrEqual(1);
    for (const name of componentNames) {
      expect(name).not.toContain('__schema');
      expect(doc.components?.schemas?.[name]).toEqual({
        type: 'object',
        properties: { tag: { type: 'string' } },
        required: ['tag'],
        additionalProperties: false,
      });
    }

    // The parameters themselves survived: query enumerates both fields, the
    // header lists both headers, and the path parameter is still documented.
    expect(doc.paths['/q']?.get?.parameters?.map((p) => p.name).sort()).toEqual(['x', 'y']);
    expect(doc.paths['/h']?.get?.parameters?.map((p) => p.name).sort()).toEqual(['x-a', 'x-b']);
    expect(doc.paths['/p/{first}']?.get?.parameters?.map((p) => p.name)).toEqual(['first']);
  });

  it('keeps a recursive zod v4 query schema enumerable without a bare # ref', () => {
    interface Node {
      value: number;
      children: Node[];
    }
    const Tree: z4.ZodType<Node> = z4.lazy(() =>
      z4.object({ value: z4.number(), children: z4.array(Tree) })
    );
    const doc = generator().generate([
      route('GET', '/walk', { query: z4.object({ root: Tree }) }),
      // The RECURSIVE ROOT ITSELF as the query schema: its conversion breaks
      // the cycle with a document-root `$ref: '#'`, which must never survive
      // into a parameter.
      route('GET', '/walk2', { query: Tree }),
    ]);

    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('"$ref":"#"');
    expect(raw).not.toContain('#/$defs/');
    assertEveryRefResolves(doc);

    // The force-hoist must not swallow the parameter list: `root` is still
    // documented, dereferenced out of the component the hoist produced.
    expect(doc.paths['/walk']?.get?.parameters?.map((p) => p.name)).toEqual(['root']);
    expect(doc.paths['/walk2']?.get?.parameters?.map((p) => p.name).sort()).toEqual([
      'children',
      'value',
    ]);
  });

  it('dedups a recursive root reused across two routes into ONE hoisted component', () => {
    interface Node {
      value: number;
      children: Node[];
    }
    const Tree: z4.ZodType<Node> = z4.lazy(() =>
      z4.object({ value: z4.number(), children: z4.array(Tree) })
    );
    const doc = generator().generate([
      route('GET', '/t1', { response: { 200: Tree } }),
      route('GET', '/t2', { response: { 200: Tree } }),
    ]);

    // THE DEFECT: each route force-hoisted its own byte-identical copy under
    // a fresh name (`GetT1Response200` AND `GetT2Response200`).
    const refA = responseSchema(doc, '/t1', '200');
    const refB = responseSchema(doc, '/t2', '200');
    expect(refA).toEqual(refB);
    expect(refA).toEqual({ $ref: expect.stringMatching(/^#\/components\/schemas\//) });
    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names.length).toBe(1);

    // The hoisted component is genuinely the recursive tree, self-referencing
    // through the components section.
    const component = doc.components?.schemas?.[names[0]];
    expect(component?.properties?.value).toEqual({ type: 'number' });
    expect(JSON.stringify(component)).toContain(`#/components/schemas/${names[0]}`);
    assertEveryRefResolves(doc);
  });
});

describe('OpenApiGenerator — per-document component reset', () => {
  it('purges $defs-delivered components from a previous generate() call', () => {
    // THE DEFECT: a repeated zod v4 child is extracted by zod into a
    // mechanical `$def` and delivered straight to `#componentSchemas` — never
    // recorded in `#schemaMap` — so the per-document reset (which only removes
    // map-tracked components) left it behind and a second generate() leaked
    // the first document's `PostFirstBody` into an unrelated document.
    const gen = generator();
    const child = z4.object({ tag: z4.string() });
    const first = gen.generate([
      route('POST', '/first', { body: z4.object({ a: child, b: child }) }),
    ]);
    expect(first.components?.schemas?.PostFirstBody).toEqual({
      type: 'object',
      properties: { tag: { type: 'string' } },
      required: ['tag'],
      additionalProperties: false,
    });

    const second = gen.generate([
      route('POST', '/second', { body: z4.object({ id: z4.string() }) }),
    ]);
    expect(second.components?.schemas?.PostFirstBody).toBeUndefined();
    expect(second.components).toBeUndefined();
  });

  it('restores pass state when generate() throws, so a later addSchema stays clean', () => {
    // THE DEFECT: `generate` set `#pass = 'count'` and `#generating = true`
    // without a `finally`, so a schema throwing mid-pass stranded both. The
    // next `addSchema` then transformed under the COUNT pass, where
    // `onDefinitionClaim` hands out the throwaway `\u0000count:` sentinel that
    // is never meant to escape — and `#adaptDocument` had already rewritten
    // the pointers to it, so the sentinel reached the document as a `$ref`
    // carrying a literal NUL byte, while the real component was purged.
    const gen = generator();
    const address = z4.object({ city: z4.string() });
    const person = z4.object({ home: address, billing: address });

    // A schema that duck-types as zod v4 and throws during the count pass.
    const hostile = {
      toJSONSchema: () => {
        throw new Error('boom');
      },
    };
    expect(() => gen.generate([route('POST', '/boom', { body: hostile })])).toThrow('boom');

    gen.addSchema('Person', person);
    const doc = gen.generate([]);

    const schemas = (doc.components?.schemas ?? {}) as Record<string, unknown>;
    const refs: string[] = [];
    JSON.stringify(schemas, (key, value) => {
      if (key === '$ref' && typeof value === 'string') refs.push(value);
      return value;
    });
    const dangling = refs
      .filter((ref) => ref.startsWith('#/components/schemas/'))
      .map((ref) => ref.slice('#/components/schemas/'.length))
      .filter((name) => !(name in schemas));

    expect(dangling).toEqual([]);
    expect(refs.some((ref) => ref.includes('\u0000'))).toBe(false);
    expect(schemas.Person).toBeDefined();
  });

  it('keeps addSchema registrations across resets, including their sub-components', () => {
    // A component delivered at addSchema time (outside any generate call) is
    // NOT per-document state: Person's own properties point at it, so purging
    // it would dangle every registration that references it.
    const gen = generator();
    const address = z4.object({ city: z4.string() });
    const person = z4.object({ home: address, billing: address });
    gen.addSchema('Person', person);
    const routes = [route('GET', '/p', { response: { 200: person } })];

    const first = gen.generate(routes);
    const homeRef = (
      (
        first.components?.schemas?.Person as {
          properties?: Record<string, { $ref?: string }>;
        }
      ).properties?.home?.$ref ?? ''
    ).split('/').pop();
    expect(homeRef).toBeTruthy();
    expect(first.components?.schemas?.[homeRef as string]).toBeDefined();

    const second = gen.generate(routes);
    expect(responseSchema(second, '/p', '200')).toEqual({
      $ref: '#/components/schemas/Person',
    });
    expect(second.components?.schemas?.Person).toBeDefined();
    expect(second.components?.schemas?.[homeRef as string]).toBeDefined();
  });
});
