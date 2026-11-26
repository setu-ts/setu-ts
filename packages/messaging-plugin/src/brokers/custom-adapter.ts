/**
 * Adapts a public {@linkcode IMessageBroker} to the internal
 * {@linkcode MessageBrokerAdapter} seam.
 *
 * The public contract has no `isReady()`/`reachability()` members, but the
 * health indicator reads them. A wrapper always validates caller options and
 * forwards optional framework header members. It tracks connect-resolved /
 * disconnect-run for `isReady`, and derives `reachability` from the public
 * `isHealthy?()` port member when the instance provides one — `true`/`false`
 * from it, `undefined` (reported as `reachable: 'unknown'`) when it does not
 * (M70c: an application's custom broker that cannot probe is not known down).
 *
 * @module
 */

import type { ICustomMessageBroker } from '../interfaces/index.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import {
  registerRoutedPublish,
  routedPublishAvailable,
  validatePublishOptions,
} from './publish-options.ts';

/**
 * Converts a public {@linkcode IMessageBroker} into a
 * {@linkcode MessageBrokerAdapter} that satisfies the health indicator.
 *
 * @param instance - The custom broker instance
 * @param warn - Optional once-only missing-header-channel warning
 * @returns A MessageBrokerAdapter wrapping the instance
 * @since 0.14.0
 */
export function asBrokerAdapter(
  instance: ICustomMessageBroker,
  warn?: (message: string) => void,
): MessageBrokerAdapter {
  const candidate = instance as unknown as {
    isReady?: unknown;
    isHealthy?: unknown;
  };
  let connected = false;
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    try {
      warn?.(
        'Custom broker has no framework header channel for this operation; traces will not cross this broker',
      );
    } catch {
      /* Reporting cannot prevent transport operations. */
    }
  };

  /**
   * Tri-state reachability (M70c): delegates to the wrapped instance's
   * public `isHealthy?()` when it provides one, else `undefined`.
   *
   * The member is captured in a local and invoked through the OWNER
   * (`.call(instance)`): a stateful `isHealthy` (`return this.#linked;`)
   * must never be evaluated off its instance — the detached-reference
   * class M90b fixed in the realtime backplane.
   */
  const reachability = async (): Promise<boolean | undefined> => {
    const probe = candidate.isHealthy;
    if (typeof probe !== 'function') {
      return undefined;
    }
    return await (probe as () => Promise<boolean>).call(instance);
  };

  const adapter: MessageBrokerAdapter = {
    connect: async () => {
      await instance.connect();
      connected = true;
    },
    disconnect: async () => {
      await instance.disconnect();
      connected = false;
    },
    publish: async (topic, message, options) => {
      await adapter.publishWithHeaders(topic, message, {}, options);
    },
    publishWithHeaders: async (topic, message, headers, options) => {
      const validated = await validatePublishOptions(options);
      if (instance.publishWithHeaders !== undefined) {
        await instance.publishWithHeaders(topic, message, headers, validated);
      } else {
        warnOnce();
        await instance.publish(topic, message, validated);
      }
    },
    subscribe: (topic, handler, options) => instance.subscribe(topic, handler, options),
    subscribeWithHeaders: (topic, handler, options) => instance.subscribe(topic, handler, options),
    requestWithHeaders: (topic, message, headers, options) => {
      if (instance.requestWithHeaders !== undefined)
        return instance.requestWithHeaders(topic, message, headers, options);
      warnOnce();
      return instance.request(topic, message, options);
    },
    request: (topic, message, options) => adapter.requestWithHeaders(topic, message, {}, options),
    respond: (topic, handler, options) => instance.respond(topic, handler, options),
    isReady: (): boolean => {
      // Prefer the instance's own lifecycle signal when it has one; only fall
      // back to the tracked connect/disconnected flag for instances that lack
      // `isReady` (the original public contract).
      if (typeof candidate.isReady === 'function') {
        return (candidate.isReady as () => boolean).call(instance);
      }
      return connected;
    },
    reachability,
    isHealthy: async (): Promise<boolean> => {
      const reachable = await reachability();
      return reachable !== false;
    },
  };
  registerRoutedPublish(adapter, () => routedPublishAvailable(instance));
  return adapter;
}
