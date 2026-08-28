/**
 * Adapts a public {@linkcode IMessageBroker} to the internal
 * {@linkcode MessageBrokerAdapter} seam.
 *
 * The public contract has no `isReady()`/`reachability()` members, but the
 * health indicator reads them. When the custom instance already exposes the
 * full internal seam (a callable `isReady` **and** `reachability`), it is
 * returned unchanged. Otherwise a thin wrapper tracks connect-resolved /
 * disconnect-run for `isReady`, and derives `reachability` from the public
 * `isHealthy?()` port member when the instance provides one — `true`/`false`
 * from it, `undefined` (reported as `reachable: 'unknown'`) when it does not
 * (M70c: an application's custom broker that cannot probe is not known down).
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
  const candidate = instance as unknown as {
    isReady?: unknown;
    reachability?: unknown;
    isHealthy?: unknown;
    publishWithHeaders?: unknown;
    subscribeWithHeaders?: unknown;
    requestWithHeaders?: unknown;
  };
  if (
    typeof candidate.isReady === 'function' &&
    typeof candidate.reachability === 'function' &&
    typeof candidate.isHealthy === 'function' &&
    typeof candidate.publishWithHeaders === 'function' &&
    typeof candidate.subscribeWithHeaders === 'function' &&
    typeof candidate.requestWithHeaders === 'function'
  ) {
    // Instance already carries the full internal seam — return unchanged.
    return instance as MessageBrokerAdapter;
  }

  let connected = false;

  /**
   * Tri-state reachability (M70c): delegates to the wrapped instance's
   * public `isHealthy?()` when it provides one, else `undefined`.
   */
  const reachability = async (): Promise<boolean | undefined> => {
    if (typeof candidate.isHealthy !== 'function') {
      return undefined;
    }
    return await (candidate.isHealthy as () => Promise<boolean>)();
  };

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
    publishWithHeaders: (topic, message, _headers) => instance.publish(topic, message),
    subscribe: (topic, handler, options) => instance.subscribe(topic, handler, options),
    subscribeWithHeaders: (topic, handler, options) => instance.subscribe(topic, handler, options),
    requestWithHeaders: (topic, message, _headers, options) =>
      instance.request(topic, message, options),
    request: (topic, message, options) => instance.request(topic, message, options),
    respond: (topic, handler, options) => instance.respond(topic, handler, options),
    isReady: (): boolean => {
      // Prefer the instance's own lifecycle signal when it has one; only fall
      // back to the tracked connect/disconnected flag for instances that lack
      // `isReady` (the original public contract).
      if (typeof candidate.isReady === 'function') {
        return (candidate.isReady as () => boolean)();
      }
      return connected;
    },
    reachability,
    isHealthy: async (): Promise<boolean> => {
      const reachable = await reachability();
      return reachable !== false;
    },
  };
}
