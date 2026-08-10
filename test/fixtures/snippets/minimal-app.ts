// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Minimal app from docs/getting-started.md - must compile against the workspace.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
app.register(RuntimePlugin());
app.router.get('/hello', async (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});
await app.start({ port: 3000 });
