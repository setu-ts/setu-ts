/* eslint-disable no-console -- interactive example entry point. */
import { createRestExampleApp } from './src/app.ts';

const port = Number(process.argv[2] ?? 3000);
const app = createRestExampleApp();
await app.start({ port });
console.log(`REST API listening at http://localhost:${port}`);

// Graceful shutdown. The default SIGTERM action ends the process immediately, so without this
// listener `app.stop()` never runs under Kubernetes and every onStopping/onShutdown hook is
// skipped. The framework does not install this for you — see docs/deployment.md.
if (process.platform !== 'win32') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // .catch is not optional: a rejecting onShutdown hook (a database that fails to
      // disconnect, a broker close that times out) makes stop() reject, and without this the
      // process dies with "Uncaught (in promise)" instead of reporting why.
      void app
        .stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error('Graceful shutdown failed:', error);
          process.exit(1);
        });
    });
  }
}
