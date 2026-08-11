// deno-lint-ignore-file no-console -- interactive example entry point.
import { createRealtimeReplica } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createRealtimeReplica(
  Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379',
);
await app.start({ port });
console.log(`Realtime replica listening at http://localhost:${port}`);

// Graceful shutdown. Deno's default SIGTERM action ends the process immediately, so without this
// listener `app.stop()` never runs under Kubernetes — here that would also leave the Redis
// backplane subscription open rather than closing it. See docs/deployment.md.
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
