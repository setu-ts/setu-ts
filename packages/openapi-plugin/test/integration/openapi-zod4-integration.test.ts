/**
 * End-to-end integration tests for zod v4 schemas through a real kernel app
 * (fix A9-1).
 *
 * The defect: a zod v4 schema produced an EMPTY OpenAPI schema, so
 * `/openapi.json` served `{"schema":{}}` for every route documented with one.
 * These tests drive the real plugin through `app.inject()` and assert the
 * served document is fully populated.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z as z4 } from 'npm:zod@^4.4.0';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';

describe('OpenAPI integration — zod v4', () => {
  it('serves a fully populated requestBody for a zod v4 body schema', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });

    app.router.post('/widgets', {
      handler: (ctx) => ctx.response.status(201).json({ id: '1' }),
      schema: {
        body: z4.object({
          name: z4.string().min(1),
          email: z4.string().email(),
        }),
        response: {
          201: z4.object({ id: z4.string() }),
        },
      },
    });

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });
    expect(response.statusCode).toBe(200);

    const spec = response.json<{
      paths: Record<string, {
        post?: {
          requestBody?: { content: { 'application/json': { schema: unknown } } };
          responses: Record<
            string,
            { content?: { 'application/json'?: { schema: unknown } } }
          >;
        };
      }>;
    }>();

    // THE DEFECT: this was `{"schema":{}}` before the fix. Matched as a
    // subset: zod v4 also emits a regex `pattern` beside derived formats.
    expect(spec.paths['/widgets']?.post?.requestBody?.content['application/json'].schema)
      .toMatchObject({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
        },
        required: ['name', 'email'],
        additionalProperties: false,
      });
    expect(
      spec.paths['/widgets']?.post?.responses['201']?.content?.['application/json']?.schema,
    ).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
    await app.stop();
  });

  it('extracts a recursive zod v4 schema into components in the served document', async () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const Tree: z4.ZodType<Node> = z4.lazy(() =>
      z4.object({ name: z4.string(), children: z4.array(Tree) })
    );

    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });

    app.router.get('/trees/:id', {
      handler: (ctx) => ctx.response.json({ name: 'root', children: [] }),
      schema: {
        params: z4.object({ id: z4.string() }),
        response: { 200: Tree },
      },
    });

    await app.start();
    const response = await app.inject({
      method: 'GET',
      url: 'http://localhost/openapi.json',
    });
    expect(response.statusCode).toBe(200);

    const raw = JSON.stringify(response.json());
    // No bare document-root cycle ref survives into the served document.
    expect(raw).not.toContain('"$ref":"#"');
    expect(raw).toContain('#/components/schemas/');

    const spec = response.json<{
      paths: Record<string, {
        get?: {
          responses: Record<
            string,
            { content?: { 'application/json'?: { schema: { $ref?: string } } } }
          >;
        };
      }>;
      components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
    }>();
    const ref = spec.paths['/trees/{id}']?.get?.responses['200']?.content?.['application/json']
      ?.schema.$ref;
    expect(ref).toMatch(/^#\/components\/schemas\//);
    const component = spec.components?.schemas?.[ref!.split('/').pop()!];
    expect(component?.properties?.name).toEqual({ type: 'string' });
    expect(component?.properties?.children).toBeDefined();
    await app.stop();
  });
});
