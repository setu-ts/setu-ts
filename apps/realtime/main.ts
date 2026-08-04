// deno-lint-ignore-file no-console -- interactive example entry point.
import { createRealtimeReplica } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createRealtimeReplica(Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379');
await app.start({ port });
console.log(`Realtime replica listening at http://localhost:${port}`);
