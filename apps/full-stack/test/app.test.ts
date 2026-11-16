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
      // The SSR home page streams, which inject() refuses — request it
      // through fetch, and consume the body so the resource sanitizer
      // does not report a leak.
      const page = await app.fetch(new Request('http://localhost/'));
      assert.deepStrictEqual(page.status, 200);
      await page.text();
    } finally {
      await app.stop();
    }
  });
});
