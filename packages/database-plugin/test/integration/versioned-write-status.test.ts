/**
 * A versioned write's conflict and not-found reach the client as RFC 9457
 * Problem Details through `errorHandler` with no application code (M128, plan
 * §3.6): the whole path — a route, the plugin's memory database, the helper,
 * the pipeline and the error handler — asserted field by field, forbidden
 * fields included.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { DatabasePlugin, MemoryAdapter, updateVersioned } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

interface Article {
  id: string;
  title: string;
  version: number;
}

async function appWithArticle() {
  const app = createApplication({
    plugins: [RuntimePlugin(), DatabasePlugin({ type: 'custom', adapter: new MemoryAdapter() })],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });
  app.router.put('/articles/:id', {
    handler: async (ctx) => {
      const repo = ctx.services
        .get<IDatabaseService>(CAPABILITIES.DATABASE)
        .getRepository<Article>('Article');
      const body = (await ctx.request.json()) as { title: string; version: number };
      const updated = await updateVersioned(
        repo,
        ctx.params['id']!,
        Number(body.version),
        { title: body.title },
        { entity: 'Article' },
      );
      return ctx.response.json(updated);
    },
  });
  await app.start();
  await app.services
    .get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Article>('Article')
    .create({ id: 'art-7731', title: 'first', version: 41 });
  return app;
}

const put = (id: string, version: number) => ({
  method: 'PUT' as const,
  url: `http://localhost/articles/${id}`,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'changed', version }),
});

describe('versioned write statuses through errorHandler', () => {
  it('answers caller input it refuses with 400, never a masked 500 (audit L2)', async () => {
    const app = await appWithArticle();
    try {
      for (const body of [
        { title: 'x' }, // no version: NaN after a Number() read
        { title: 'x', version: -1 },
        { title: 'x', version: 1.5 },
      ]) {
        const response = await app.inject({
          ...put('art-7731', 0),
          body: JSON.stringify(body),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'The write precondition or its payload is invalid.',
          instance: '/articles/art-7731',
        });
      }
    } finally {
      await app.stop();
    }
  });

  it('answers the current version with the updated row', async () => {
    const app = await appWithArticle();
    try {
      const response = await app.inject(put('art-7731', 41));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 'art-7731', title: 'changed', version: 42 });
    } finally {
      await app.stop();
    }
  });

  for (const { name, id, version, status, title, detail } of [
    {
      name: 'a stale version',
      id: 'art-7731',
      version: 40,
      status: 409,
      title: 'Conflict',
      detail: 'The record was changed after it was read. Reload it and try again.',
    },
    {
      name: 'a missing record',
      id: 'art-9999',
      version: 40,
      status: 404,
      title: 'Not Found',
      detail: 'The record does not exist.',
    },
  ]) {
    it(`answers ${name} with ${status} Problem Details and nothing private`, async () => {
      const app = await appWithArticle();
      try {
        const response = await app.inject(put(id, version));
        expect(response.statusCode).toBe(status);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        const body = response.json<Record<string, unknown>>();
        expect(body).toEqual({
          type: 'about:blank',
          title,
          status,
          detail,
          instance: `/articles/${id}`,
        });
        for (const forbidden of ['message', 'entity', 'version', 'cause', 'stack']) {
          expect(body).not.toHaveProperty(forbidden);
        }
        // `instance` is the request path, so the id may appear there only.
        for (const field of [body['title'], body['detail']]) {
          for (const secret of [id, 'Article', String(version), '41', '42']) {
            expect(String(field)).not.toContain(secret);
          }
        }
        // Nothing was written by the refused request.
        const stored = await app.services
          .get<IDatabaseService>(CAPABILITIES.DATABASE)
          .getRepository<Article>('Article')
          .findById('art-7731');
        expect(stored).toMatchObject({ title: 'first', version: 41 });
      } finally {
        await app.stop();
      }
    });
  }
});
