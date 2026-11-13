/**
 * Unit test for the rest-starter's C3 fix: by default a validation failure
 * answers in the SAME format as a thrown error (both `application/problem+json`
 * under `errorHandler({ format: 'rfc9457' })`), and an explicit
 * `options.validation.errorFormat` still wins (plan §3.7, C3).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { buildRestPlugins, createRestApp } from '../../src/index.ts';
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

describe('rest-starter OpenAPI error schema follows the validation format (M137b §3.8)', () => {
  /** The documented `POST /validate` responses and the document's components. */
  async function documented(opts?: Parameters<typeof createRestApp>[0]) {
    const app = await appWith({ ...opts, openapi: { swagger: false, ...opts?.openapi } });
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
      const doc = JSON.parse(res.body as string) as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
        components?: { schemas?: Record<string, unknown> };
      };
      return {
        responses: doc.paths['/validate']?.['post']?.responses ?? {},
        schemas: doc.components?.schemas ?? {},
      };
    } finally {
      await app.stop();
    }
  }

  it('documents the 400 as Problem Details under the default rfc9457 format', async () => {
    const { responses, schemas } = await documented();
    expect(responses['400']).toEqual({
      description: 'Bad request',
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
    });
    expect(schemas['ProblemDetails']).toBeDefined();
  });

  it.each(['nestjs', 'default'] as const)(
    'names no Problem Details body when validation answers in %s format',
    async (errorFormat) => {
      const { responses, schemas } = await documented({ validation: { errorFormat } });
      expect(responses['400']).toEqual({ description: 'Bad request' });
      expect(schemas['ProblemDetails']).toBeUndefined();
    },
  );

  it('keeps an explicit openapi.errorSchema even when validation answers in another format', async () => {
    const { responses } = await documented({
      validation: { errorFormat: 'nestjs' },
      openapi: { errorSchema: 'rfc9457' },
    });
    expect(responses['400']).toHaveProperty(['content', 'application/problem+json']);
  });

  it('names no Problem Details body from buildRestPlugins, which installs no errorHandler', async () => {
    const app = createApplication({ plugins: buildRestPlugins({ openapi: { swagger: false } }) });
    app.router.post('/validate', {
      middleware: [validateBody(failingSchema)],
      handler: (ctx) => ctx.response.text('ok'),
    });
    await app.start();
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
      const doc = JSON.parse(res.body as string) as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
        components?: { schemas?: Record<string, unknown> };
      };
      expect(doc.paths['/validate']?.['post']?.responses['400']).toEqual({
        description: 'Bad request',
      });
      expect(doc.components?.schemas?.['ProblemDetails']).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
