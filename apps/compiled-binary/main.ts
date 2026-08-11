// deno-lint-ignore-file no-console -- interactive example entry point.
import { createCompiledApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createCompiledApp();
await app.start({ port });
console.log(`Compiled-binary example listening at http://localhost:${port}/health`);

// Graceful shutdown. Deno's default SIGTERM action ends the process immediately, so without this
// listener `app.stop()` never runs under Kubernetes and every onStopping/onShutdown hook is
// skipped. The framework does not install this for you — see docs/deployment.md.
if (Deno.build.os !== 'windows') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.addSignalListener(signal, () => {
      void app.stop().then(() => Deno.exit(0));
    });
  }
}
