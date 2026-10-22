import type { IRouterApi } from '@setu-ts/common';
import { registerNewsRoutes } from './news/news.routes.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerNewsRoutes(router);
}
