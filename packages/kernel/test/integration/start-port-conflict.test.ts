import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createApplication } from '../../src/index.ts';

it('M131b 3.1 rejects a real port conflict and closes startup resources', async () => {
  const held = createServer();
  await new Promise<void>((resolve, reject) => {
    held.once('error', reject);
    held.listen(0, '127.0.0.1', resolve);
  });
  const address = held.address();
  if (address === null || typeof address === 'string') throw new Error('TCP address expected');
  const close = vi.fn();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      {
        name: 'devtool-style-connector',
        version: '1.0.0',
        register(ctx) {
          ctx.lifecycle.onClose(close);
        },
      },
    ],
  });
  try {
    const result = await Promise.race([
      app.start({ port: address.port, hostname: '127.0.0.1' }).then(
        () => 'unexpected start',
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('start did not reject'), 250)),
    ]);
    expect(result).toMatchObject({ code: 'EADDRINUSE' });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await app.stop();
    await new Promise<void>((resolve, reject) =>
      held.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
