// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Examples-guide composition from docs/examples.md - must compile against the workspace.
// This is the canonical minimal composition shown in the examples guide's
// "Getting Started" section.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});

await app.start({ port: 3000 });
