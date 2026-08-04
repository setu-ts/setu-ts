// deno-lint-ignore-file no-console -- interactive example entry point.
import { createRestExampleApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createRestExampleApp();
await app.start({ port });
console.log(`REST API listening at http://localhost:${port}`);
