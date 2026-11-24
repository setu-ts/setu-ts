/**
 * Cross-runtime operations — functions that are identical across Node 18+,
 * Deno, and Bun because they rely on web-standard APIs available on
 * `globalThis`.
 *
 * @module
 */

import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';

// ---------------------------------------------------------------------------
// Individual cross-runtime implementations (exported for unit testing)
// ---------------------------------------------------------------------------

/** Generates a UUID v4 using `crypto.randomUUID()`. */
export function crossUuid(): string {
  return crypto.randomUUID();
}

/** Generates cryptographically secure random bytes. */
export function crossRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Returns the web-standard `SubtleCrypto` instance. */
export const crossSubtle: SubtleCrypto = crypto.subtle;

/** Returns the current wall-clock time in milliseconds since the epoch. */
export function crossNow(): number {
  return Date.now();
}

/**
 * Returns a high-resolution monotonic timestamp in milliseconds.
 * Uses `performance.now()` which is monotonic and sub-millisecond precise.
 */
export function crossHrtime(): number {
  return performance.now();
}

/**
 * Schedules a one-shot callback using `globalThis.setTimeout`.
 */
export function crossSetTimeout(fn: () => void, ms: number): TimerHandle {
  return globalThis.setTimeout(fn, ms);
}

/**
 * Lets the process exit while a timer is pending: the handle's `unref()` on
 * Node, Bun and Deno 2 (all return a timer object; measured on Deno 2.9.6),
 * or `Deno.unrefTimer` for a numeric id where that exists; nothing elsewhere
 * (workerd's numeric ids, where an isolate does not outlive its requests).
 *
 * @param handle - A timer handle from this runtime
 */
export function crossUnrefTimer(handle: TimerHandle): void {
  if (typeof handle === 'object' && handle !== null) {
    const unref = (handle as { unref?: unknown }).unref;
    if (typeof unref === 'function') (unref as () => void).call(handle);
    return;
  }
  if (typeof handle !== 'number') return;
  const deno = (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno;
  deno?.unrefTimer?.(handle);
}

/** Cancels a setTimeout handle. */
export function crossClearTimeout(handle: TimerHandle): void {
  globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
}

/** Schedules a repeating callback using `globalThis.setInterval`. */
export function crossSetInterval(fn: () => void, ms: number): TimerHandle {
  return globalThis.setInterval(fn, ms);
}

/** Cancels a setInterval handle. */
export function crossClearInterval(handle: TimerHandle): void {
  globalThis.clearInterval(handle as Parameters<typeof globalThis.clearInterval>[0]);
}

// ---------------------------------------------------------------------------
// Merge helper
// ---------------------------------------------------------------------------

/**
 * Factory that merges divergent runtime operations with cross-runtime ones.
 * Used by each adapter to produce a complete {@linkcode IRuntimeServices}.
 */
export function mergeRuntimeServices(
  divergent: Pick<
    IRuntimeServices,
    | 'platform'
    | 'version'
    | 'hostname'
    | 'env'
    | 'exit'
    | 'fs'
    | 'workers'
    | 'dns'
    | 'createDnsResolver'
    | 'onSignal'
    | 'onFatalError'
    | 'reportError'
  >,
): IRuntimeServices {
  return {
    uuid: crossUuid,
    randomBytes: crossRandomBytes,
    subtle: crossSubtle,
    now: crossNow,
    hrtime: crossHrtime,
    setTimeout: crossSetTimeout,
    clearTimeout: crossClearTimeout,
    unrefTimer: crossUnrefTimer,
    setInterval: crossSetInterval,
    clearInterval: crossClearInterval,
    ...divergent,
  };
}
