// deno-lint-ignore-file no-console -- interactive example entry point.
import { addAndRead, createCqrsApp } from './src/app.ts';

const app = createCqrsApp();
await app.start();
console.log(await addAndRead(app, 'CQRS keeps commands and queries separate.'));
await app.stop();
