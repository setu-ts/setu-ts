/**
 * @module
 */
import type { MicroserviceStarterOptions } from '../../microservice-starter/src/options.ts';
import type { CachePluginOptions } from '@hono-enterprise/cache-plugin';
import type { EventsPluginOptions } from '@hono-enterprise/events-plugin';
import type { CqrsPluginOptions } from '@hono-enterprise/cqrs-plugin';
import type { SchedulerPluginOptions } from '@hono-enterprise/scheduler-plugin';
import type { AuditPluginOptions } from '@hono-enterprise/audit-plugin';
import type { SecretsPluginOptions } from '@hono-enterprise/secrets-plugin';
import type { StoragePluginOptions } from '@hono-enterprise/storage-plugin';
import type { MailPluginOptions } from '@hono-enterprise/mail-plugin';
import type { FeatureFlagsPluginOptions } from '@hono-enterprise/feature-flags-plugin';
import type { NotificationPluginOptions } from '@hono-enterprise/notification-plugin';
import type { MultiTenancyPluginOptions } from '@hono-enterprise/multi-tenancy-plugin';
import type { ReactRouterPluginOptions } from '@hono-enterprise/react-router-plugin';

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
