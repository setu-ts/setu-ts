import type { IRouterApi } from '@setu-ts/common';
import { registerAuditRoutes } from './audit/audit.routes.ts';
import { registerPlatformRoutes } from './diagnostics/platform.routes.ts';
import { registerValuesRoutes } from './values/values.routes.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerValuesRoutes(router);
  registerAuditRoutes(router);
  registerPlatformRoutes(router);
}
