// deno-lint-ignore-file no-console -- interactive example entry point.
import { createRealtimeReplica } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createRealtimeReplica(Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379');
await app.start({ port });
console.log(`Realtime replica listening at http://localhost:${port}`);

// Graceful shutdown. Deno's default SIGTERM action ends the process immediately, so without this
// listener `app.stop()` never runs under Kubernetes — here that would also leave the Redis
// backplane subscription open rather than closing it. See docs/deployment.md.
if (Deno.build.os !== 'windows') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    Deno.addSignalListener(signal, () => {
      void app.stop().then(() => Deno.exit(0));
    });
  }
}
