import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, IRouterApi, IRuntimeServices } from '@setu-ts/common';
import { createQuota, MemoryQuotaStore } from '@setu-ts/auth-plugin';
import type { IQuota } from '@setu-ts/auth-plugin';
import { registerChatRoutes } from './chat.controller.ts';
import type { PricedModel } from './chat.budget.ts';

/** Registers chat with a quota lazily owned by this application's module. */
export function registerChatModule(router: IRouterApi, models: readonly PricedModel[]): void {
  let quota: IQuota | undefined;
  registerChatRoutes(router, models, (ctx: IRequestContext) => {
    if (quota === undefined) {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      quota = createQuota({
        name: 'ai-spend',
        limit: 1_000_000,
        window: 'utc-day',
        store: new MemoryQuotaStore(runtime),
        runtime,
      });
    }
    return quota;
  });
}
