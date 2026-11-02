import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp, TENANT_HEADER } from './setu.config.ts';

describe('multi-tenant example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it("keeps one tenant's writes invisible to another", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'acme' },
      body: { text: 'only Acme can read this' },
    });
    assert.equal(created.statusCode, 201);

    const acme = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'acme' },
    });
    const globex = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'globex' },
    });

    assert.equal(acme.json<unknown[]>().length, 1);
    assert.equal(globex.json<unknown[]>().length, 0);
  });

  it('refuses a tenant that is not listed, and creates nothing for it', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'initech' },
      body: { text: 'this tenant does not exist' },
    });
    assert.equal(refused.statusCode, 404);
    assert.deepEqual(refused.json(), {
      error: 'Unknown Tenant',
      detail: 'The request names a tenant that does not exist',
    });

    const read = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'initech' },
    });
    assert.equal(read.statusCode, 404);
  });
});
