/** Internal worker-budget option validation and resolution. @module */
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';

/** Default `startupTimeoutMs`: how long a spawned worker may take to signal ready. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Largest delay a runtime timer honours: 2^31 - 1 ms (about 24.8 days). A
 * larger delay overflows and the timer fires after about 1 ms, so a deadline
 * meant to be "very long" would instead kill every worker before it started.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One validated read of the sizing options; later code never re-reads them. */
export interface SizingSnapshot {
  /** The configured bound, or `undefined` to derive the default. */
  readonly maxWorkers: number | undefined;
  /** The resolved startup deadline in milliseconds. */
  readonly startupTimeoutMs: number;
}

/**
 * Reads and validates the sizing options exactly once. Reading once matters:
 * an accessor on the application's options object could return a validated
 * value here and a different one later, so every consumer takes this snapshot.
 *
 * @param options - The plugin options, if any
 * @returns The validated snapshot
 * @throws {RangeError} When `maxWorkers` is neither `Infinity` nor a positive
 * safe integer, or `startupTimeoutMs` is not a positive integer no greater
 * than {@linkcode MAX_TIMER_DELAY_MS}
 */
export function readSizingOptions(options?: WorkerPoolPluginOptions): SizingSnapshot {
  const maxWorkers: unknown = options?.maxWorkers;
  if (
    maxWorkers !== undefined && maxWorkers !== Infinity &&
    (!Number.isSafeInteger(maxWorkers) || (maxWorkers as number) <= 0)
  ) {
    throw new RangeError(
      `maxWorkers must be a positive safe integer or Infinity; received ${describe(maxWorkers)}`,
    );
  }
  const startup: unknown = options?.startupTimeoutMs;
  if (
    startup !== undefined &&
    (!Number.isSafeInteger(startup) || (startup as number) <= 0 ||
      (startup as number) > MAX_TIMER_DELAY_MS)
  ) {
    // No Infinity opt-out on purpose: without a startup deadline a worker that
    // never signals ready holds its shared slot for as long as the process
    // lives once task timeouts are disabled.
    throw new RangeError(
      `startupTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}; ` +
        `received ${describe(startup)}`,
    );
  }
  return {
    maxWorkers: maxWorkers as number | undefined,
    startupTimeoutMs: (startup as number | undefined) ?? DEFAULT_STARTUP_TIMEOUT_MS,
  };
}

/**
 * Validates the sizing options at the plugin factory, so a bad value fails
 * when the plugin is constructed rather than at `start()`.
 *
 * @param options - The plugin options, if any
 * @throws {RangeError} See {@linkcode readSizingOptions}
 */
export function validateSizingOptions(options?: WorkerPoolPluginOptions): void {
  readSizingOptions(options);
}

/** Resolves the service-wide bound once, preserving explicitly sized pools. */
export function resolveMaxWorkers(
  options: WorkerPoolPluginOptions | undefined,
  snapshot: SizingSnapshot,
  parallelism: number,
): number {
  return snapshot.maxWorkers ?? Math.max(
    parallelism,
    budgetSize(options?.defaultPoolSize),
    Object.values(options?.pools ?? {}).reduce((sum, pool) => sum + budgetSize(pool.size), 0),
  );
}

/**
 * A legacy pool size contributes to the derived default only when it is a
 * finite positive number: `NaN` would poison the bound, and `Infinity` would
 * silently make the whole application's budget unbounded.
 */
function budgetSize(size: number | undefined): number {
  return size !== undefined && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Renders any refused value without throwing: a template literal throws
 * `TypeError` for a Symbol, while `String()` renders it.
 */
function describe(value: unknown): string {
  return String(value);
}
