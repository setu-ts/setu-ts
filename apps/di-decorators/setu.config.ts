import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MODULES } from './src/modules/index.ts';

/** Builds the decorated, DI-backed application, without starting it. */
export function createApp(): IKernelApplication {
  return createApplication({
    plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ modules: [...MODULES] })],
  });
}
