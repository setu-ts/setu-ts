/**
 * Adapts a public {@linkcode IMessageBroker} to the internal
 * {@linkcode MessageBrokerAdapter} seam.
 *
 * The public contract has no `isReady()` member, but the health indicator
 * reads it. When the custom instance already exposes a callable `isReady`,
 * it is returned unchanged. Otherwise a thin wrapper tracks
 * connect-resolved / disconnect-run and reports that as the health state.
 *
 * @module
 */

import type { IMessageBroker } from '@setu-ts/common';
import type { MessageBrokerAdapter } from './message-broker.ts';

/**
 * Converts a public {@linkcode IMessageBroker} into a
 * {@linkcode MessageBrokerAdapter} that satisfies the health indicator.
 *
 * @param instance - The custom broker instance
 * @returns A MessageBrokerAdapter wrapping the instance
 */
export function asBrokerAdapter(instance: IMessageBroker): MessageBrokerAdapter {
  if (typeof (instance as unknown as Record<string, unknown>).isReady === 'function') {
    // Instance already carries isReady — return unchanged and honour its value.
    return instance as MessageBrokerAdapter;
  }

  let connected = false;

  return {
    connect: async () => {
      await instance.connect();
      connected = true;
    },
    disconnect: async () => {
      await instance.disconnect();
      connected = false;
    },
    publish: (topic, message) => instance.publish(topic, message),
    subscribe: (topic, handler, options) => instance.subscribe(topic, handler, options),
    request: (topic, message, options) => instance.request(topic, message, options),
    respond: (topic, handler, options) => instance.respond(topic, handler, options),
    isReady: () => connected,
  };
}
