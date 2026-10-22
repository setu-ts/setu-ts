import type { IRouterApi } from '@setu-ts/common';
import { registerTodosModule } from './todos/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerTodosModule(router);
}
