/**
 * Circuit breaker pattern — closed/open/half-open state machine over the
 * committed `CircuitState` union, driven by an injected monotonic clock.
 *
 * @module
 */
import type {
  CircuitBreakerPolicy,
  CircuitState,
  ICircuitBreaker,
  IBreakerWindow,
  ResilientCall,
} from '@setu-ts/common';
import { createBreakerWindow } from '@setu-ts/common';
import { CircuitOpenError } from '../errors.ts';
import { throwIfAborted } from './abort.ts';

/**
 * A circuit breaker protecting an unreliable dependency.
 *
 * Internal to the resilience plugin — not exported from `src/index.ts`. The
 * monotonic clock (`hrtime`) is injected so the rolling failure window and the
 * open→half-open cooldown are measured as durations, never against wall-clock
 * time (never `Date.now()`).
 */
export class CircuitBreaker implements ICircuitBreaker {
  readonly #resetTimeout: number;
  readonly #hrtime: () => number;

  readonly #window: IBreakerWindow;
  /** Current state; `open` is realized lazily via {@linkcode state}. */
  #state: CircuitState = 'closed';
  /** Monotonic timestamp the breaker last opened. */
  #openedAt = 0;
  /** True while a half-open trial call is in flight (single-probe guard). */
  #probing = false;

  /**
   * @param policy - The breaker thresholds and windows
   * @param hrtime - A monotonic clock (`runtime.hrtime()`)
   * @throws {RangeError} When the policy fails breakerPolicyRangeError
   */
  constructor(policy: CircuitBreakerPolicy, hrtime: () => number) {
    // One read of each field: the checked copy is the one used, so a getter
    // cannot pass the check and then hand the cooldown something else.
    const snapshot = {
      threshold: policy.threshold,
      failureRateThreshold: policy.failureRateThreshold,
      minimumCalls: policy.minimumCalls,
      timeout: policy.timeout,
      resetTimeout: policy.resetTimeout,
    } as CircuitBreakerPolicy;
    this.#window = createBreakerWindow(snapshot, hrtime);
    this.#resetTimeout = snapshot.resetTimeout;
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
   * @param fn - The protected call, handed the cancellation signal
   * @param signal - Optional caller-owned signal cancelling the call
   * @returns The call result
   * @throws {CircuitOpenError} When the breaker is open (fails fast without
   * invoking `fn`), or while another half-open probe is already in flight
   */
  async execute<T>(fn: ResilientCall<T>, signal?: AbortSignal): Promise<T> {
    // A cancelled call must not consume a half-open probe slot or count a
    // failure against the rolling window.
    throwIfAborted(signal);

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
      return await this.#runTrial(fn, signal);
    }

    // closed
    try {
      const result = await fn(signal ?? new AbortController().signal);
      this.#window.recordSuccess();
      return result;
    } catch (error) {
      this.#recordFailure();
      throw error;
    }
  }

  /** Runs a single half-open trial call, transitioning on its outcome. */
  async #runTrial<T>(fn: ResilientCall<T>, signal: AbortSignal | undefined): Promise<T> {
    this.#probing = true;
    try {
      const result = await fn(signal ?? new AbortController().signal);
      // Success → close and clear the failure window.
      this.#state = 'closed';
      this.#window.reset();
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
    if (this.#window.recordFailure()) {
      this.#state = 'open';
      this.#openedAt = this.#hrtime();
    }
  }

  /** True once the open→half-open cooldown has elapsed. */
  #cooldownElapsed(): boolean {
    return this.#hrtime() - this.#openedAt >= this.#resetTimeout;
  }
}
