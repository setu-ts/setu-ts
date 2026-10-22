import { describe, it, expect } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin, NodeHttpAdapter } from '@setu-ts/runtime';
import { defaultRateLimitKey } from '../../src/index.ts';

describe('peer rate-limit identity on the real Node adapter', () => {
  it('keys an unauthenticated socket caller as ip:127.0.0.1', async () => {
    const adapter = new NodeHttpAdapter();
    const app = createApplication({
      plugins: [RuntimePlugin({ httpAdapters: { node: () => adapter } })],
    });
    app.router.get('/', (ctx) => ctx.response.text(defaultRateLimitKey(ctx)));
    await app.start();
    const handle = await adapter.listen(0, '::');
    try {
      const server = (
        handle as unknown as {
          server: { address(): { port: number } | null; once(event: string, fn: () => void): void };
        }
      ).server;
      if (server.address() === null)
        await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = server.address()!.port;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe('ip:127.0.0.1');
    } finally {
      await adapter.close(handle);
      await app.stop();
    }
  });
});
