import { createRealtimeClientApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createRealtimeClientApp();
await app.start({ hostname: '127.0.0.1', port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  Deno.addSignalListener(signal, () => void app.stop().then(() => Deno.exit()));
}
