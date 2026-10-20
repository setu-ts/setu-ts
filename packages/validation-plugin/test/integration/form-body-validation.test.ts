import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  Body,
  Controller,
  DecoratorPlugin,
  Params,
  Post,
  ValidateBody,
} from '@setu-ts/decorator-plugin';
import { ValidationPlugin, validateBody } from '../../src/index.ts';

const schema = z.object({
  name: z.string(),
  count: z.coerce.number().default(1),
  tag: z.array(z.string()).optional(),
});
@Controller('/decorated')
class FormController {
  @Post('/')
  @ValidateBody(schema, { forms: true })
  @Params(Body<z.infer<typeof schema>>())
  create(body: z.infer<typeof schema>): z.infer<typeof schema> {
    return body;
  }
}

/** The same route without the opt-in: JSON only, exactly as released. */
@Controller('/decorated-json')
class JsonOnlyController {
  @Post('/')
  @ValidateBody(schema)
  @Params(Body<z.infer<typeof schema>>())
  create(body: z.infer<typeof schema>): z.infer<typeof schema> {
    return body;
  }
}

describe('form validation through the real kernel', () => {
  it('uses one schema for JSON, urlencoded and multipart, including decorated routes', async () => {
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(ValidationPlugin({ whitelist: true }));
    app.register(DecoratorPlugin({ controllers: [FormController, JsonOnlyController] }));
    const body = validateBody(schema, { forms: true });
    const jsonOnly = validateBody(schema);
    app.router.post('/helper-json', {
      middleware: [jsonOnly],
      handler: (ctx) => ctx.response.json(jsonOnly.value(ctx)),
    });
    let calls = 0;
    app.router.post('/helper', {
      middleware: [body],
      handler: (ctx) => {
        calls++;
        return ctx.response.json(body.value(ctx));
      },
    });
    try {
      await app.start();
      for (const route of ['/helper', '/decorated']) {
        for (const encoding of ['json', 'urlencoded', 'multipart']) {
          const form = new FormData();
          form.append('name', 'Ada');
          form.append('count', '3');
          form.append('tag', 'a');
          form.append('tag', 'b');
          const requestBody =
            encoding === 'multipart'
              ? form
              : encoding === 'urlencoded'
                ? new URLSearchParams('name=Ada&count=3&tag=a&tag=b')
                : JSON.stringify({ name: 'Ada', count: '3', tag: ['a', 'b'] });
          const response = await app.fetch(
            new Request(`http://localhost${route}`, {
              method: 'POST',
              body: requestBody,
              ...(encoding === 'json' ? { headers: { 'content-type': 'application/json' } } : {}),
            }),
          );
          expect(response.status, `${route} ${encoding}`).toBe(200);
          expect(await response.json()).toEqual({ name: 'Ada', count: 3, tag: ['a', 'b'] });
        }
      }
      expect(calls).toBe(3);
      // Without the opt-in a form post is not a form: the released JSON path
      // refuses it, which is what keeps a cross-site <form> off these routes.
      for (const route of ['/helper-json', '/decorated-json']) {
        for (const requestBody of [
          new URLSearchParams('name=Ada'),
          (() => {
            const form = new FormData();
            form.append('name', 'Ada');
            return form;
          })(),
        ]) {
          const refused = await app.fetch(
            new Request(`http://localhost${route}`, { method: 'POST', body: requestBody }),
          );
          expect(refused.status, route).toBe(400);
          expect(await refused.text()).toContain('Invalid JSON in request body');
        }
        const json = await app.fetch(
          new Request(`http://localhost${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Ada' }),
          }),
        );
        expect(json.status, route).toBe(200);
        await json.text();
      }
      const file = new FormData();
      file.append('name', new Blob(['bytes']), 'a.txt');
      const rejected = await app.fetch(
        new Request('http://localhost/helper', { method: 'POST', body: file }),
      );
      expect(rejected.status).toBe(400);
      await rejected.text();
      for (const [type, text] of [
        ['application/x-www-form-urlencoded', '{"name":"Ada"}'],
        ['multipart/form-data; boundary=x', 'broken'],
        ['application/json', 'name=Ada'],
      ]) {
        const response = await app.fetch(
          new Request('http://localhost/helper', {
            method: 'POST',
            headers: { 'content-type': type! },
            body: text!,
          }),
        );
        expect(response.status).toBe(400);
        await response.text();
      }
      expect(calls).toBe(3);
    } finally {
      await app.stop();
    }
  });
});
