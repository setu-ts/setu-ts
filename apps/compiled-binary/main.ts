// deno-lint-ignore-file no-console -- interactive example entry point.
import { createCompiledApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createCompiledApp();
await app.start({ port });
console.log(`Compiled-binary example listening at http://localhost:${port}/health`);
