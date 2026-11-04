import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MODULES, registerModules } from './src/modules/index.ts';

/** Builds the decorated, DI-backed application, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ modules: [...MODULES] })],
  });
  registerModules(app.router, app.services);
  return app;
}
