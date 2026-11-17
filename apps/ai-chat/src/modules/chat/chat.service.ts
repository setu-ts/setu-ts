import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices, IServiceRegistry } from '@setu-ts/common';
import { createQuota, MemoryQuotaStore } from '@setu-ts/auth-plugin';
import type { IQuota } from '@setu-ts/auth-plugin';

/**
 * Returns the spend quota for one application, created on its first use.
 *
 * Call once during route or run-definition setup, so two applications in one process never share a
 * budget. The memory store is process-local: a deployment with several replicas needs
 * `RedisQuotaStore` for one shared budget.
 *
 * @returns A resolver that builds the quota from the caller's runtime once, then reuses it
 */
export function chatQuota(): (scope: { readonly services: IServiceRegistry }) => IQuota {
  let quota: IQuota | undefined;
  return (scope) => {
    if (quota === undefined) {
      const runtime = scope.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      quota = createQuota({
        name: 'ai-spend',
        limit: 1_000_000,
        window: 'utc-day',
        store: new MemoryQuotaStore(runtime),
        runtime,
      });
    }
    return quota;
  };
}
