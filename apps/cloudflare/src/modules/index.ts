import type { IRouterApi } from '@setu-ts/common';
import { registerAuditModule } from './audit/index.ts';
import { registerDiagnosticsModule } from './diagnostics/index.ts';
import { registerValuesModule } from './values/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi): void {
  registerValuesModule(router);
  registerAuditModule(router);
  registerDiagnosticsModule(router);
}
