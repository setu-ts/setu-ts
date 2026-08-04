import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

/** Builds the application embedded in the standalone executable. */
export function createCompiledApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));
  return app;
}
