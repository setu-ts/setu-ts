/**
 * Shared frame dispatch for every transport.
 *
 * All three transports fan one arriving frame out to a set of handlers, and all
 * three must do it the same way: a handler that throws may not starve the
 * handlers after it. That matters more here than in most fan-outs, because the
 * WebSocket and SSE plugins subscribe to the SAME backplane — so an exception
 * escaping one consumer would silently stop delivery to the other — and because
 * on the Redis and broker paths the loop runs inside a driver callback, where
 * nothing above it would catch the throw.
 *
 * Internal to the plugin: not exported from `src/index.ts`.
 *
 * @module
 * @since 0.2.0
 */

import type { RealtimeFrame, RealtimeFrameHandler } from '@setu-ts/common';

/**
 * Invoked when a subscriber throws, so a transport can report the failure
 * rather than swallow it.
 *
 * @param error - The value the handler threw
 * @since 0.2.0
 */
export type DispatchErrorReporter = (error: unknown) => void;

/**
 * Delivers `frame` to every handler, isolating each from the others.
 *
 * A throwing handler is reported through `onError` and the fan-out continues,
 * mirroring the rule the WebSocket plugin's room broadcast already follows: one
 * unwritable peer must never cost the rest their message.
 *
 * @param handlers - The subscribed handlers
 * @param frame - The frame to deliver
 * @param onError - Reporter for a throwing handler
 * @since 0.2.0
 */
export function dispatchFrame(
  handlers: Iterable<RealtimeFrameHandler>,
  frame: RealtimeFrame,
  onError: DispatchErrorReporter,
): void {
  // Snapshotted so a handler that subscribes or unsubscribes during delivery
  // cannot mutate the collection being iterated.
  for (const handler of [...handlers]) {
    try {
      handler(frame);
    } catch (error) {
      onError(error);
    }
  }
}
