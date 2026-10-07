// deno-lint-ignore-file no-console
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '@setu-ts/static-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    StaticPlugin({
      root: './public',
      urlPrefix: '/',
    }),
  ],
});

app.router.get('/health', (ctx) => {
  return ctx.response.json({ status: 'ok' });
});

const port = Number(Deno.args[0] ?? 8000);
await app.start({ port });
console.log(`Server running on http://localhost:${port}`);
