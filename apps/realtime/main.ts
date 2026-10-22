/* eslint-disable no-console -- an example entry reports its address and shutdown failures. */
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';

const runtime = createRuntimeServices();
const port = Number(process.argv[2] ?? 3000);
const app = createApp(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');

await app.start({ port });
console.log(`Realtime replica listening on http://localhost:${port}`);

// Without a handler, SIGTERM ends the process before `app.stop()` can run its shutdown hooks,
// which here include closing the Redis backplane subscription.
// `onSignal` is absent where no signal can be caught (Windows). See docs/deployment.md.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        console.error('Graceful shutdown failed:', error);
        runtime.exit(1);
      });
  });
}
