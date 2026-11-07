import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from '../support/server.ts';

delete process.env['DATABASE_URL'];

describe('application e2e', () => {
  it('serves its public endpoints over HTTP', async () => {
    const server = await startTestServer();
    try {
      for (const path of ['/health', '/ready', '/orders', '/ui/', '/openapi.json']) {
        const response = await fetch(server.baseUrl + path);
        assert.deepStrictEqual(response.status, 200, path);
        await response.text();
      }
      const root = await fetch(server.baseUrl + '/', { redirect: 'manual' });
      assert.deepStrictEqual(root.headers.get('location'), '/ui/');
      await root.text();
    } finally {
      await server.stop();
    }
  });
});
