import type { IRouterApi } from '@setu-ts/common';
import { registerNewsModule } from './news/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerNewsModule(router);
}
