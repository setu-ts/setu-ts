import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from '../support/server.ts';

describe('application e2e', () => {
  it('serves its public endpoints over HTTP', async () => {
    const server = await startTestServer();
    try {
      for (const path of ['/', '/health', '/ready']) {
        const response = await fetch(server.baseUrl + path);
        assert.deepStrictEqual(response.status, 200);
        await response.text();
      }
    } finally {
      await server.stop();
    }
  });
});
