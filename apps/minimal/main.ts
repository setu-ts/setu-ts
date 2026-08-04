// deno-lint-ignore-file no-console -- interactive example entry point.
import { createMinimalApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createMinimalApp();
await app.start({ port });
console.log(`Minimal app listening at http://localhost:${port}`);
