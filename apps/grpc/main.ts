// deno-lint-ignore-file no-console -- interactive example entry point.
import { createGrpcApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 5000);
const app = createGrpcApp();
await app.start({ port });
console.log(`gRPC example HTTP health endpoint: http://localhost:${port}/health`);
