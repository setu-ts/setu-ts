import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { formFile } from '@setu-ts/validation-plugin/zod';
import { OpenApiPlugin } from '../../src/index.ts';
import type { OpenApiDocument } from '../../src/index.ts';

describe('served form-body document and accepted media types', () => {
  it('sends every listed media type to the real route, and refuses text/plain', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ValidationPlugin(),
        OpenApiPlugin({ title: 'Forms', version: '1', swagger: false }),
      ],
    });
    const plain = z.object({ title: z.string() });
    for (const [path, schema, forms] of [
      ['/forms', plain, true],
      ['/files', z.object({ title: z.string(), file: formFile() }), true],
      ['/json', plain, false],
    ] as const) {
      app.router.post(path, {
        middleware: [validateBody(schema, { forms })],
        handler: (ctx) => ctx.response.json({ ok: true }),
      });
    }
    try {
      await app.start();
      const served = await app.fetch(new Request('http://localhost/openapi.json'));
      expect(served.status).toBe(200);
      const doc = (await served.json()) as OpenApiDocument;
      for (const [path, expected] of [
        [
          '/forms',
          ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
        ],
        ['/files', ['multipart/form-data']],
        ['/json', ['application/json']],
      ] as const) {
        const types = Object.keys(doc.paths[path]!.post!.requestBody!.content);
        expect(types).toEqual(expected);
        for (const type of types) {
          const form = new FormData();
          form.append('title', 'Hello');
          if (path === '/files')
            form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
          const body =
            type === 'application/json'
              ? JSON.stringify({ title: 'Hello' })
              : type === 'application/x-www-form-urlencoded'
                ? new URLSearchParams('title=Hello')
                : form;
          const response = await app.fetch(
            new Request(`http://localhost${path}`, {
              method: 'POST',
              body,
              ...(type === 'application/json' ? { headers: { 'content-type': type } } : {}),
            }),
          );
          expect(response.status, `${path} ${type}`).toBe(200);
          await response.text();
        }
        const refused = await app.fetch(
          new Request(`http://localhost${path}`, {
            method: 'POST',
            body: 'title=Hello',
            headers: { 'content-type': 'text/plain' },
          }),
        );
        expect(refused.status).toBe(415);
        await refused.text();
      }
    } finally {
      await app.stop();
    }
  });
});
