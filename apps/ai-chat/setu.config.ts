import {
  createApplication,
  type IKernelApplication,
  type KernelDiagnosticsOptions,
} from '@setu-ts/kernel';
import { some } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import {
  DatabasePlugin,
  createDatabaseInboxStore,
  createDatabaseOutboxStore,
} from '@setu-ts/database-plugin';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
import { billingSubscription } from './src/modules/chat/chat.usage.ts';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_MIDDLEWARE } from './src/middleware/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';
import { HEALTH_INDICATORS } from './src/health/index.ts';
import { CUSTOM_METRICS } from './src/metrics/index.ts';

/**
 * Builds the application.
 *
 * `setu` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — `main.ts` owns that.
 *
 * @param _env - The discovery environment `setu commands` passes positionally on
 * every target; accepted and unused, because a socket project reads configuration
 * from the process environment.
 * @param devtool - The development-only composition — the diagnostics plugin and
 * the kernel diagnostics option — supplied by `main.dev.ts` alone. The SECOND
 * parameter deliberately: `setu commands` passes its inert discovery env as the
 * FIRST argument on every target, which the unused `_env` above absorbs.
 * @returns The configured, unstarted application
 */
export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ConfigPlugin({ envFilePath: '.env', envFileOptional: true }),
      LoggerPlugin({
        requestLogging: true,
        excludePaths: ['/live', '/ready', '/health', '/metrics'],
        transport: 'pino',
      }),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      HttpSecurityPlugin(),
      HealthPlugin({ indicators: [...HEALTH_INDICATORS] }),
      MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] }),
      OpenApiPlugin(),
      SchedulerPlugin(),
      DatabasePlugin({ type: 'memory' }),
      // A production resolver binds this identity to the authenticated principal.
      // The example deliberately accepts no tenant header or body field.
      MultiTenancyPlugin({
        resolver: { resolve: () => Promise.resolve(some({ id: 'demo-tenant', name: 'Demo' })) },
        required: true,
      }),
      // registerGlobal lets AI SDK spans reach this provider; only with an exporter.
      TelemetryPlugin(
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
          ? {
              serviceName: 'ai-chat',
              exporter: 'otlp',
              endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
              registerGlobal: true,
            }
          : {},
      ),
      MessagingPlugin({
        outbox: { store: createDatabaseOutboxStore(), relay: { intervalMs: 20 } },
        inbox: { store: createDatabaseInboxStore() },
        subscriptions: [billingSubscription()],
      }),
      ...GENERATED_PLUGINS,
      ...(devtool?.plugins ?? []),
    ],
    // Kernel diagnostics reach the CONSTRUCTOR only — the collector is built
    // there — so the devtool option threads through this object rather than
    // being registered onto a finished application.
    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
  });

  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });

  registerModules(app.router, app.services);
  for (const generated of GENERATED_MIDDLEWARE) {
    app.middleware.add(generated.middleware, {
      priority: generated.priority,
      name: generated.name,
    });
  }

  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

  return app;
}
