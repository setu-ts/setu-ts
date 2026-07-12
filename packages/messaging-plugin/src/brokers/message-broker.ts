import type { IMessageBroker } from '@hono-enterprise/common';

/**
 * Internal broker adapter interface extending IMessageBroker with readiness check.
 *
 * This internal seam adds an `isReady()` method for health checks and testing,
 * which is not part of the public IMessageBroker contract.
 *
 * @since 0.1.0
 */
export interface MessageBrokerAdapter extends IMessageBroker {
  /**
   * Checks if the broker is connected and ready.
   *
   * @returns `true` if the broker is connected, `false` otherwise
   * @since 0.1.0
   */
  isReady(): boolean;
}
