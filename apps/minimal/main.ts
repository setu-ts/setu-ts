// deno-lint-ignore-file no-console -- interactive example entry point.
import { createRuntimeServices } from '@setu-ts/runtime';
import { createMinimalApp } from './src/app.ts';

const runtime = createRuntimeServices();
const port = Number(Deno.args[0] ?? 3000);
const app = createMinimalApp();
await app.start({ port });
console.log(`Minimal app listening at http://localhost:${port}`);

// Graceful shutdown. Kubernetes sends SIGTERM and waits `terminationGracePeriodSeconds` before
// SIGKILL, but the default action for SIGTERM ends the process immediately — measured at 144 ms
// with exit code 143 — so without this listener `app.stop()` never runs: in-flight requests are
// cut and every onStopping/onShutdown hook (service-discovery deregistration, database and broker
// disconnects) is skipped.
//
// Portable across Deno, Node and Bun: `onSignal` is absent where no signal can be caught (Windows,
// Workers), so the optional call registers nothing there. This is the same block `setu new`
// writes into every generated `main.ts` — see docs/deployment.md.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    // .catch is not optional: a rejecting onShutdown hook (a database that fails to
    // disconnect, a broker close that times out) makes stop() reject, and without this the
    // process dies with "Uncaught (in promise)" instead of reporting why.
    void app.stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        console.error('Graceful shutdown failed:', error);
        runtime.exit(1);
      });
  });
}
