import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import {
  Body,
  Controller,
  DecoratorPlugin,
  Params,
  Post,
  ValidateBody,
} from '@setu-ts/decorator-plugin';
import { ValidationPlugin, validateBody } from '../../src/index.ts';

const schema = z.object({ name: z.string() });
let calls = 0;
@Controller('/decorated')
class MediaController {
  @Post('/')
  @ValidateBody(schema)
  @Params(Body<z.infer<typeof schema>>())
  create(body: z.infer<typeof schema>): z.infer<typeof schema> {
    calls++;
    return body;
  }
}

describe('body media types through the kernel', () => {
  it('refuses the exact text/plain HTML-form attack on helper and decorated routes', async () => {
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(ValidationPlugin());
    app.register(DecoratorPlugin({ controllers: [MediaController] }));
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
      priority: 0,
      name: 'error-handler',
    });
    const body = validateBody(schema);
    app.router.post('/helper', {
      middleware: [body],
      handler: (ctx) => {
        calls++;
        return ctx.response.json(body.value(ctx));
      },
    });
    calls = 0;
    const name = '{"name":"Ada","p":"';
    const value = 'x"}';
    const payload = `${name}=${value}`;
    expect(JSON.parse(payload)).toEqual({ name: 'Ada', p: '=x' });
    try {
      await app.start();
      for (const path of ['/helper', '/decorated']) {
        for (const header of [
          'text/plain',
          undefined,
          'application/json',
          'application/vnd.api+json',
        ]) {
          const accepted = header?.startsWith('application/') === true;
          const before = calls;
          // A byte body lets the absent-header case remain absent in a real Request.
          const response = await app.fetch(
            new Request(`http://localhost${path}`, {
              method: 'POST',
              body: new TextEncoder().encode(payload),
              ...(header === undefined ? {} : { headers: { 'content-type': header } }),
            }),
          );
          expect(response.status, `${path} ${header}`).toBe(accepted ? 200 : 415);
          expect(calls - before).toBe(Number(accepted));
          if (accepted) expect(await response.json()).toEqual({ name: 'Ada' });
          else {
            expect(response.headers.get('content-type')).toContain('application/problem+json');
            expect(await response.json()).toMatchObject({
              status: 415,
              title: 'Unsupported Media Type',
              detail: 'Expected a JSON request body (application/json).',
            });
          }
        }
      }
      const empty = await app.fetch(new Request('http://localhost/helper', { method: 'POST' }));
      expect(empty.status).toBe(415);
      await empty.text();
      expect(calls).toBe(4);
    } finally {
      await app.stop();
    }
  });
});
