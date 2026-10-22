import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IRuntimeServices } from '@setu-ts/common';
import { detectRuntime } from '@setu-ts/runtime';

/**
 * Reports the runtime the framework detects on this platform.
 *
 * `detected` is the check that matters: the registered runtime is fixed by
 * this example's own runtime plugin, so only detection can be wrong.
 */
export function registerDiagnosticsRoutes(router: IRouterApi): void {
  router.get('/diag/platform', (ctx) =>
    ctx.response.json({
      detected: detectRuntime(),
      registered: ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).platform(),
    }),
  );
}
