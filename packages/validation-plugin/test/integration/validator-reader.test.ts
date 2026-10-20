import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { CAPABILITIES, validatedStateKey } from '@setu-ts/common';
import type { IValidationService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  ValidationPlugin,
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validateCookies,
} from '../../src/index.ts';

describe('validator reader through the real kernel', () => {
  for (const helper of [
    validateBody,
    validateQuery,
    validateParams,
    validateHeaders,
    validateCookies,
  ]) {
    it(`reads the outer ${helper.name} instance under whitelist policy`, async () => {
      const schema = z.object({ count: z.coerce.number().default(1) });
      const reader = helper(schema);
      const app = createApplication();
      app.register(RuntimePlugin());
      app.register(ValidationPlugin({ whitelist: true }));
      app.router.post('/records/:id', {
        middleware: [reader],
        handler: (ctx) => ctx.response.json(reader.value(ctx)),
      });
      try {
        await app.start();
        for (let request = 0; request < 2; request++) {
          const response = await app.fetch(
            new Request('http://localhost/records/one?extra=removed', {
              method: 'POST',
              headers: { 'content-type': 'application/json', cookie: 'extra=removed' },
              body: '{"extra":"removed"}',
            }),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ count: 1 });
        }
      } finally {
        await app.stop();
      }
    });
  }
  it('honors the same whitelist policy through service.middleware', async () => {
    const app = createApplication();
    app.register(RuntimePlugin());
    app.register(ValidationPlugin({ whitelist: true }));
    const schema = z.object({ count: z.coerce.number().default(1) }).passthrough();
    app.router.post('/', {
      middleware: [
        (ctx, next) =>
          ctx.services.get<IValidationService>(CAPABILITIES.VALIDATION).middleware(schema, 'body')(
            ctx,
            next,
          ),
      ],
      handler: (ctx) => ctx.response.json(ctx.state.get(validatedStateKey('body'))),
    });
    try {
      await app.start();
      const response = await app.fetch(
        new Request('http://localhost/', { method: 'POST', body: '{"extra":true}' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ count: 1 });
    } finally {
      await app.stop();
    }
  });
});
