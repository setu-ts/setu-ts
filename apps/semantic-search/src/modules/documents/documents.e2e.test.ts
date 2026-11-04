import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from '../../../test/support/server.ts';

describe('documents e2e', () => {
  it('accepts a document over HTTP, refuses invalid input and documents its routes', async () => {
    const server = await startTestServer();
    try {
      const accepted = await fetch(server.baseUrl + '/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: JSON.stringify({ id: 'readme', text: 'Hello' }),
      });
      assert.deepStrictEqual(accepted.status, 202);
      assert.deepStrictEqual(await accepted.json(), { id: 'readme', status: 'queued' });
      const tenantless = await fetch(server.baseUrl + '/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'readme', text: 'Hello' }),
      });
      assert.deepStrictEqual(tenantless.status, 400);
      await tenantless.text();
      const invalid = await fetch(server.baseUrl + '/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: '{}',
      });
      assert.deepStrictEqual(invalid.status, 400);
      await invalid.text();
      const spec = await fetch(server.baseUrl + '/openapi.json');
      const document: { paths: Record<string, unknown> } = await spec.json();
      assert.deepStrictEqual(Object.hasOwn(document.paths, '/documents'), true);
      assert.deepStrictEqual(Object.hasOwn(document.paths, '/documents/search'), true);
    } finally {
      await server.stop();
    }
  });
});
