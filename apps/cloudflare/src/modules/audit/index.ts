import type { IRouterApi } from '@setu-ts/common';
import { registerAuditRoutes } from './audit.routes.ts';

/** Registers the audit feature. */
export function registerAuditModule(router: IRouterApi): void {
  registerAuditRoutes(router);
}
