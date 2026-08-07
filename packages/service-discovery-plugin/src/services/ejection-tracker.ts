/**
 * Outlier ejection — a pool-membership filter, deliberately not a second
 * circuit breaker.
 *
 * A circuit breaker (M27) breaks a **call site**: after enough failures it
 * stops calling at all, which for a multi-instance service means refusing to
 * talk to healthy instances because unhealthy ones failed. Ejection removes a
 * **pool member** while the call site stays open, so traffic keeps flowing to
 * the survivors. The two compose — wrap the call, re-`pick()` inside it.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, ServiceOutcome } from '@setu-ts/common';
import type { EjectionOptions } from '../interfaces/index.ts';

/** Per-instance state: recent failure stamps and the ejection expiry, if any. */
interface InstanceState {
  failures: number[];
  ejectedUntilMs: number | null;
}

/**
 * Tracks reported outcomes and decides which instances are out of rotation.
 *
 * All timekeeping is monotonic (`runtime.hrtime()`); mixing in a wall clock
 * would make every window comparison garbage.
 *
 * @since 0.2.0
 */
export class EjectionTracker {
  readonly #runtime: IRuntimeServices;
  readonly #options: Required<EjectionOptions>;
  readonly #states = new Map<string, InstanceState>();

  /**
   * @param runtime - Supplies the monotonic clock
   * @param options - Threshold, window, duration, and the panic cap
   */
  constructor(runtime: IRuntimeServices, options: Required<EjectionOptions>) {
    this.#runtime = runtime;
    this.#options = options;
  }

  /** Number of instances currently ejected across every service. */
  get ejectedCount(): number {
    const now = this.#runtime.hrtime();
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.ejectedUntilMs !== null && state.ejectedUntilMs > now) {
        count++;
      }
    }
    return count;
  }

  /**
   * Records a call outcome.
   *
   * A success clears the instance's window and un-ejects it immediately —
   * recovery should be as fast as the first successful call, not as slow as
   * the ejection duration.
   *
   * @param serviceName - The service the instance belongs to
   * @param instance - The instance that was called
   * @param outcome - How the call went
   * @param knownCount - How many instances the service currently has, for the cap
   */
  record(
    serviceName: string,
    instance: ServiceInstance,
    outcome: ServiceOutcome,
    knownCount: number,
  ): void {
    const key = this.#key(serviceName, instance.id);
    const now = this.#runtime.hrtime();

    if (outcome === 'success') {
      this.#states.delete(key);
      return;
    }

    const state = this.#states.get(key) ?? { failures: [], ejectedUntilMs: null };
    const windowStart = now - this.#options.windowMs;
    state.failures = state.failures.filter((stamp) => stamp > windowStart);
    state.failures.push(now);
    this.#states.set(key, state);

    if (state.failures.length < this.#options.failureThreshold) {
      return;
    }
    if (state.ejectedUntilMs !== null && state.ejectedUntilMs > now) {
      return;
    }
    if (!this.#capAllows(serviceName, knownCount, now)) {
      return;
    }
    state.ejectedUntilMs = now + this.#options.durationMs;
  }

  /**
   * Removes ejected instances from a candidate list.
   *
   * When every instance is ejected the unfiltered list is returned instead of
   * an empty one: a correlated failure ejects the whole pool at once, and
   * serving nothing converts a partial outage into a total one.
   *
   * @param serviceName - The service being picked from
   * @param instances - The full known list
   * @returns The usable subset, or the full list when nothing would remain
   */
  filter(
    serviceName: string,
    instances: readonly ServiceInstance[],
  ): readonly ServiceInstance[] {
    const now = this.#runtime.hrtime();
    const usable = instances.filter((instance) => !this.#isEjected(serviceName, instance.id, now));
    return usable.length === 0 ? instances : usable;
  }

  /** Drops all tracked state. */
  clear(): void {
    this.#states.clear();
  }

  #key(serviceName: string, id: string): string {
    return `${serviceName}\u0000${id}`;
  }

  #isEjected(serviceName: string, id: string, now: number): boolean {
    const state = this.#states.get(this.#key(serviceName, id));
    return state !== undefined && state.ejectedUntilMs !== null && state.ejectedUntilMs > now;
  }

  /** True when one more ejection would stay within `maxEjectionPercent`. */
  #capAllows(serviceName: string, knownCount: number, now: number): boolean {
    if (knownCount <= 0) {
      return true;
    }
    const prefix = `${serviceName}\u0000`;
    let ejected = 0;
    for (const [key, state] of this.#states) {
      if (
        key.startsWith(prefix) && state.ejectedUntilMs !== null && state.ejectedUntilMs > now
      ) {
        ejected++;
      }
    }
    return ((ejected + 1) / knownCount) * 100 <= this.#options.maxEjectionPercent;
  }
}
