import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';

describe('application composition', () => {
  it('serves its smoke-test endpoint', async () => {
    const app = await createTestApp({ app: await createApp() });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.deepStrictEqual(response.statusCode, 200);
    } finally {
      await app.stop();
    }
  });

  it('documents the per-route rate limit on a limited route', async () => {
    const app = await createTestApp({ app: await createApp() });
    try {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = response.json() as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };
      const tooMany = spec.paths['/items']?.['get']?.responses['429'] as
        { headers?: Record<string, unknown> } | undefined;
      assert.ok(tooMany, 'GET /items documents a 429');
      assert.ok(tooMany.headers?.['Retry-After'], 'the 429 documents Retry-After');
    } finally {
      await app.stop();
    }
  });
});
