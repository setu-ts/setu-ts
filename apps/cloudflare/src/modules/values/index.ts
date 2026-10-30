import type { IRouterApi } from '@setu-ts/common';
import { registerValuesRoutes } from './values.controller.ts';

/** Registers the values feature. */
export function registerValuesModule(router: IRouterApi): void {
  registerValuesRoutes(router);
}
