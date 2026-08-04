// deno-lint-ignore-file no-console -- interactive example entry point.
import { createMultiTenantApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createMultiTenantApp();
await app.start({ port });
console.log(`Multi-tenant example listening at http://localhost:${port}`);
