import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ValidationPlugin, validateBody } from '../../src/index.ts';
import { formFile } from '../../src/zod/index.ts';

describe('form-file upload through app.fetch', () => {
  it('accepts a real file and short-circuits wrong MIME types and oversize files', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), ValidationPlugin({ errorFormat: 'nestjs' })],
    });
    const body = validateBody(
      z.object({ title: z.string(), file: formFile({ mimeTypes: ['text/plain'], maxBytes: 3 }) }),
      { forms: true },
    );
    let calls = 0;
    app.router.post('/uploads', {
      middleware: [body],
      handler: (ctx) => {
        calls++;
        const value = body.value(ctx);
        return ctx.response.json({
          title: value.title,
          filename: value.file.filename,
          mimeType: value.file.mimeType,
          text: new TextDecoder().decode(value.file.data),
        });
      },
    });
    try {
      await app.start();
      for (const [text, mimeType, status, issue] of [
        ['hey', 'text/plain', 200, 'hello.txt'],
        ['hey', 'image/png', 400, 'File type image/png is not accepted'],
        ['long', 'text/plain', 400, 'File exceeds 3 bytes'],
      ] as const) {
        const form = new FormData();
        form.append('title', 'Hello');
        form.append('file', new File([text], 'hello.txt', { type: mimeType }));
        const response = await app.fetch(
          new Request('http://localhost/uploads', { method: 'POST', body: form }),
        );
        expect(response.status).toBe(status);
        const result = await response.text();
        expect(result).toContain(issue);
        if (status === 200)
          expect(JSON.parse(result)).toEqual({
            title: 'Hello',
            filename: 'hello.txt',
            mimeType: 'text/plain',
            text: 'hey',
          });
      }
      expect(calls).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
