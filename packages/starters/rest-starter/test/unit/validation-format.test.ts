/**
 * Unit test for the rest-starter's C3 fix: by default a validation failure
 * answers in the SAME format as a thrown error (both `application/problem+json`
 * under `errorHandler({ format: 'rfc9457' })`), and an explicit
 * `options.validation.errorFormat` still wins (plan §3.7, C3).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createRestApp } from '../../src/index.ts';
import { validateBody } from '@setu-ts/validation-plugin';

/** A schema that always fails, so the route short-circuits with a 400. */
const failingSchema = {
  safeParse(_data: unknown) {
    return {
      success: false as const,
      error: { issues: [{ path: ['name'], message: 'name is required' }] },
    };
  },
};

/** Adds a `/validate` (failing) and `/throw` route and starts the app. */
async function appWith(opts?: Parameters<typeof createRestApp>[0]) {
  const app = createRestApp(opts);
  app.router.post('/validate', {
    middleware: [validateBody(failingSchema)],
    handler: (ctx) => ctx.response.text('ok'),
  });
  app.router.get('/throw', () => {
    throw new Error('starter throw');
  });
  await app.start();
  return app;
}

describe('rest-starter validation format (C3)', () => {
  it('by default a validation failure agrees with a thrown error (rfc9457)', async () => {
    const app = await appWith();
    try {
      const val = await app.inject({
        method: 'POST',
        url: 'http://localhost/validate',
        body: { name: '' },
      });
      const thr = await app.inject({ method: 'GET', url: 'http://localhost/throw' });

      // Both answer in Problem Details — the same content type and member set.
      expect(val.headers.get('content-type')).toBe('application/problem+json');
      expect(thr.headers.get('content-type')).toBe('application/problem+json');

      const v = JSON.parse(val.body as string) as Record<string, unknown>;
      const t = JSON.parse(thr.body as string) as Record<string, unknown>;
      expect(v.type).toBe('https://setu-ts.dev/errors/validation');
      expect(v.title).toBe('Validation Error');
      expect(v.status).toBe(400);
      expect(t.type).toBe('about:blank');
      expect(t.title).toBe('Internal Server Error');
      expect(t.status).toBe(500);
      // Neither carries the pre-M56 default `message` field.
      expect(v.message).toBeUndefined();
      expect(t.message).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  it('an explicit options.validation.errorFormat wins (default formatter)', async () => {
    const app = await appWith({ validation: { errorFormat: 'default' } });
    try {
      const val = await app.inject({
        method: 'POST',
        url: 'http://localhost/validate',
        body: { name: '' },
      });

      // The override wins: the validation failure is the default shape, NOT
      // Problem Details.
      expect(val.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const v = JSON.parse(val.body as string) as Record<string, unknown>;
      expect(v.type).toBeUndefined();
      expect(v.message).toBe('Validation failed with 1 issue(s).');
      expect(v.errors).toEqual([{ field: 'name', message: 'name is required' }]);
    } finally {
      await app.stop();
    }
  });
});
