import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '@setu-ts/testing';
import { issueDemoToken } from '../../../token.ts';
import { createApp } from '../../../setu.config.ts';

describe('items module', () => {
  it('lists records and reads a created record back', async () => {
    const app = await createTestApp({ app: await createApp() });
    try {
      const headers = {
        authorization: 'Bearer ' + (await issueDemoToken(app)),
        'idempotency-key': 'module-test',
      };
      const list = await app.inject({ method: 'GET', headers, url: '/items' });
      assert.deepStrictEqual(list.statusCode, 200);
      assert.deepStrictEqual(Array.isArray(list.json<{ items: unknown[] }>().items), true);
      const created = await app.inject({
        method: 'POST',
        headers,
        url: '/items',
        body: { name: 'Example' },
      });
      assert.deepStrictEqual(created.statusCode, 201);
      const record = created.json<{ id: string; name: string }>();
      assert.deepStrictEqual(record.name, 'Example');
      const read = await app.inject({ method: 'GET', headers, url: `/items/${record.id}` });
      assert.deepStrictEqual(read.statusCode, 200);
      assert.deepStrictEqual(read.json(), record);
    } finally {
      await app.stop();
    }
  });
});
