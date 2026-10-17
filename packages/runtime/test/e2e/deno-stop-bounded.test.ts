import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '../../src/index.ts';

describe('Deno stop bound', () => {
  it('runs onClose within the drain bound while a real request remains in flight', async () => {
    const entered = Promise.withResolvers<void>();
    let requestSettled = false;
    let closeRan = false;
    let closeBeforeSettlement = false;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'stop-proof',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onClose(() => {
              closeRan = true;
              closeBeforeSettlement = !requestSettled;
            });
          },
        },
      ],
    });
    app.router.get('/slow', async (ctx) => {
      entered.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 25_000));
      requestSettled = true;
      return ctx.response.text('finished');
    });
    await app.start({ port: 18769, hostname: '127.0.0.1' });
    const request = fetch('http://127.0.0.1:18769/slow').then((response) => response.text());
    try {
      await entered.promise;
      const start = performance.now();
      await app.stop();
      expect(performance.now() - start).toBeLessThan(12_000);
      expect(closeRan).toBe(true);
      expect(closeBeforeSettlement).toBe(true);
      expect(requestSettled).toBe(false);
    } finally {
      await app.stop();
      await request;
    }
  });
});
