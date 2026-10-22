import type { IRouterApi } from '@setu-ts/common';
import { registerTodosRoutes } from './todos.routes.ts';

/** Registers the todos feature. */
export function registerTodosModule(router: IRouterApi): void {
  registerTodosRoutes(router);
}
