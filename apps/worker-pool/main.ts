// deno-lint-ignore-file no-console -- interactive example entry point.
import { createWorkerPoolApp } from './src/app.ts';

const app = createWorkerPoolApp();
const port = Number(Deno.env.get('PORT') ?? 3000);
await app.start({ port });
console.log(`Worker pool example listening on http://localhost:${port}/health`);
