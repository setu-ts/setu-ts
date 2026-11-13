/**
 * Guarded REAL-import test for `ws`.
 *
 * Every other Node-upgrade test drives an injected fake module, so this is the
 * one place the actual `import('npm:ws@^8.18.0')` inside `loadWsModule` runs.
 * Without it, a fake that agreed with our assumptions but not with the real
 * package would go unnoticed (CLAUDE.md: at least one test must exercise the
 * REAL load path).
 *
 * Skipped when `ws` cannot be resolved, so the suite stays green in an
 * environment without the optional dependency installed.
 */

import { describe, expect, it } from 'vitest';
import { loadWsModule, NodeUpgradeCoordinator } from '../../src/adapters/node/node-ws-upgrader.ts';
import { createServer } from 'node:http';
import type { IWebSocketTransport } from '@setu-ts/common';

/** Probes once whether the optional dependency is resolvable. */
const wsAvailable = await (async (): Promise<boolean> => {
  try {
    await loadWsModule();
    return true;
  } catch {
    return false;
  }
})();

describe('loadWsModule (real npm:ws)', () => {
  it(
    'refuses 1 MiB + 1 while reading, before delivering to the sink',
    { skip: !wsAvailable, timeout: 15_000 },
    async () => {
      const coordinator = new NodeUpgradeCoordinator(await loadWsModule());
      let transport: IWebSocketTransport | undefined;
      let delivered = 0;
      const server = createServer();
      server.on('upgrade', (request, socket, head) => {
        void coordinator
          .handshake(request, socket, head, {
            maxMessageBytes: 1_048_576,
            onOpen(value) {
              transport = value;
            },
            onMessage() {
              delivered++;
              transport!.send('accepted');
            },
            onError() {},
            onClose() {},
          })
          .catch(() => socket.destroy());
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected an IP listener');
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      try {
        await new Promise<void>((resolve, reject) => {
          client.onopen = () => resolve();
          client.onerror = () => reject(new Error('Handshake failed'));
        });
        const accepted = new Promise<string>((resolve) => {
          client.onmessage = (event) => resolve(String(event.data));
        });
        client.send('x'.repeat(1_048_576));
        expect(await accepted).toBe('accepted');
        expect(delivered).toBe(1);
        const closed = new Promise<number>((resolve) => {
          client.onclose = (event) => resolve(event.code);
        });
        client.send('x'.repeat(1_048_577));
        expect(await closed).toBe(1009);
        expect(delivered).toBe(1);
      } finally {
        client.close();
        transport?.close();
        coordinator.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it('resolves the real ws module and satisfies WsModuleLike', { skip: !wsAvailable }, async () => {
    const module = await loadWsModule();

    expect(typeof module.WebSocketServer).toBe('function');
  });

  it(
    'constructs a real noServer WebSocketServer with a protocol selector',
    { skip: !wsAvailable },
    async () => {
      const { WebSocketServer } = await loadWsModule();

      // The exact shape the Node adapter builds — proving the real constructor
      // accepts it, not just that our fake does.
      const server = new WebSocketServer({
        noServer: true,
        handleProtocols: () => 'chat',
      });
      try {
        expect(typeof server.handleUpgrade).toBe('function');
        expect(typeof server.close).toBe('function');
      } finally {
        server.close();
      }
    },
  );
});
