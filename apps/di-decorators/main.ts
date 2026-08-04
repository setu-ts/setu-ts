// deno-lint-ignore-file no-console -- interactive example entry point.
import { createDiDecoratorsApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createDiDecoratorsApp();
await app.start({ port });
console.log(`DI and decorator example listening on http://127.0.0.1:${port}`);
