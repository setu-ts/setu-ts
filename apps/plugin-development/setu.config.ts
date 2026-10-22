import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GreetingPlugin } from './src/plugins/greeting.plugin.ts';

/** Builds the host application for the custom plugin, without starting it. */
export function createApp(): IKernelApplication {
  return createApplication({ plugins: [RuntimePlugin(), GreetingPlugin()] });
}
