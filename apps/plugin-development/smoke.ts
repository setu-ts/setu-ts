import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

describe('plugin-development example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it("serves the plugin's route through the capability it registered", async () => {
    const response = await app.inject({ method: 'GET', url: '/greet/Ada' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { message: 'Hello, Ada!' });
  });
});
