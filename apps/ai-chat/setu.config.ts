import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { some } from '@setu-ts/common';
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
import { registerModules } from './src/modules/index.ts';
import type { PricedModel } from './src/modules/chat/chat.budget.ts';
import { billingSubscription } from './src/modules/chat/chat.usage.ts';

/** Builds the Node example without listening. The fixture tenant represents authenticated server identity. @returns An application */
export function createApp(
  models: readonly PricedModel[],
  telemetry: TelemetryPluginOptions = {},
): IKernelApplication {
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
    ],
  });
  registerModules(app.router, models);
  app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 0 });
  return app;
}
