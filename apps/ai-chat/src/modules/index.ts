import type { IRouterApi } from '@setu-ts/common';
import type { PricedModel } from './chat/chat.budget.ts';
import { registerChatModule } from './chat/index.ts';

/** Registers every feature module. */
export function registerModules(router: IRouterApi, models: readonly PricedModel[]): void {
  registerChatModule(router, models);
}
