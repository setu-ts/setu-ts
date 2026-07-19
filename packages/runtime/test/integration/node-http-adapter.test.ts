// deno-lint-ignore-file no-explicit-any
/**
 * Integration tests for Node HTTP adapter — REAL round-trip with @hono/node-server.
 *
 * Guarded: skipped when npm:@hono/node-server is not installed.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NodeHttpAdapter } from '../../src/adapters/node/node-http-adapter.ts';

/**
 * Finds a free TCP port by binding one and releasing it.
 */
function findFreePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

describe('node-http-adapter integration', () => {
  it('guarded real @hono/node-server round-trip', async () => {
    // Guarded real import
    let serve: (options: {
      fetch: (request: Request) => Response | Promise<Response>;
      port: number;
      hostname?: string;
    }) => { close(): void };

    try {
      const mod = await import('npm:@hono/node-server@^2.0.0');
      serve = mod.serve;
    } catch {
      // Package not installed — skip
      return;
    }

    // Build a fake NodeServeHost that uses the real import
    const host = {
      serve: async (options: {
        fetch: (request: Request) => Response | Promise<Response>;
        port: number;
        hostname?: string;
        overrideGlobalObjects?: boolean;
      }): Promise<{ close(): void }> => {
        // Await Promise.resolve to satisfy deno lint require-await rule for the fake host wrapper
        await Promise.resolve();
        return serve(
          {
            fetch: options.fetch,
            port: options.port,
            ...(options.hostname !== undefined && { hostname: options.hostname }),
            overrideGlobalObjects: false,
          } as Parameters<typeof serve>[0],
        ) as unknown as { close(): void };
      },
    };

    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({
          status: 201,
          headers: new Headers({ 'content-type': 'text/plain', 'x-adapter': 'node' }),
          body: 'hello from node',
        }),
      } as any;
    });

    const port = findFreePort();
    const handle = await adapter.listen(port, '127.0.0.1');

    // C1 test: verify the server handle is a real object, not a Promise
    const serverHandle = (handle as any).server;
    if (serverHandle === null || serverHandle === undefined) {
      throw new Error('C1 regression: server handle is null after listen');
    }
    if (typeof serverHandle.close !== 'function') {
      throw new Error('C1 regression: server.handle.close is not a function (likely a Promise)');
    }

    try {
      // REAL request over the bound socket, through @hono/node-server into the
      // adapter's fetch handler and back out — proves the full round-trip, not
      // just that the server binds. @hono/node-server binds asynchronously, so
      // retry the connect briefly until the socket is listening.
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/hello`);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (response === undefined) {
        throw new Error('server never became reachable');
      }
      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(response.headers.get('x-adapter')).toBe('node');
      expect(await response.text()).toBe('hello from node');
    } finally {
      await adapter.close(handle);
    }
  });
});
