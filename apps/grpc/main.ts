/* eslint-disable no-console -- interactive example entry point. */
import { createGrpcApp } from './src/app.ts';

const port = Number(process.argv[2] ?? 5000);
const app = createGrpcApp();
await app.start({ port });
console.log(`gRPC example HTTP health endpoint: http://localhost:${port}/health`);
