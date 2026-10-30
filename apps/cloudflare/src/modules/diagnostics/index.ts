import type { IRouterApi } from '@setu-ts/common';
import { registerDiagnosticsRoutes } from './diagnostics.controller.ts';

/** Registers the diagnostics feature. */
export function registerDiagnosticsModule(router: IRouterApi): void {
  registerDiagnosticsRoutes(router);
}
