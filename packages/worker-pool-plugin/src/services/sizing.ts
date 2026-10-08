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

/** One pool entry's overrides, each field read exactly once. */
export interface PoolOverridesSnapshot {
  readonly size: number | undefined;
  readonly maxQueue: number | undefined;
  readonly taskTimeoutMs: number | undefined;
}

/**
 * One validated read of every sizing and timeout option. Later code reads only
 * this, never the application's options object again, so an accessor cannot
 * hand the check one value and the pool another.
 */
export interface SizingSnapshot {
  /** The configured bound, or `undefined` to derive the default. */
  readonly maxWorkers: number | undefined;
  /** The resolved startup deadline in milliseconds. */
  readonly startupTimeoutMs: number;
  /** Plugin-wide `defaultPoolSize`, as configured. */
  readonly defaultPoolSize: number | undefined;
  /** Plugin-wide `maxQueue`, as configured. */
  readonly maxQueue: number | undefined;
  /** Plugin-wide `taskTimeoutMs`, validated. */
  readonly taskTimeoutMs: number | undefined;
  /**
   * Per-module overrides from the OWN enumerable keys of `pools`. An entry
   * inherited through a prototype is ignored, not half-applied: it would be
   * invisible to validation and visible to a later property lookup.
   */
  readonly pools: ReadonlyMap<string, PoolOverridesSnapshot>;
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
  const taskTimeoutMs: unknown = options?.taskTimeoutMs;
  assertTaskTimeout(taskTimeoutMs, 'taskTimeoutMs');
  const pools = new Map<string, PoolOverridesSnapshot>();
  for (const [specifier, entry] of Object.entries(options?.pools ?? {})) {
    const poolTimeout: unknown = entry.taskTimeoutMs;
    assertTaskTimeout(poolTimeout, `pools[${JSON.stringify(specifier)}].taskTimeoutMs`);
    pools.set(specifier, {
      size: entry.size,
      maxQueue: entry.maxQueue,
      taskTimeoutMs: poolTimeout as number | undefined,
    });
  }
  return {
    maxWorkers: maxWorkers as number | undefined,
    startupTimeoutMs: (startup as number | undefined) ?? DEFAULT_STARTUP_TIMEOUT_MS,
    defaultPoolSize: options?.defaultPoolSize,
    maxQueue: options?.maxQueue,
    taskTimeoutMs: taskTimeoutMs as number | undefined,
    pools,
  };
}

/**
 * Refuses a task timeout the pool would silently misread. Before this, `NaN`
 * or a negative value disabled the timeout (the pool arms a timer only for a
 * value `> 0`), and a value above {@linkcode MAX_TIMER_DELAY_MS} overflowed
 * the runtime timer and timed every task out after about 1 ms.
 *
 * @param value - The configured or per-call timeout; `undefined` is allowed
 * @param name - The option name for the error message
 * @throws {RangeError} Unless `value` is `undefined`, `0` (disabled), or a
 * positive integer no greater than {@linkcode MAX_TIMER_DELAY_MS}
 */
export function assertTaskTimeout(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < 0 ||
      (value as number) > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError(
      `${name} must be 0 (disabled) or a positive integer no greater than ` +
        `${MAX_TIMER_DELAY_MS}; received ${describe(value)}`,
    );
  }
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
export function resolveMaxWorkers(snapshot: SizingSnapshot, parallelism: number): number {
  return snapshot.maxWorkers ?? Math.max(
    parallelism,
    budgetSize(snapshot.defaultPoolSize),
    [...snapshot.pools.values()].reduce((sum, pool) => sum + budgetSize(pool.size), 0),
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

/** Longest rendering of a refused value an error message carries. */
const MAX_DESCRIBED_LENGTH = 64;

/**
 * Renders a refused value for an error message: never throws (a template
 * literal throws for a Symbol, and a hostile `toString` can throw too), quotes
 * and escapes strings so control characters cannot forge log lines, and
 * truncates so a caller-supplied value cannot inflate the message.
 */
function describe(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    text = `[unprintable ${typeof value}]`;
  }
  return text.length > MAX_DESCRIBED_LENGTH ? `${text.slice(0, MAX_DESCRIBED_LENGTH)}…` : text;
}
