/**
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IPlugin, RuntimePlatform } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { detectRuntime } from '@setu-ts/runtime';
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
import { StaticPlugin } from '@setu-ts/static-plugin';

/**
 * Builds the canonical full-stack plugin set. Composes from {@linkcode buildMicroservicePlugins}
 * and appends the full-stack plugins (cache, events, cqrs, scheduler, audit, secrets, storage, mail).
 * On Cloudflare Workers the scheduler is left out unless `options.scheduler` is given (see
 * {@linkcode composeFullStackPlugins}). The list is exported for advanced custom composition.
 *
 * @param options - Optional per-plugin configuration arms.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function buildFullStackPlugins(options: FullStackStarterOptions = {}): IPlugin[] {
  return composeFullStackPlugins(options, detectRuntime());
}

/**
 * Builds the full-stack plugin set for an already-detected platform. Internal:
 * the starter's `RuntimePlugin()` detects the platform the same way, so the two
 * agree; taking it as a parameter is what lets a test reach the Workers branch.
 *
 * On Cloudflare Workers the scheduler is left out unless `options.scheduler` is
 * given: `SchedulerPlugin` refuses that platform at `register()`, because its
 * timers do not survive isolate eviction. Workers schedules through Cron
 * Triggers (`cloudflare-plugin`'s `WorkersCron`). An explicit `scheduler` arm is
 * still registered there, so the plugin's own error names that remedy.
 *
 * @param options - Optional per-plugin configuration arms.
 * @param platform - The platform the application runs on.
 * @returns Array of {@linkcode IPlugin} instances in registration order.
 */
export function composeFullStackPlugins(
  options: FullStackStarterOptions,
  platform: RuntimePlatform,
): IPlugin[] {
  const scheduler = platform === 'cloudflare-workers' && options.scheduler === undefined
    ? []
    : [SchedulerPlugin(options.scheduler)];
  // Start with the microservice base set
  const plugins: IPlugin[] = [
    ...buildMicroservicePlugins(options),
    // Full-stack always-on additions (all have sensible defaults)
    CachePlugin(options.cache),
    EventsPlugin(options.events),
    CqrsPlugin(options.cqrs),
    ...scheduler,
    AuditPlugin(options.audit),
    SecretsPlugin(options.secrets),
    StoragePlugin(options.storage),
    MailPlugin(options.mail),
    // Gated arms — only registered when explicitly provided
    ...(options.featureFlags ? [FeatureFlagsPlugin(options.featureFlags)] : []),
    ...(options.notifications ? [NotificationPlugin(options.notifications)] : []),
    ...(options.multiTenancy ? [MultiTenancyPlugin(options.multiTenancy)] : []),
    ...(options.reactRouter ? [ReactRouterPlugin(options.reactRouter)] : []),
    ...(options.static ? [StaticPlugin(options.static)] : []),
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
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });

  return app;
}
