import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

/** Builds the application embedded in the standalone executable, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));
  return app;
}
