/**
 * @module
 */
import type { RestStarterOptions } from '@setu-ts/rest-starter';
import type { MessagingPluginOptions } from '@setu-ts/messaging-plugin';
import type { QueuePluginOptions } from '@setu-ts/queue-plugin';
import type { ResiliencePluginOptions } from '@setu-ts/resilience-plugin';
import type { TelemetryPluginOptions } from '@setu-ts/telemetry-plugin';

/**
 * Options for {@linkcode createMicroserviceApp}. Extends {@linkcode RestStarterOptions}
 * with microservice-specific arms. Omitted plugins use their defaults.
 *
 * @see {@linkcode MicroserviceStarterOptions}
 */
export interface MicroserviceStarterOptions extends RestStarterOptions {
  /**
   * Configuration for {@linkcode MessagingPlugin}, which this tier ALWAYS
   * registers — unlike the gated arms inherited from
   * {@linkcode RestStarterOptions}, omitting this does not skip the plugin.
   * Omitted → the memory broker default.
   */
  messaging?: MessagingPluginOptions;
  /**
   * Configuration for {@linkcode QueuePlugin}, always registered.
   * Omitted → the memory adapter default.
   */
  queue?: QueuePluginOptions;
  /**
   * Configuration for {@linkcode ResiliencePlugin}, always registered.
   * Omitted → plugin defaults.
   */
  resilience?: ResiliencePluginOptions;
  /**
   * Configuration for {@linkcode TelemetryPlugin}, always registered.
   * Omitted → a `NoopTelemetryService`, since no exporter is configured.
   */
  telemetry?: TelemetryPluginOptions;
}
