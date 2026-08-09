// deno-lint-ignore-file require-await -- documentation snippet fixtures mirror guide examples
// Runtime/Workers composition from docs/runtime-deployment.md - must compile.
import { createApplication } from '@setu-ts/kernel';
import { CloudflareWorkersHttpAdapter } from '@setu-ts/runtime';

const app = createApplication();

// Register runtime services and HTTP adapter directly for Workers
app.services.register('runtime', {
  platform: 'cloudflare-workers' as const,
  env: {},
  uuid: () => 'test-uuid',
  randomBytes: (n: number) => new Uint8Array(n),
  now: () => Date.now(),
  hrtime: () => performance.now(),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
});
app.services.register('http-adapter', new CloudflareWorkersHttpAdapter());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello from Workers!' });
});

// deno-lint-ignore-file no-unused-vars
export default {
  async fetch(request: Request, _env: unknown, _ctx: unknown) {
    return app.fetch(request);
  },
};
