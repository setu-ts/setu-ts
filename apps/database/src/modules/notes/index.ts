import type { IRouterApi } from '@setu-ts/common';
import { registerNotesRoutes } from './notes.controller.ts';

/** Registers the notes feature. */
export function registerNotesModule(router: IRouterApi): void {
  registerNotesRoutes(router);
}
