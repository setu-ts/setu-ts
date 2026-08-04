// deno-lint-ignore-file no-console -- interactive example entry point.
import { callServiceB, createServiceA } from './src/app.ts';

const app = createServiceA();
await app.start();
console.log(await callServiceB(app));
await app.stop();
