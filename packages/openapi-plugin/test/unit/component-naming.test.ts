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
