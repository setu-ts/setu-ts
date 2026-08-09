// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Migration NestJS equivalent from docs/migration-nestjs.md - must compile.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
app.register(RuntimePlugin());

app.router.get('/users', async (ctx) => {
  return ctx.response.json([{ id: 1, name: 'John' }]);
});

app.router.get('/users/:id', async (ctx) => {
  return ctx.response.json({ id: ctx.params.id });
});

app.router.post('/users', async (ctx) => {
  const body = await ctx.request.json();
  return ctx.response.json({ created: (body as { name: string }).name });
});

await app.start({ port: 3000 });
