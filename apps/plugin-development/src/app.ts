import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GreetingPlugin } from './greeting-plugin.ts';

/** Creates the host application for the custom plugin. */
export function createPluginDevelopmentApp(): IKernelApplication {
  return createApplication({ plugins: [RuntimePlugin(), GreetingPlugin()] });
}
