import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';

delete process.env['DATABASE_URL'];

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
});
