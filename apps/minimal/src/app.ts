import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

/** Builds the smallest useful Setu-TS application. */
export function createMinimalApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/', (ctx) => ctx.response.json({ hello: 'world' }));
  return app;
}
