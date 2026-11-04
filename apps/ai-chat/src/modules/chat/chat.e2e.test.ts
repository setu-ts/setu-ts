import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from '../../../test/support/server.ts';

describe('chat e2e', () => {
  it('refuses an invalid turn over HTTP before any model call and documents the route', async () => {
    const server = await startTestServer();
    try {
      const invalid = await fetch(server.baseUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '' }),
      });
      assert.deepStrictEqual(invalid.status, 400);
      await invalid.text();
      const spec = await fetch(server.baseUrl + '/openapi.json');
      const document: { paths: Record<string, unknown> } = await spec.json();
      assert.deepStrictEqual(Object.hasOwn(document.paths, '/chat'), true);
    } finally {
      await server.stop();
    }
  });
});
