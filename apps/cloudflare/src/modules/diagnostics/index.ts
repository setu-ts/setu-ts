import type { IRouterApi } from '@setu-ts/common';
import { registerDiagnosticsRoutes } from './diagnostics.routes.ts';

/** Registers the diagnostics feature. */
export function registerDiagnosticsModule(router: IRouterApi): void {
  registerDiagnosticsRoutes(router);
}
