// deno-lint-ignore-file no-console -- documentation snippet fixtures mirror guide examples
// Middleware registration from docs/plugin-architecture.md - must compile.
import type { MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const myMiddleware: MiddlewareFunction = async (_ctx, next) => {
  console.log('Before');
  await next();
  console.log('After');
};

const app = createApplication();
app.register(RuntimePlugin());
app.middleware.add(myMiddleware);
app.middleware.add(myMiddleware, { priority: 25 });

await app.start({ port: 3000 });
