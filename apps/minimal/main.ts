// deno-lint-ignore-file no-console -- interactive example entry point.
import { createMinimalApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createMinimalApp();
await app.start({ port });
console.log(`Minimal app listening at http://localhost:${port}`);

// Graceful shutdown. Kubernetes sends SIGTERM and waits `terminationGracePeriodSeconds` before
// SIGKILL, but Deno's DEFAULT action for SIGTERM ends the process immediately — measured at 144 ms
// with exit code 143 — so without this listener `app.stop()` never runs: in-flight requests are
// cut and every onStopping/onShutdown hook (service-discovery deregistration, database and broker
// disconnects) is skipped.
//
// The framework deliberately does not install this for you: a library that grabs process signals
// on import has a side effect at import time, and signal APIs are runtime-specific. This is the
// recommended application-level pattern — see docs/deployment.md.
if (Deno.build.os !== 'windows') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.addSignalListener(signal, () => {
      // .catch is not optional: a rejecting onShutdown hook (a database that fails to
      // disconnect, a broker close that times out) makes stop() reject, and without this the
      // process dies with "Uncaught (in promise)" instead of reporting why.
      void app.stop()
        .then(() => Deno.exit(0))
        .catch((error: unknown) => {
          console.error('Graceful shutdown failed:', error);
          Deno.exit(1);
        });
    });
  }
}
