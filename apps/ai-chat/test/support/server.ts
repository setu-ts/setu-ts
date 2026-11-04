import { createServer } from 'node:net';
import { createApp } from '../../setu.config.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No TCP port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Boots the real application on a free loopback port. */
export async function startTestServer(): Promise<{
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}> {
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    const app = await createApp();
    try {
      await app.start({ port, hostname: '127.0.0.1' });
      return {
        baseUrl: `http://127.0.0.1:${port}`,
        stop: async () => {
          await app.stop();
        },
      };
    } catch (error) {
      try {
        await app.stop();
      } catch {
        // Cleanup must not replace the start error or prevent a bind retry.
      }
      if (
        attempt >= 2 ||
        !(error instanceof Error) ||
        !(
          ('code' in error && error.code === 'EADDRINUSE') ||
          /EADDRINUSE|address already in use/i.test(error.message)
        )
      )
        throw error;
    }
  }
}
