import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';

/** Builds the host application for the custom plugin, without starting it. */
export function createApp(): IKernelApplication {
  return createApplication({ plugins: [RuntimePlugin(), ...GENERATED_PLUGINS] });
}
