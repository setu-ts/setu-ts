import type { IRouterApi } from '@setu-ts/common';
import { registerNewsRoutes } from './news.controller.ts';

/** Registers the news feature. */
export function registerNewsModule(router: IRouterApi): void {
  registerNewsRoutes(router);
}
