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
});
