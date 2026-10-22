import type { IRouterApi } from '@setu-ts/common';
import { registerNotesModule } from './notes/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerNotesModule(router);
}
