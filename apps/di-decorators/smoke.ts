import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { LifetimesReport } from './src/modules/lifetimes/lifetimes.controller.ts';
import { createApp } from './setu.config.ts';

describe('di-decorators example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('answers through the service injected into the controller', async () => {
    const response = await app.inject({ method: 'GET', url: '/greetings/' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { greeting: 'Hello, decorators!' });
  });

  it('shares singletons across scopes and keeps scoped instances per scope', async () => {
    const response = await app.inject({ method: 'GET', url: '/lifetimes/' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<LifetimesReport>(), {
      singletonShared: true,
      scopeRetainsInstance: true,
      scopesAreDistinct: true,
    });
  });
});
