import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GreetingPlugin } from './greeting-plugin.ts';

/** Creates the host application for the custom plugin. */
export function createPluginDevelopmentApp(): IKernelApplication {
  return createApplication({ plugins: [RuntimePlugin(), GreetingPlugin()] });
}
