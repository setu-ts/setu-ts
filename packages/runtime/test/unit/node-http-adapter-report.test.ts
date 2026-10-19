/**
 * The Node handshake-failure report (M113h §3.8c).
 *
 * Only the handshake catch is reported — it is the SERVER-side fault (`ws`
 * absent, or `ws` itself throwing), never a client-triggerable path. A fault
 * reports once per distinct message per handle, so a missing `ws` does not log
 * on every upgrade, and the wire refusal stays a bare 500 either way.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';
import { serializeError, setUpgradeIntent } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import type { HttpAdapterOptions } from '../../src/adapters/shared/adapter-options.ts';
import { NodeHttpServerHandle } from '../../src/adapters/node/node-http-adapter.ts';
import type { WsModuleLike } from '../../src/adapters/node/node-ws-upgrader.ts';

interface FakeSocket {
  readonly written: readonly string[];
  readonly destroyed: boolean;
}

interface UpgradeDriver {
  /** Fires one raw upgrade and resolves once the refusal has run. */
  fire(): Promise<FakeSocket>;
}

/**
 * Drives the raw `upgrade` event the way `@hono/node-server`'s server does:
 * a request whose handler brands an upgrade intent, over a raw socket.
 */
function createDriver(options: HttpAdapterOptions, wsModule?: WsModuleLike): UpgradeDriver {
  const handle = new NodeHttpServerHandle(wsModule, options);
  handle.setUpgradeRouter(() => Promise.resolve(null));

  let closeRefusal: (() => void) | undefined;
  handle.setHandler((request) => {
    setUpgradeIntent(request, {
      sink: {
        onOpen() {},
        onMessage() {},
        onError() {},
        onClose() {
          closeRefusal?.();
        },
      },
    });
    return createTestContext().response;
  });

  let listener: ((...args: never[]) => void) | undefined;
  const server = {
    close() {},
    on(_event: string, fn: (...args: never[]) => void) {
      listener = fn;
    },
  };
  handle.attachUpgradeListener(server);

  return {
    async fire(): Promise<FakeSocket> {
      const written: string[] = [];
      let destroyed = false;
      const socket = {
        write(data: string): void {
          written.push(data);
        },
        destroy(): void {
          destroyed = true;
        },
      };

      const refused = Promise.withResolvers<void>();
      closeRefusal = refused.resolve;
      listener!(
        ...([
          { url: '/ws', headers: { host: 'localhost' } },
          socket,
          new Uint8Array(),
        ] as unknown as never[]),
      );
      await refused.promise;

      return {
        get written() {
          return written;
        },
        get destroyed() {
          return destroyed;
        },
      };
    },
  };
}

describe('NodeHttpServerHandle — handshake-failure report', () => {
  it('reports a missing ws once across upgrades and still refuses 500', async () => {
    // Make the lazy `import('ws')` fail the way an uninstalled optional peer
    // does, so the record must carry `loadWsModule`'s install instruction.
    vi.doMock('ws', () => {
      throw new Error('Cannot find package');
    });
    try {
      const records: Readonly<Record<string, unknown>>[] = [];
      const driver = createDriver({ reportError: (record) => records.push(record) });

      const first = await driver.fire();
      const second = await driver.fire();

      expect(records).toHaveLength(1);
      expect(records[0]!['level']).toBe('error');
      expect(records[0]!['msg']).toBe('WebSocket handshake failed');
      expect(String(records[0]!['message'])).toContain('npm install ws');
      // The record is `serializeError` of the cause, not the request.
      expect(records[0]).not.toHaveProperty('path');
      expect(records[0]).not.toHaveProperty('url');

      for (const socket of [first, second]) {
        expect(socket.written.join('')).toContain('HTTP/1.1 500 Internal Server Error');
        expect(socket.destroyed).toBe(true);
      }
    } finally {
      vi.doUnmock('ws');
    }
  });

  it('reports each distinct message once and caps the set at 16', async () => {
    let attempt = 0;
    const wsModule = {
      WebSocketServer: class {
        handleUpgrade(): void {
          attempt++;
          throw new Error(`handshake failure ${attempt}`);
        }
        close(): void {}
      },
    } as unknown as WsModuleLike;

    const records: Readonly<Record<string, unknown>>[] = [];
    const driver = createDriver({ reportError: (record) => records.push(record) }, wsModule);

    for (let index = 0; index < 17; index++) {
      await driver.fire();
    }

    expect(records).toHaveLength(16);
    expect(records.map((record) => record['message'])).toEqual(
      Array.from({ length: 16 }, (_, index) => `handshake failure ${index + 1}`),
    );
  });

  it('refuses 500 silently when no reporter is configured', async () => {
    const wsModule = {
      WebSocketServer: class {
        handleUpgrade(): void {
          throw new Error('boom');
        }
        close(): void {}
      },
    } as unknown as WsModuleLike;

    const socket = await createDriver({}, wsModule).fire();

    expect(socket.written.join('')).toContain('HTTP/1.1 500 Internal Server Error');
    expect(socket.destroyed).toBe(true);
  });

  it('swallows a reporter that throws, still refusing 500', async () => {
    const wsModule = {
      WebSocketServer: class {
        handleUpgrade(): void {
          throw new Error('boom');
        }
        close(): void {}
      },
    } as unknown as WsModuleLike;

    const socket = await createDriver(
      {
        reportError: () => {
          throw new Error('sink broke');
        },
      },
      wsModule,
    ).fire();

    expect(socket.written.join('')).toContain('HTTP/1.1 500 Internal Server Error');
  });

  it('serializes the refusal cause for a non-Error value', async () => {
    // `serializeError` accepts any thrown value; a consumer's `ws` shim may
    // throw a string. The report still describes it instead of throwing.
    const wsModule = {
      WebSocketServer: class {
        handleUpgrade(): void {
          throw 'not-an-error';
        }
        close(): void {}
      },
    } as unknown as WsModuleLike;

    const records: Readonly<Record<string, unknown>>[] = [];
    await createDriver({ reportError: (record) => records.push(record) }, wsModule).fire();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject(serializeError('not-an-error'));
  });
});
