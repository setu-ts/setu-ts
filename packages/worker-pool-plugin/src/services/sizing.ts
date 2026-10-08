/** Internal worker-budget option validation and resolution. @module */
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';

/** Validates the new bound at both construction entry points. */
export function validateSizingOptions(options?: WorkerPoolPluginOptions): void {
  const value = options?.maxWorkers;
  if (
    value !== undefined && value !== Infinity &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new RangeError(
      `maxWorkers must be a positive safe integer or Infinity; received ${value}`,
    );
  }
}

/** Resolves the service-wide bound once, preserving explicitly sized pools. */
export function resolveMaxWorkers(
  options: WorkerPoolPluginOptions | undefined,
  parallelism: number,
): number {
  return options?.maxWorkers ?? Math.max(
    parallelism,
    options?.defaultPoolSize ?? 0,
    Object.values(options?.pools ?? {}).reduce((sum, pool) => sum + (pool.size ?? 0), 0),
  );
}
