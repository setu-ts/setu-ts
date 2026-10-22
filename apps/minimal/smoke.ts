import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

describe('minimal example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('answers GET / with a greeting', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { hello: 'world' });
  });
});
