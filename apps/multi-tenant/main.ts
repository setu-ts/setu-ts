/* eslint-disable no-console -- interactive example entry point. */
import { createMultiTenantApp } from './src/app.ts';

const port = Number(process.argv[2] ?? 3000);
const app = createMultiTenantApp();
await app.start({ port });
console.log(`Multi-tenant example listening at http://localhost:${port}`);
