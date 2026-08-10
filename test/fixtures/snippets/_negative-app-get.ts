// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Negative control: this fixture uses app.get() (the banned Hono-style API that
// Setu-TS does NOT expose — routes go through app.router). The snippet gate
// MUST reject this file. It is committed so the gate can prove discrimination.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
app.register(RuntimePlugin());

// app.get does not exist on IApplication — app.router.get is the real API.
app.get('/hello', async (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});

await app.start({ port: 3000 });
