import {
  createApplication,
  type IKernelApplication,
  type KernelDiagnosticsOptions,
} from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { createRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { McpToolsConfig } from './src/modules/items/items.schemas.ts';
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { McpPlugin } from '@setu-ts/mcp-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_MIDDLEWARE } from './src/middleware/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';
import { HEALTH_INDICATORS } from './src/health/index.ts';
import { CUSTOM_METRICS } from './src/metrics/index.ts';

/** Local demonstration only; deploy with a secret supplied through JWT_SECRET. */
export const DEMO_JWT_SECRET = 'mcp-tools-demo-only-secret-at-least-32-characters';

/**
 * Falls back to the public demo secret only when `JWT_SECRET` is unset. A set value,
 * including an empty one, must be at least 32 characters: an empty value would otherwise
 * fall through to RS256 with a misleading key error, and a short one is guessable offline.
 */
export function resolveJwtSecret(secret: string | undefined): string {
  const resolved = secret ?? DEMO_JWT_SECRET;
  if (resolved.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
  return resolved;
}

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
      ConfigPlugin({
        envFilePath: '.env',
        envFileOptional: true,
        validationSchema: McpToolsConfig,
      }),
      LoggerPlugin({
        requestLogging: true,
        excludePaths: ['/live', '/ready', '/health', '/metrics'],
        transport: 'pino',
      }),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      HttpSecurityPlugin(),
      HealthPlugin({ indicators: [...HEALTH_INDICATORS] }),
      MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] }),
      // Each route's requirement is derived from its scope guard, so Swagger UI
      // shows an Authorize button and the scopes every operation needs.
      OpenApiPlugin({
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        deriveSecurity: { scheme: 'bearerAuth' },
      }),
      AuthPlugin({
        jwt: { secret: resolveJwtSecret(createRuntimeServices().env.JWT_SECRET) },
        resourceServer: {
          resource: createRuntimeServices().env.MCP_RESOURCE ?? 'http://localhost:3000',
          scopesSupported: ['items:read', 'items:write'],
        },
      }),
      IdempotencyPlugin(),
      McpPlugin({
        serverInfo: { name: 'mcp-tools', version: '1.0.0' },
        allowedOrigins: [],
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
