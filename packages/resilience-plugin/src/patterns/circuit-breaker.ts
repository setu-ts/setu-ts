/**
 * Circuit breaker pattern — closed/open/half-open state machine over the
 * committed `CircuitState` union, driven by an injected monotonic clock.
 *
 * @module
 */
import type { CircuitBreakerPolicy, CircuitState, ICircuitBreaker } from '@hono-enterprise/common';
import { CircuitOpenError } from '../errors.ts';

/**
 * A circuit breaker protecting an unreliable dependency.
 *
 * Internal to the resilience plugin — not exported from `src/index.ts`. The
 * monotonic clock (`hrtime`) is injected so the rolling failure window and the
 * open→half-open cooldown are measured as durations, never against wall-clock
 * time (never `Date.now()`).
 */
export class CircuitBreaker implements ICircuitBreaker {
  readonly #policy: CircuitBreakerPolicy;
  readonly #hrtime: () => number;

  /** Monotonic timestamps of recent failures, oldest first. */
  #failures: number[] = [];
  /** Current state; `open` is realized lazily via {@linkcode state}. */
  #state: CircuitState = 'closed';
  /** Monotonic timestamp the breaker last opened. */
  #openedAt = 0;
  /** True while a half-open trial call is in flight (single-probe guard). */
  #probing = false;

  /**
   * @param policy - The breaker thresholds and windows
   * @param hrtime - A monotonic clock (`runtime.hrtime()`)
   */
  constructor(policy: CircuitBreakerPolicy, hrtime: () => number) {
    this.#policy = policy;
    this.#hrtime = hrtime;
  }

  /**
   * The current circuit state, recomputing open→half-open eligibility lazily
   * so a read after `resetTimeout` reports `half-open`.
   */
  get state(): CircuitState {
    if (this.#state === 'open' && this.#cooldownElapsed()) {
      return 'half-open';
    }
    return this.#state;
  }

  /**
   * Executes a call through the breaker.
   *
   * @typeParam T - The call's result type
   * @param fn - The protected call
   * @returns The call result
   * @throws {CircuitOpenError} When the breaker is open (fails fast without
   * invoking `fn`), or while another half-open probe is already in flight
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#state === 'open') {
      if (!this.#cooldownElapsed()) {
        throw new CircuitOpenError();
      }
      // Cooldown elapsed → move to half-open and run a single trial.
      this.#state = 'half-open';
    }

    if (this.#state === 'half-open') {
      if (this.#probing) {
        throw new CircuitOpenError();
      }
      return await this.#runTrial(fn);
    }

    // closed
    try {
      return await fn();
    } catch (error) {
      this.#recordFailure();
      throw error;
    }
  }

  /** Runs a single half-open trial call, transitioning on its outcome. */
  async #runTrial<T>(fn: () => Promise<T>): Promise<T> {
    this.#probing = true;
    try {
      const result = await fn();
      // Success → close and clear the failure window.
      this.#state = 'closed';
      this.#failures = [];
      return result;
    } catch (error) {
      // Failure → re-open and reset the cooldown.
      this.#state = 'open';
      this.#openedAt = this.#hrtime();
      throw error;
    } finally {
      this.#probing = false;
    }
  }

  /** Records a closed-state failure and trips open when the threshold is met. */
  #recordFailure(): void {
    const now = this.#hrtime();
    this.#failures.push(now);
    // Drop failures older than the rolling window.
    const cutoff = now - this.#policy.timeout;
    this.#failures = this.#failures.filter((t) => t > cutoff);
    if (this.#failures.length >= this.#policy.threshold) {
      this.#state = 'open';
      this.#openedAt = now;
    }
  }

  /** True once the open→half-open cooldown has elapsed. */
  #cooldownElapsed(): boolean {
    return this.#hrtime() - this.#openedAt >= this.#policy.resetTimeout;
  }
}
