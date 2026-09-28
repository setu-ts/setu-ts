/**
 * The realtime observation attachment (M98l) — INTERNAL, never exported from
 * the package barrel, so application code cannot attach, replace or read a
 * component's collector.
 *
 * The plugin attaches its collector to the transport it constructed (memory,
 * redis or messaging — never a `'custom'` one).
 * A capture site asks {@linkcode realtimeObserverOf} first: with nothing
 * attached it takes the pre-M98l path unchanged, reading no clock and deriving
 * nothing. The collector itself is the shared one in `@setu-ts/common`.
 *
 * @module
 */

import type { IRealtimeObservationCollector } from '@setu-ts/common';

const OBSERVERS = new WeakMap<object, IRealtimeObservationCollector>();

/**
 * Attaches a collector to a plugin-owned transport.
 *
 * @param target - The transport
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
 * Detaches a transport's collector. The plugin's close hook detaches it
 * FIRST and then closes the collector, before the transport itself closes, so
 * nothing the shutdown does is observed.
 *
 * @param target - The transport
 * @internal
 */
export function detachRealtimeObserver(target: object): void {
  OBSERVERS.delete(target);
}

/**
 * The collector attached to a transport, or `undefined` when none is.
 *
 * @param target - The transport
 * @returns The attached collector
 * @internal
 */
export function realtimeObserverOf(target: object): IRealtimeObservationCollector | undefined {
  return OBSERVERS.get(target);
}
