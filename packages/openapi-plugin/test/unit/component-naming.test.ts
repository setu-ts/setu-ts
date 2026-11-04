import { expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { RouteInfo } from '@setu-ts/common';
import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';
function route(path: string, body: unknown): RouteInfo {
  return {
    method: 'POST',
    path,
    definition: { handler: (ctx) => ctx.response.send(), schema: { body } },
  };
}
for (const named of [false, true]) {
  it(`M131b 3.15 reserves site roots and names nested models from identity/path named=${named}`, () => {
    const line = named
      ? z.object({ value: z.string() }).meta({ id: 'OrderLine' })
      : z.object({ value: z.string() });
    const orders = z.object({ lines: z.array(line) });
    const returns = z.object({ lines: z.array(line) });
    const doc = new OpenApiGenerator({}).generate([
      route('/orders', orders),
      route('/orders-again', orders),
      route('/returns', returns),
    ]);
    const schemas = doc.components!.schemas!;
    const child = named ? 'OrderLine' : 'PostOrdersBodyLinesItems';
    expect(schemas[child]).toMatchObject({
      type: 'object',
      properties: { value: expect.any(Object) },
    });
    expect(schemas['PostOrdersBody']).toMatchObject({
      properties: { lines: { type: 'array', items: { $ref: `#/components/schemas/${child}` } } },
    });
    expect(Object.keys(schemas)).not.toContain('PostOrdersBody2');
  });
}
it('M131b 3.15 keeps nullable primitives inline', () => {
  const maybe = z.string().nullable();
  const doc = new OpenApiGenerator({}).generate([route('/a', maybe), route('/b', maybe)]);
  expect(doc.components?.schemas ?? {}).toEqual({});
  expect(doc.paths['/a']!.post!.requestBody).toMatchObject({
    content: { 'application/json': { schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
  });
});

it('M131b audit F5: an id outside the component-name grammar falls back to the site name', () => {
  const line = z.object({ value: z.string() }).meta({ id: 'Order/Line #2 ~x' });
  const orders = z.object({ lines: z.array(line) });
  const doc = new OpenApiGenerator({}).generate([
    route('/orders', orders),
    route('/orders-again', orders),
  ]);
  const schemas = doc.components!.schemas!;
  for (const name of Object.keys(schemas)) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  expect(schemas['PostOrdersBodyLinesItems']).toMatchObject({ type: 'object' });
  expect(schemas['PostOrdersBody']).toMatchObject({
    properties: { lines: { items: { $ref: '#/components/schemas/PostOrdersBodyLinesItems' } } },
  });
});

it("M131b audit F5: an id equal to another operation's root name leaves that root its name", () => {
  // The nested schema's id is the name the /orders body will claim; it is
  // resolved first (from /returns), so without the reservation it would take it.
  const line = z.object({ value: z.string() }).meta({ id: 'PostOrdersBody' });
  const returns = z.object({ lines: z.array(line) });
  const orders = z.object({ total: z.number() });
  const doc = new OpenApiGenerator({}).generate([
    route('/returns', returns),
    route('/returns-again', returns),
    route('/orders', orders),
    route('/orders-again', orders),
  ]);
  const schemas = doc.components!.schemas!;
  expect(schemas['PostOrdersBody']).toMatchObject({ properties: { total: expect.any(Object) } });
  expect(schemas['PostOrdersBody2']).toMatchObject({ properties: { value: expect.any(Object) } });
  expect(schemas['PostReturnsBody']).toMatchObject({
    properties: { lines: { items: { $ref: '#/components/schemas/PostOrdersBody2' } } },
  });
});

it('M131b re-audit R2: a nested name never takes another route root, whatever the order', () => {
  // `/a`'s nested `body` property derives `PostABodyBody`, the very name the
  // `/a/body` operation's own body uses.
  const inner = z.object({ deep: z.string() });
  const real = z.object({ real: z.string() });
  const a = route('/a', z.object({ body: inner, again: inner }));
  const ab = [route('/a/body', real), route('/a/body2', real)];
  for (const routes of [
    [a, ...ab],
    [...ab, a],
  ]) {
    const doc = new OpenApiGenerator({}).generate(routes);
    expect(doc.paths['/a/body']!.post!.requestBody).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/PostABodyBody' } } },
    });
    expect(doc.components!.schemas!['PostABodyBody']).toMatchObject({
      properties: { real: expect.any(Object) },
    });
  }
});

it('M131b review: a schema behind .optional() still shares its component with a plain site', () => {
  const address = z.object({ street: z.string(), city: z.string() });
  const doc = new OpenApiGenerator({}).generate([
    route('/a', z.object({ x: address.optional() })),
    route('/b', z.object({ y: address })),
  ]);
  const schemas = doc.components!.schemas!;
  expect(Object.keys(schemas)).toEqual(['PostABodyX']);
  expect(doc.paths['/a']!.post!.requestBody).toMatchObject({
    content: {
      'application/json': {
        schema: { properties: { x: { $ref: '#/components/schemas/PostABodyX' } } },
      },
    },
  });
  expect(doc.paths['/b']!.post!.requestBody).toMatchObject({
    content: {
      'application/json': {
        schema: { properties: { y: { $ref: '#/components/schemas/PostABodyX' } } },
      },
    },
  });
});
