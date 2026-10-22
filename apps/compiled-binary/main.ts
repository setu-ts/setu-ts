/* eslint-disable no-console -- an example entry reports its address and shutdown failures. */
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';

const runtime = createRuntimeServices();
const port = Number(process.argv[2] ?? 3000);
const app = createApp();

await app.start({ port });
console.log(`Compiled-binary example listening on http://localhost:${port}/health`);

// Without a handler, SIGTERM ends the process before `app.stop()` can run its shutdown hooks.
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
