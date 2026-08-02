/**
 * Frame validation and fan-out dispatch for the Durable Object backplane.
 *
 * `realtime-backplane-plugin` ships the identical two helpers, and this is a
 * deliberate local copy rather than an import: AI_GUIDELINES §2.2/§3.3 forbid a
 * plugin importing another plugin, which is the same constraint that made
 * M30b's `pemToDer` a local copy of auth-plugin's. §11.1 (no duplicated logic)
 * is scoped within a package, and the two copies have no reason to drift —
 * the shape they validate is a committed `common` type, so a change to it
 * changes both by force.
 *
 * Internal to this package: NOT exported from `src/index.ts`.
 *
 * @module
 * @since 0.2.0
 */

import type { RealtimeFrame, RealtimeFrameHandler } from '@hono-enterprise/common';

/** The two frame kinds the committed contract defines. */
const FRAME_KINDS = new Set(['ws-room', 'sse-channel']);

/**
 * Reports whether a decoded value is a {@linkcode RealtimeFrame}.
 *
 * A backplane topic is shared infrastructure, so anything arriving on it that
 * is not a frame — another application sharing the Durable Object namespace, a
 * half-written message, a future field this build does not know — is dropped
 * rather than delivered to consumers typed against the contract.
 *
 * @param value - The decoded message
 * @returns `true` when every required field is present and correctly typed
 * @since 0.2.0
 */
export function isRealtimeFrame(value: unknown): value is RealtimeFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (typeof frame['kind'] !== 'string' || !FRAME_KINDS.has(frame['kind'])) return false;
  if (typeof frame['origin'] !== 'string') return false;
  if (typeof frame['name'] !== 'string') return false;
  if (typeof frame['data'] !== 'string') return false;
  if (frame['binary'] !== undefined && typeof frame['binary'] !== 'boolean') return false;
  if (frame['exceptId'] !== undefined && typeof frame['exceptId'] !== 'string') return false;
  return true;
}

/**
 * Invoked when a subscriber throws, so the transport can report rather than
 * swallow the failure.
 *
 * @param error - The value the handler threw
 * @since 0.2.0
 */
export type DispatchErrorReporter = (error: unknown) => void;

/**
 * Delivers `frame` to every handler, isolating each from the others.
 *
 * The isolation is load-bearing rather than defensive: the WebSocket and SSE
 * plugins subscribe to the SAME backplane, so an exception escaping one
 * consumer would silently stop delivery to the other, and this loop runs inside
 * a socket event listener where nothing above it would catch the throw.
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
