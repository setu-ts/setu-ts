/**
 * @module
 */
import type { MicroserviceStarterOptions } from '@setu-ts/microservice-starter';
import type { CachePluginOptions } from '@setu-ts/cache-plugin';
import type { EventsPluginOptions } from '@setu-ts/events-plugin';
import type { CqrsPluginOptions } from '@setu-ts/cqrs-plugin';
import type { SchedulerPluginOptions } from '@setu-ts/scheduler-plugin';
import type { AuditPluginOptions } from '@setu-ts/audit-plugin';
import type { SecretsPluginOptions } from '@setu-ts/secrets-plugin';
import type { StoragePluginOptions } from '@setu-ts/storage-plugin';
import type { MailPluginOptions } from '@setu-ts/mail-plugin';
import type { FeatureFlagsPluginOptions } from '@setu-ts/feature-flags-plugin';
import type { NotificationPluginOptions } from '@setu-ts/notification-plugin';
import type { MultiTenancyPluginOptions } from '@setu-ts/multi-tenancy-plugin';
import type { ReactRouterPluginOptions } from '@setu-ts/react-router-plugin';

/**
 * Options for {@linkcode createFullStackApp}. Extends {@linkcode MicroserviceStarterOptions}
 * with full-stack arms (always-on + gated). Omitted plugins use their defaults.
 *
 * @see {@linkcode FullStackStarterOptions}
 */
export interface FullStackStarterOptions extends MicroserviceStarterOptions {
  /**
   * Always-on arm: {@linkcode CachePlugin}. Omitted → memory store default.
   */
  cache?: CachePluginOptions;
  /**
   * Always-on arm: {@linkcode EventsPlugin}. Omitted → in-memory bus default.
   */
  events?: EventsPluginOptions;
  /**
   * Always-on arm: {@linkcode CqrsPlugin}. Omitted → no built-in behaviors.
   */
  cqrs?: CqrsPluginOptions;
  /**
   * Always-on arm: {@linkcode SchedulerPlugin}. Omitted → defaults.
   */
  scheduler?: SchedulerPluginOptions;
  /**
   * Always-on arm: {@linkcode AuditPlugin}. Omitted → memory storage default.
   */
  audit?: AuditPluginOptions;
  /**
   * Always-on arm: {@linkcode SecretsPlugin}. Omitted → env provider default.
   */
  secrets?: SecretsPluginOptions;
  /**
   * Always-on arm: {@linkcode StoragePlugin}. Omitted → memory provider default.
   */
  storage?: StoragePluginOptions;
  /**
   * Always-on arm: {@linkcode MailPlugin}. Omitted → log provider default.
   */
  mail?: MailPluginOptions;
  /**
   * Optional arm: {@linkcode FeatureFlagsPlugin}. Gated — requires a provider to be useful.
   */
  featureFlags?: FeatureFlagsPluginOptions;
  /**
   * Optional arm: {@linkcode NotificationPlugin}. Gated — requires channels to be useful.
   */
  notifications?: NotificationPluginOptions;
  /**
   * Optional arm: {@linkcode MultiTenancyPlugin}. Gated — requires resolvers to be useful.
   */
  multiTenancy?: MultiTenancyPluginOptions;
  /**
   * Optional arm: {@linkcode ReactRouterPlugin}. Gated — requires `serverBuildPath` for SSR.
   */
  reactRouter?: ReactRouterPluginOptions;
}
