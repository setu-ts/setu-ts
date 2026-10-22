import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

describe('graphql-demo example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('answers a basic query', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      body: { query: '{ hello }' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { hello: 'world' } });
  });
});
