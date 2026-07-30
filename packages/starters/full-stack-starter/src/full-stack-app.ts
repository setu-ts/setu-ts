/**
 * @module
 */
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import type { IPlugin } from '@hono-enterprise/common';
import { errorHandler } from '@hono-enterprise/exceptions';
// Import microservice-starter via relative path to enable cross-tier composition
import { buildMicroservicePlugins } from '../../microservice-starter/src/microservice-app.ts';
import type { FullStackStarterOptions } from './options.ts';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import { EventsPlugin } from '@hono-enterprise/events-plugin';
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
import { SchedulerPlugin } from '@hono-enterprise/scheduler-plugin';
import { AuditPlugin } from '@hono-enterprise/audit-plugin';
import { SecretsPlugin } from '@hono-enterprise/secrets-plugin';
import { StoragePlugin } from '@hono-enterprise/storage-plugin';
import { MailPlugin } from '@hono-enterprise/mail-plugin';
import { FeatureFlagsPlugin } from '@hono-enterprise/feature-flags-plugin';
import { NotificationPlugin } from '@hono-enterprise/notification-plugin';

/**
 * Builds the canonical full-stack plugin set. Composes from {@linkcode buildMicroservicePlugins}
 * and appends the full-stack plugins (cache, events, cqrs, scheduler, audit, secrets, storage, mail).
 * The list is exported for advanced custom composition.
 *
 * @param options - Optional per-plugin configuration arms.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function buildFullStackPlugins(options: FullStackStarterOptions = {}): IPlugin[] {
  // Start with the microservice base set
  const plugins: IPlugin[] = [
    ...buildMicroservicePlugins(options),
    // Full-stack always-on additions (all have sensible defaults)
    CachePlugin(options.cache),
    EventsPlugin(options.events),
    CqrsPlugin(options.cqrs),
    SchedulerPlugin(options.scheduler),
    AuditPlugin(options.audit),
    SecretsPlugin(options.secrets),
    StoragePlugin(options.storage),
    MailPlugin(options.mail),
    // Gated arms — only registered when explicitly provided
    ...(options.featureFlags ? [FeatureFlagsPlugin(options.featureFlags)] : []),
    ...(options.notifications ? [NotificationPlugin(options.notifications)] : []),
  ];

  return plugins;
}

/**
 * Creates a fully wired full-stack application. The factory registers the curated
 * full-stack plugin set (microservice + cache, events, cqrs, scheduler, audit,
 * secrets, storage, mail), adds the error-handler middleware at priority 0 (outermost
 * per exceptions contract), and returns the un-started application.
 *
 * The caller adds routes and then calls `await app.start({ port })`. Gated arms
 * (featureFlags, notifications, multiTenancy, reactRouter) are only registered when
 * explicitly provided in options.
 *
 * @param options - Optional per-plugin configuration.
 * @returns An {@linkcode IKernelApplication} ready for route registration.
 * @example
 * ```typescript
 * import { createFullStackApp } from '@hono-enterprise/full-stack-starter';
 *
 * const app = createFullStackApp();
 * app.get('/hello', () => 'Hello world');
 * await app.start({ port: 3000 });
 * ```
 */
export function createFullStackApp(options?: FullStackStarterOptions): IKernelApplication {
  const plugins = buildFullStackPlugins(options ?? {});
  const app = createApplication({ plugins });

  // Add error handler as outermost middleware (priority 0) — required by
  // exceptions middleware contract to catch errors from all downstream middleware.
  app.middleware.add(errorHandler({ format: 'rfc7807' }), { priority: 0, name: 'error-handler' });

  return app;
}
