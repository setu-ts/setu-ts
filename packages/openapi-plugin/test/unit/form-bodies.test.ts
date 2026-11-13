import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { MiddlewareFunction, RouteInfo } from '@setu-ts/common';
import { withValidationMetadata } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { Controller, DecoratorPlugin, Post, ValidateBody } from '@setu-ts/decorator-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { formFile } from '@setu-ts/validation-plugin/zod';
import { OpenApiGenerator } from '../../src/index.ts';

const TYPES = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'];
const binary = { type: 'string', format: 'binary', contentMediaType: 'application/octet-stream' };
const brand = (schema: unknown, forms = true): MiddlewareFunction =>
  withValidationMetadata(
    async (_ctx, next) => {
      await next();
    },
    { target: 'body', schema, ...(forms ? { forms: true } : {}) },
  );
const route = (
  body: unknown,
  middleware: readonly MiddlewareFunction[] = [brand(body)],
  declared = false,
): RouteInfo => ({
  method: 'POST',
  path: '/form',
  definition: {
    handler: (ctx) => ctx.response.json({}),
    middleware: [...middleware],
    ...(declared ? { schema: { body } } : {}),
  },
});
const generator = () => new OpenApiGenerator({ title: 'Forms', version: '1' });
const simple = z.object({ title: z.string() });

@Controller('/decorated-form')
class FormController {
  @Post('/')
  @ValidateBody(simple, { forms: true })
  create(): object {
    return {};
  }
}

describe('form request body documents', () => {
  it('lists three media types in order with a single shared resolved schema', () => {
    const doc = generator().generate([route(simple)]);
    const content = doc.paths['/form']?.post?.requestBody?.content;
    expect(Object.keys(content ?? {})).toEqual(TYPES);
    expect(content?.['application/json']?.schema).toBe(content?.['multipart/form-data']?.schema);
    expect(content?.['application/json']?.schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(doc.components?.schemas).toBeUndefined();
  });
  it('uses JSON when no body brand or any body brand omits forms, regardless of order', () => {
    for (const middleware of [
      [],
      [brand(simple, false)],
      [brand(simple), brand(simple, false)],
      [brand(simple, false), brand(simple)],
    ]) {
      expect(
        Object.keys(
          generator().generate([route(simple, middleware, true)]).paths['/form']!.post!.requestBody!
            .content,
        ),
      ).toEqual(['application/json']);
    }
  });
  it('documents binary nodes, arrays, optional, described and nullable files without diagnostics', () => {
    const body = z.object({
      file: formFile({ mimeTypes: ['image/*', 'text/plain'], maxBytes: 5 })
        .describe('The upload')
        .optional(),
      files: z.array(formFile()),
      nullable: formFile().nullable(),
    });
    const doc = generator().generate([route(body)]);
    const operation = doc.paths['/form']!.post!;
    expect(Object.keys(operation.requestBody!.content)).toEqual(['multipart/form-data']);
    const media = operation.requestBody!.content['multipart/form-data']!;
    expect(media.encoding).toEqual({ file: { contentType: 'image/*, text/plain' } });
    expect(media.schema.properties?.['file']).toEqual({ ...binary, description: 'The upload' });
    expect(media.schema.properties?.['files']).toEqual({ type: 'array', items: binary });
    expect(media.schema.properties?.['nullable']).toEqual({ anyOf: [binary, { type: 'null' }] });
    expect(JSON.stringify(doc)).not.toContain('x-setu-unrepresentable');
  });
  it('omits encoding without MIME constraints and reads the effective declared body', () => {
    const body = z.object({ upload: formFile({ maxBytes: 10 }) });
    const doc = generator().generate([route(body, [brand(simple)], true)]);
    const content = doc.paths['/form']!.post!.requestBody!.content;
    expect(Object.keys(content)).toEqual(['multipart/form-data']);
    expect(content['multipart/form-data']).not.toHaveProperty('encoding');
    expect(content['multipart/form-data']!.schema.properties?.['upload']).toEqual(binary);
  });
  it('keeps encoding on every operation when a shared body is hoisted', () => {
    const body = z.object({ upload: formFile({ mimeTypes: ['text/plain'] }) });
    const first = route(body);
    const doc = generator().generate([first, { ...first, path: '/other' }]);
    for (const path of ['/form', '/other']) {
      const media = doc.paths[path]!.post!.requestBody!.content['multipart/form-data']!;
      expect(media.schema.$ref).toBeDefined();
      expect(media.encoding).toEqual({ upload: { contentType: 'text/plain' } });
    }
  });
  it('allows Zod to share a reused file instance via a binary component', () => {
    const file = formFile();
    const doc = generator().generate([route(z.object({ first: file, second: file }))]);
    const properties =
      doc.paths['/form']!.post!.requestBody!.content['multipart/form-data']!.schema.properties!;
    expect(properties['first'].$ref).toBeDefined();
    expect(properties['second']).toEqual(properties['first']);
    expect(Object.values(doc.components?.schemas ?? {})).toContainEqual(binary);
    expect(JSON.stringify(doc)).not.toContain('x-setu-unrepresentable');
  });
  it('reads forms from decorated validation middleware through the real plugin', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ValidationPlugin(),
        DecoratorPlugin({ controllers: [FormController] }),
      ],
    });
    try {
      await app.start();
      const doc = generator().generate(app.router.listRoutes());
      expect(Object.keys(doc.paths['/decorated-form']!.post!.requestBody!.content)).toEqual(TYPES);
    } finally {
      await app.stop();
    }
  });
});
