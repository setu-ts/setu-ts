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

  it('shares singletons and creates a distinct scoped service for each request', async () => {
    const first = await app.inject({ method: 'GET', url: '/lifetimes/' });
    const second = await app.inject({ method: 'GET', url: '/lifetimes/' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const a = first.json<LifetimesReport>();
    const b = second.json<LifetimesReport>();
    assert.equal(a.singletonShared, true);
    assert.equal(b.singletonShared, true);
    assert.equal(a.scopeRetainsInstance, true);
    assert.equal(b.scopeRetainsInstance, true);
    assert.notEqual(a.scopedId, b.scopedId);
  });
});
