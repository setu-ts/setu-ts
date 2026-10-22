import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { notesHandlers } from './src/modules/notes/index.ts';

/** Builds the CQRS composition, without starting it. */
export function createApp(): IKernelApplication {
  return createApplication({ plugins: [RuntimePlugin(), CqrsPlugin(notesHandlers())] });
}
