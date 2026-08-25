/**
 * Schema deduplication (M70m/X11-6).
 *
 * Before this the FIRST use of a reused schema was inlined and never
 * rewritten, so one shape appeared both inline and as a `$ref` to a
 * meaningless `Schema1` — and a schema NESTED inside another was not counted
 * at all, so two structurally identical cases behaved differently.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
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

/** Reads a response schema, whatever form it took. */
function responseSchema(
  doc: ReturnType<OpenApiGenerator['generate']>,
  path: string,
  status: string,
) {
  return doc.paths[path]?.get?.responses[status]?.content?.['application/json']?.schema;
}

describe('schema dedup', () => {
  it('emits a $ref at EVERY site of a reused schema, including the first', () => {
    const shared = z.object({ error: z.string() });
    const doc = generator().generate([
      route('GET', '/a', { response: { 404: shared } }),
      route('GET', '/b', { response: { 404: shared } }),
    ]);

    const ref = { $ref: '#/components/schemas/GetAResponse404' };
    expect(responseSchema(doc, '/a', '404')).toEqual(ref);
    expect(responseSchema(doc, '/b', '404')).toEqual(ref);
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(['GetAResponse404']);
  });

  it('hoists a NESTED schema that is also used directly', () => {
    // The register's own example: `OrderSchema` inside `OrderListSchema`.
    // Counting only top-level sites left this inlined at both.
    const order = z.object({ id: z.string() });
    const orderList = z.object({ items: z.array(order) });
    const doc = generator().generate([
      route('GET', '/orders', { response: { 200: orderList } }),
      route('GET', '/orders/:id', { response: { 200: order } }),
    ]);

    const name = Object.keys(doc.components?.schemas ?? {})[0]!;
    const listSchema = responseSchema(doc, '/orders', '200');
    expect(listSchema?.properties?.items?.items).toEqual({
      $ref: `#/components/schemas/${name}`,
    });
    expect(responseSchema(doc, '/orders/{id}', '200')).toEqual({
      $ref: `#/components/schemas/${name}`,
    });
    expect(doc.components?.schemas?.[name]?.properties?.id).toEqual({ type: 'string' });
  });

  it('hoists a schema nested in TWO different parents', () => {
    const inner = z.object({ id: z.string() });
    const doc = generator().generate([
      route('GET', '/a', { response: { 200: z.object({ one: inner }) } }),
      route('GET', '/b', { response: { 200: z.object({ two: inner }) } }),
    ]);

    expect(Object.keys(doc.components?.schemas ?? {})).toHaveLength(1);
    const name = Object.keys(doc.components?.schemas ?? {})[0]!;
    expect(responseSchema(doc, '/a', '200')?.properties?.one).toEqual({
      $ref: `#/components/schemas/${name}`,
    });
    expect(responseSchema(doc, '/b', '200')?.properties?.two).toEqual({
      $ref: `#/components/schemas/${name}`,
    });
  });

  it('leaves a single-use schema inline', () => {
    const doc = generator().generate([
      route('GET', '/a', { response: { 200: z.object({ id: z.string() }) } }),
    ]);

    expect(doc.components).toBeUndefined();
    expect(responseSchema(doc, '/a', '200')?.type).toBe('object');
  });

  it('does NOT hoist a reused primitive', () => {
    // A `$ref` to `{type:'string'}` is larger than the schema it replaces, and
    // `components/schemas` is where a reader looks for MODELS. Left inline, a
    // reused primitive also cannot steal the component name its parent wants.
    const id = z.string();
    const doc = generator().generate([
      route('GET', '/a', { response: { 200: z.object({ a: id }) } }),
      route('GET', '/b', { response: { 200: z.object({ b: id }) } }),
    ]);

    expect(doc.components).toBeUndefined();
    expect(responseSchema(doc, '/a', '200')?.properties?.a).toEqual({ type: 'string' });
  });

  it('names the component from the site that first reached it', () => {
    const shared = z.object({ v: z.string() });
    const doc = generator().generate([
      route('GET', '/orders/:id', { response: { 409: shared, 410: shared } }),
    ]);

    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(['GetOrdersByIdResponse409']);
  });

  it('suffixes rather than overwriting when two sites derive one name', () => {
    // Two DISTINCT schemas whose first sites derive the same hint: both are
    // reused, so both must exist as separate components.
    const a = z.object({ a: z.string() });
    const b = z.object({ b: z.string() });
    const doc = new OpenApiGenerator({ title: 'T', version: '1' }).generate([
      route('GET', '/x', { response: { 200: a, 201: b } }),
      route('GET', '/y', { response: { 200: a, 201: b } }),
    ]);

    const names = Object.keys(doc.components?.schemas ?? {});
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it('keeps a contributor-chosen addSchema name and refs it from the first use', () => {
    const gen = generator();
    const named = z.object({ id: z.string() });
    gen.addSchema('Widget', named);
    const doc = gen.generate([route('GET', '/a', { response: { 200: named } })]);

    expect(responseSchema(doc, '/a', '200')).toEqual({ $ref: '#/components/schemas/Widget' });
    expect(doc.components?.schemas?.Widget?.properties?.id).toEqual({ type: 'string' });
  });

  it('does not hoist a schema used once as a body and once for parameters', () => {
    // Parameter schemas are DESTRUCTURED into `properties`, so a `$ref` there
    // would have nothing to destructure. They are transformed without the
    // dedup hook, which is why this counts as one site rather than two.
    const shared = z.object({ id: z.string() });
    const doc = generator().generate([
      {
        method: 'POST',
        path: '/a/:id',
        definition: {
          handler: () => {
            throw new Error('not used');
          },
          schema: { params: shared, body: shared },
        },
      },
    ]);

    expect(doc.paths['/a/{id}']?.post?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(doc.components).toBeUndefined();
  });
});
