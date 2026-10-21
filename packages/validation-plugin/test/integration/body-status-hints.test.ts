import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import { ValidationPlugin, validateBody } from '../../src/index.ts';

describe('body validation preserves runtime status hints', () => {
  for (const [encoding, payload, status] of [
    ['application/json', JSON.stringify({ name: 'too large for the limit' }), 413],
    ['application/x-www-form-urlencoded', 'name=too+large+for+the+limit', 413],
    ['application/json', '{broken', 400],
  ] as const) {
    it(`${encoding} ${status === 413 ? 'oversized body stays 413' : 'malformed JSON stays 400'}`, async () => {
      const app = createApplication();
      app.register(RuntimePlugin({ maxBodyBytes: 16 }));
      app.register(ValidationPlugin({ errorFormat: 'rfc9457' }));
      app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), {
        priority: 0,
        name: 'error-handler',
      });
      const body = validateBody(z.object({ name: z.string() }), { forms: true });
      let calls = 0;
      app.router.post('/body', {
        middleware: [body],
        handler: (ctx) => {
          calls++;
          return ctx.response.json(body.value(ctx));
        },
      });
      try {
        await app.start();
        const response = await app.fetch(
          new Request('http://localhost/body', {
            method: 'POST',
            headers: { 'content-type': encoding },
            body: payload,
          }),
        );
        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        const problem: unknown = await response.json();
        expect(problem).toMatchObject({ status });
        if (status === 400)
          expect(problem).toMatchObject({
            errors: [{ message: 'Invalid JSON in request body' }],
          });
        expect(calls).toBe(0);
      } finally {
        await app.stop();
      }
    });
  }
});
