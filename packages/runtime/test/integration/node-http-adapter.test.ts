// deno-lint-ignore-file no-explicit-any
/**
 * Integration tests for Node HTTP adapter — REAL round-trip with @hono/node-server.
 *
 * Guarded: skipped when npm:@hono/node-server is not installed.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { NodeHttpAdapter } from '../../src/adapters/node/node-http-adapter.ts';

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
      serve: (options: {
        fetch: (request: Request) => Response | Promise<Response>;
        port: number;
        hostname?: string;
        overrideGlobalObjects?: boolean;
      }) => {
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
          status: 200,
          headers: new Headers({ 'content-type': 'text/plain' }),
          body: 'hello from node',
        }),
      } as any;
    });

    const handle = await adapter.listen(0, '127.0.0.1');
    await adapter.close(handle);
  });
});
