/**
 * The realtime observation attachment (M98l) — INTERNAL, never exported from
 * the package barrel, so application code cannot attach, replace or read a
 * component's collector.
 *
 * The plugin attaches its collector to the `WebSocketService` it constructed,
 * and the service attaches the same collector to each connection it opens.
 * A capture site asks {@linkcode realtimeObserverOf} first: with nothing
 * attached it takes the pre-M98l path unchanged, reading no clock and deriving
 * nothing. The collector itself is the shared one in `@setu-ts/common`.
 *
 * @module
 */

import type { IRealtimeObservationCollector } from '@setu-ts/common';

const OBSERVERS = new WeakMap<object, IRealtimeObservationCollector>();

/**
 * Attaches a collector to a plugin-owned service or connection.
 *
 * @param target - The service or connection
 * @param collector - Its plugin's collector
 * @internal
 */
export function attachRealtimeObserver(
  target: object,
  collector: IRealtimeObservationCollector,
): void {
  OBSERVERS.set(target, collector);
}

/**
 * Detaches a target's collector. The plugin's close hook detaches the service
 * FIRST and then closes the collector, so a connection opened afterwards is
 * not observed and a late observation on an existing one is discarded.
 *
 * @param target - The service or connection
 * @internal
 */
export function detachRealtimeObserver(target: object): void {
  OBSERVERS.delete(target);
}

/**
 * The collector attached to a target, or `undefined` when none is.
 *
 * @param target - The service or connection
 * @returns The attached collector
 * @internal
 */
export function realtimeObserverOf(target: object): IRealtimeObservationCollector | undefined {
  return OBSERVERS.get(target);
}
