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
      headers: { [TENANT_HEADER]: 'tenant-a' },
      body: { text: 'only A can read this' },
    });
    assert.equal(created.statusCode, 201);

    const tenantA = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'tenant-a' },
    });
    const tenantB = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { [TENANT_HEADER]: 'tenant-b' },
    });

    assert.equal(tenantA.json<unknown[]>().length, 1);
    assert.equal(tenantB.json<unknown[]>().length, 0);
  });
});
