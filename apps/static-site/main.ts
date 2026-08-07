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

await app.start({ port: 8000 });
console.log('Server running on http://localhost:8000');
