// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Migration Fastify equivalent from docs/migration-fastify.md - must compile.
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();
app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello' });
});

app.router.get('/users/:id', async (ctx) => {
  const id = ctx.params.id;
  return ctx.response.json({ id });
});

app.router.post('/users', async (ctx) => {
  const body = await ctx.request.json();
  return ctx.response.json({ created: (body as { name: string }).name });
});

await app.start({ port: 3000 });
