/** A network-permitted subprocess probe for decorated WebSocket ingress. */
import type { IWebSocketConnection } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

import { Gateway, OnMessage } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket open.')),
      5_000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WebSocket errored before opening.'));
    };
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket message.')),
      5_000,
    );
    socket.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(event.data));
    };
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.onclose = () => resolve();
  });
}

@Gateway('/ws/updates')
class UpdatesGateway {
  @OnMessage
  message(connection: IWebSocketConnection, data: string | Uint8Array): void {
    connection.send(`echo:${String(data)}`);
  }
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    WebSocketPlugin({ scalingNotice: false }),
    DecoratorPlugin({ ingress: [UpdatesGateway] }),
  ],
});
const port = freePort();
await app.start({ port });
const sockets = app.services.get<{ readonly connectionCount: number }>(CAPABILITIES.WEBSOCKET);
const client = new WebSocket(`ws://127.0.0.1:${port}/ws/updates`);
try {
  await opened(client);
  const reply = nextMessage(client);
  client.send('hello');
  if (await reply !== 'echo:hello') {
    throw new Error('The decorated gateway did not echo the frame.');
  }
  if (sockets.connectionCount !== 1) {
    throw new Error('The decorated gateway did not retain the connected socket.');
  }
} finally {
  client.close();
  await closed(client);
  await app.stop();
}
