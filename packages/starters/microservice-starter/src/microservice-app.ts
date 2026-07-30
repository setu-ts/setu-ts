/**
 * @module
 */
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import type { IPlugin } from '@hono-enterprise/common';
import { errorHandler } from '@hono-enterprise/exceptions';
// Import rest-starter via relative path to enable cross-tier composition
import { buildRestPlugins } from '../../rest-starter/src/rest-app.ts';
import type { MicroserviceStarterOptions } from './options.ts';
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
import { QueuePlugin } from '@hono-enterprise/queue-plugin';
import { ResiliencePlugin } from '@hono-enterprise/resilience-plugin';
import { TelemetryPlugin } from '@hono-enterprise/telemetry-plugin';

/**
 * Builds the canonical microservice plugin set. Composes from {@linkcode buildRestPlugins}
 * and appends the four microservice-specific plugins (messaging, queue, resilience, telemetry).
 * The list is exported so full-stack can compose from it.
 *
 * @param options - Optional per-plugin configuration arms.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function buildMicroservicePlugins(options: MicroserviceStarterOptions = {}): IPlugin[] {
  // Start with the REST base set
  const plugins: IPlugin[] = [
    ...buildRestPlugins(options),
    // Microservice-specific additions (always-on, defaults provided)
    MessagingPlugin(options.messaging),
    QueuePlugin(options.queue),
    ResiliencePlugin(options.resilience),
    TelemetryPlugin(options.telemetry),
  ];

  return plugins;
}

/**
 * Creates a fully wired microservice application. The factory registers the curated
 * microservice plugin set (REST + messaging, queue, resilience, telemetry), adds the
 * error-handler middleware at priority 0 (outermost per exceptions contract), and returns
 * the un-started application.
 *
 * The caller adds routes and then calls `await app.start({ port })`.
 *
 * @param options - Optional per-plugin configuration.
 * @returns An {@linkcode IKernelApplication} ready for route registration.
 * @example
 * ```typescript
 * import { createMicroserviceApp } from '@hono-enterprise/microservice-starter';
 *
 * const app = createMicroserviceApp();
 * app.get('/hello', () => 'Hello world');
 * await app.start({ port: 3000 });
 * ```
 */
export function createMicroserviceApp(options?: MicroserviceStarterOptions): IKernelApplication {
  const plugins = buildMicroservicePlugins(options ?? {});
  const app = createApplication({ plugins });

  // Add error handler as outermost middleware (priority 0) — required by
  // exceptions middleware contract to catch errors from all downstream middleware.
  app.middleware.add(errorHandler({ format: 'rfc7807' }), { priority: 0, name: 'error-handler' });

  return app;
}
