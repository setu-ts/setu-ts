import { createRealtimeClientApp } from './src/app.ts';

const port = Number(process.argv[2] ?? 3000);
const app = createRealtimeClientApp();
await app.start({ hostname: '127.0.0.1', port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void app.stop().then(() => process.exit()));
}
