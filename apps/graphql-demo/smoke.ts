import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { freePort } from '../smoke-helpers.ts';
import { createApp } from './setu.config.ts';

describe('graphql-demo example', () => {
  let app: IKernelApplication;
  let port: number;

  before(async () => {
    port = await freePort();
    app = createApp();
    await app.start({ port });
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

  // X93-1: the examples e2e installs this app outside the workspace with npm,
  // so the WebSocket server needs `ws` in this app's own dependencies. Node's
  // WebSocket client sends no Origin, which the plugin admits, so this proves
  // the transport is installed and reachable, not the Origin check: open the
  // subprotocol, complete the handshake, and close.
  it('acknowledges a graphql-transport-ws connection_init', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql/ws`, 'graphql-transport-ws');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for connection_ack')),
          5_000,
        );
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'connection_init' }));
        });
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string };
          if (message.type === 'connection_ack') {
            clearTimeout(timer);
            resolve();
          }
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('WebSocket failed to open'));
        });
      });
      assert.equal(socket.readyState, WebSocket.OPEN);
    } finally {
      socket.close(1000, 'smoke complete');
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener('close', () => resolve(), { once: true });
        setTimeout(resolve, 1_000);
      });
    }
  });
});
