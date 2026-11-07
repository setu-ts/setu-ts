import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';
import { issueDemoToken } from '../../../token.ts';
import { startTestServer } from '../../../test/support/server.ts';

describe('items e2e', () => {
  it('creates and reads a record over HTTP', async () => {
    const auth = await createTestApp({ app: createApp() });
    const authorization = 'Bearer ' + (await issueDemoToken(auth));
    await auth.stop();
    const server = await startTestServer();
    try {
      const created = await fetch(server.baseUrl + '/items', {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'e2e-create',
        },
        body: JSON.stringify({ name: 'Example' }),
      });
      assert.deepStrictEqual(created.status, 201);
      const record: { id: string; name: string } = await created.json();
      assert.deepStrictEqual(record.name, 'Example');
      const read = await fetch(server.baseUrl + '/items/' + record.id, {
        headers: { authorization },
      });
      assert.deepStrictEqual(read.status, 200);
      assert.deepStrictEqual(await read.json(), record);
      const invalid = await fetch(server.baseUrl + '/items', {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'e2e-create',
        },
        body: '{}',
      });
      assert.deepStrictEqual(invalid.status, 400);
      await invalid.text();
      const spec = await fetch(server.baseUrl + '/openapi.json');
      const document: { paths: Record<string, unknown> } = await spec.json();
      assert.deepStrictEqual(Object.hasOwn(document.paths, '/items'), true);
    } finally {
      await server.stop();
    }
  });
});
