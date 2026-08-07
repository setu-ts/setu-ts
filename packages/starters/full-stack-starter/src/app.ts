/**
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
// Import microservice-starter via bare specifier to enable cross-tier composition
import { buildMicroservicePlugins } from '@setu-ts/microservice-starter';
import type { FullStackStarterOptions } from './options.ts';
import { CachePlugin } from '@setu-ts/cache-plugin';
import { EventsPlugin } from '@setu-ts/events-plugin';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { AuditPlugin } from '@setu-ts/audit-plugin';
import { SecretsPlugin } from '@setu-ts/secrets-plugin';
import { StoragePlugin } from '@setu-ts/storage-plugin';
import { MailPlugin } from '@setu-ts/mail-plugin';
import { FeatureFlagsPlugin } from '@setu-ts/feature-flags-plugin';
import { NotificationPlugin } from '@setu-ts/notification-plugin';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

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
    ...(options.multiTenancy ? [MultiTenancyPlugin(options.multiTenancy)] : []),
    ...(options.reactRouter ? [ReactRouterPlugin(options.reactRouter)] : []),
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
 * import { createFullStackApp } from '@setu-ts/full-stack-starter';
 *
 * const app = createFullStackApp();
 * app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));
 * await app.start({ port: 3000 });
 * ```
 */
export function createFullStackApp(options?: FullStackStarterOptions): IKernelApplication {
  const plugins = buildFullStackPlugins(options);
  const app = createApplication({ plugins });

  // Add error handler as outermost middleware (priority 0) — required by
  // exceptions middleware contract to catch errors from all downstream middleware.
  app.middleware.add(errorHandler({ format: 'rfc7807' }), { priority: 0, name: 'error-handler' });

  return app;
}
