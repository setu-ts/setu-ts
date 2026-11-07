import { describe, it } from 'node:test';
import assert from 'node:assert';
import { startTestServer } from '../../../test/support/server.ts';

// These tests use the memory store; `npm run smoke` covers pgvector.
delete process.env['PGVECTOR_URL'];

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
      // Whitespace-only text has no chunk to index; replacing the source with
      // none would delete the document's earlier chunks after a 202.
      const blank = await fetch(server.baseUrl + '/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: JSON.stringify({ id: 'readme', text: ' \n\t ' }),
      });
      assert.deepStrictEqual(blank.status, 400);
      await blank.text();
      const spec = await fetch(server.baseUrl + '/openapi.json');
      type Operation = { parameters?: { name: string; in: string; required?: boolean }[] };
      const document: { paths: Record<string, Record<string, Operation>> } = await spec.json();
      // Swagger's "Try it out" can only send the tenant if the header is declared.
      for (const [path, method] of [
        ['/documents', 'post'],
        ['/documents/search', 'get'],
      ] as const) {
        const header = document.paths[path]?.[method]?.parameters?.find(
          (parameter) => parameter.name === 'x-tenant-id',
        );
        assert.deepStrictEqual([header?.in, header?.required], ['header', true], path);
      }
    } finally {
      await server.stop();
    }
  });
});
