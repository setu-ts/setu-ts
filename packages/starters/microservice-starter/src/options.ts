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
   * Optional arm: {@linkcode MessagingPlugin}. Provided only when the caller
   * supplies messaging configuration; omitted → in-memory broker default.
   */
  messaging?: MessagingPluginOptions;
  /**
   * Optional arm: {@linkcode QueuePlugin}. Provided only when the caller supplies
   * queue configuration; omitted → memory adapter default.
   */
  queue?: QueuePluginOptions;
  /**
   * Optional arm: {@linkcode ResiliencePlugin}. Omitted → defaults.
   */
  resilience?: ResiliencePluginOptions;
  /**
   * Optional arm: {@linkcode TelemetryPlugin}. Omitted → no-op (no exporter).
   */
  telemetry?: TelemetryPluginOptions;
}
