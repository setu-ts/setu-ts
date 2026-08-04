// deno-lint-ignore-file no-console -- interactive example entry point.
import { createDatabaseApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createDatabaseApp();
await app.start({ port });
console.log(`Database example listening on http://127.0.0.1:${port}`);
