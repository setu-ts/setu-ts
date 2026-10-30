import type { IRouterApi } from '@setu-ts/common';
import { registerEventsRoutes } from './events.controller.ts';

/** Registers the events feature. */
export function registerEventsModule(router: IRouterApi): void {
  registerEventsRoutes(router);
}
