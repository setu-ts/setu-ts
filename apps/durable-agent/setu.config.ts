import {
  createApplication,
  type IKernelApplication,
  type KernelDiagnosticsOptions,
} from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { StaticPlugin } from '@setu-ts/static-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { AgentRunsPlugin } from '@setu-ts/agent-runs-plugin';
import {
  createDatabaseAgentRunStore,
  createDatabaseIdempotencyStore,
} from '@setu-ts/database-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_MIDDLEWARE } from './src/middleware/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';
import { HEALTH_INDICATORS } from './src/health/index.ts';
import { CUSTOM_METRICS } from './src/metrics/index.ts';
import { supportDatabase } from './src/modules/support/support.database.ts';
import { supportAgent } from './src/modules/support/support.agent.ts';

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
      OpenApiPlugin({ exclude: ['/ui/*'] }),
      // The support page in public/: index.html at /ui, its script at /ui/run.js.
      StaticPlugin({ root: './public', urlPrefix: '/ui' }),
      // PostgreSQL when DATABASE_URL is set (run `npm run db:setup` first), else memory.
      ...supportDatabase(process.env),
      // Tool calls run inside tier C idempotency: a tool's database writes
      // commit with its recorded result, so a resumed run replays the result
      // instead of executing the tool again.
      IdempotencyPlugin({
        transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
      }),
      AgentRunsPlugin({ store: createDatabaseAgentRunStore(), definitions: [supportAgent()] }),
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

  app.router.get('/', (ctx) => ctx.response.redirect('/ui/'));

  return app;
}
