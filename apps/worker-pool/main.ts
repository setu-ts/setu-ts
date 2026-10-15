/* eslint-disable no-console -- interactive example entry point. */
import { createWorkerPoolApp } from './src/app.ts';

const app = createWorkerPoolApp();
const port = Number(process.env['PORT'] ?? 3000);
await app.start({ port, hostname: '127.0.0.1' });
console.log(`Worker pool example listening on http://127.0.0.1:${port}/health`);
