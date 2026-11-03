import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, some } from '@setu-ts/common';
import { createQuota, MemoryQuotaStore } from '@setu-ts/auth-plugin';
import type { IQuota } from '@setu-ts/auth-plugin';
import {
  DatabasePlugin,
  createDatabaseOutboxStore,
  createDatabaseInboxStore,
} from '@setu-ts/database-plugin';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
import type { TelemetryPluginOptions } from '@setu-ts/telemetry-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { registerChatRoutes } from './src/chat.routes.ts';
import type { PricedModel } from './src/chat.routes.ts';
import { billingSubscription } from './src/usage.ts';

/** Builds the Node example without listening. The fixture tenant represents authenticated server identity. @returns An application */
export function createApp(
  models: readonly PricedModel[],
  telemetry: TelemetryPluginOptions = {},
): IKernelApplication {
  let quota: IQuota;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SchedulerPlugin(),
      DatabasePlugin({ type: 'memory' }),
      // A production resolver binds this identity to the authenticated principal.
      // The example deliberately accepts no tenant header/body field.
      MultiTenancyPlugin({
        resolver: { resolve: () => Promise.resolve(some({ id: 'demo-tenant', name: 'Demo' })) },
        required: true,
      }),
      TelemetryPlugin(telemetry),
      MessagingPlugin({
        outbox: { store: createDatabaseOutboxStore(), relay: { intervalMs: 20 } },
        inbox: { store: createDatabaseInboxStore() },
        subscriptions: [billingSubscription()],
      }),
      {
        name: 'ai-budget',
        version: '1.0.0',
        register(ctx) {
          quota = createQuota({
            name: 'ai-spend',
            limit: 1_000_000,
            window: 'utc-day',
            store: new MemoryQuotaStore(ctx.runtime),
            runtime: ctx.runtime,
          });
          registerChatRoutes(ctx.router, models, () => quota);
        },
        consumes: [CAPABILITIES.DATABASE, CAPABILITIES.OUTBOX],
      },
    ],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 0 });
  return app;
}
