import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { freePort } from '../smoke-helpers.ts';
import { createEchoClient } from './src/modules/echo/echo.client.ts';
import { createApp } from './setu.config.ts';

describe('grpc example', () => {
  let app: IKernelApplication;
  let baseUrl: string;

  before(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = createApp();
    await app.start({ port });
  });

  after(async () => {
    await app.stop();
  });

  it('answers a Connect RPC at the root path', async () => {
    const response = await createEchoClient(baseUrl).echo({ message: 'from the example' });

    assert.equal(response.response, 'echo: from the example');
  });

  it('serves an ordinary HTTP route on the same port', async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});
