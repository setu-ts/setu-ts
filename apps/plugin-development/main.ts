// deno-lint-ignore-file no-console -- interactive example entry point.
import { createPluginDevelopmentApp } from './src/app.ts';

const port = Number(Deno.args[0] ?? 3000);
const app = createPluginDevelopmentApp();
await app.start({ port });
console.log(`Custom plugin example listening at http://localhost:${port}/greet/Ada`);
