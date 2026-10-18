import { describe, it, expect } from 'vitest';
import { createTestContext } from '@setu-ts/testing';
import { NodeHttpAdapter, DenoHttpAdapter } from '../../src/index.ts';

describe('default host socket peers', () => {
  for (const runtime of ['Node', 'Deno']) {
    describe(
      runtime,
      { skip: runtime === 'Deno' ? typeof Deno === 'undefined' : typeof Deno !== 'undefined' },
      () => {
        for (const hostname of ['::', '0.0.0.0']) {
          it(`${hostname} reports an IPv4 peer as 127.0.0.1`, async () => {
            const adapter = runtime === 'Node' ? new NodeHttpAdapter() : new DenoHttpAdapter();
            adapter.setHandler((request) => {
              const { response } = createTestContext();
              response.text(request.ip ?? 'absent');
              return response;
            });
            const handle = await adapter.listen(0, hostname);
            try {
              const server = (
                handle as unknown as {
                  server: {
                    address?: () => { port: number } | null;
                    once(event: string, fn: () => void): void;
                    addr?: { port: number };
                  };
                }
              ).server;
              if (server.address?.() === null)
                await new Promise<void>((resolve) => server.once('listening', resolve));
              const port = server.address?.()?.port ?? server.addr!.port;
              const response = await fetch(`http://127.0.0.1:${port}/`);
              expect(await response.text()).toBe('127.0.0.1');
            } finally {
              await adapter.close(handle);
            }
          });
        }
      },
    );
  }
});
