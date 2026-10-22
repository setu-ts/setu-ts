import type { IRouterApi } from '@setu-ts/common';
import { registerEventsModule } from './events/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerEventsModule(router);
}
