/**
 * Resilience service — composes circuit breaker, retry, timeout, and bulkhead
 * patterns around a caller-supplied async function.
 *
 * @module
 */
import type {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  IResilienceService,
  IRuntimeServices,
  RetryPolicy,
  WrapOptions,
} from '@hono-enterprise/common';
import type { ITimers, ResiliencePluginOptions } from '../interfaces/index.ts';
import { CircuitBreaker } from '../patterns/circuit-breaker.ts';
import { Bulkhead } from '../patterns/bulkhead.ts';
import { runWithRetry } from '../patterns/retry.ts';
import { runWithTimeout } from '../patterns/timeout.ts';

/**
 * The concrete resilience service registered under `CAPABILITIES.RESILIENCE`.
 * Internal to the plugin — not exported from `src/index.ts`.
 */
export class ResilienceService implements IResilienceService {
  readonly #runtime: IRuntimeServices;
  readonly #options: ResiliencePluginOptions;
  readonly #timers: ITimers;

  /**
   * @param runtime - Runtime services supplying the monotonic clock and timers
   * @param options - Plugin options carrying the default policies
   */
  constructor(runtime: IRuntimeServices, options: ResiliencePluginOptions = {}) {
    this.#runtime = runtime;
    this.#options = options;
    this.#timers = {
      setTimeout: (fn, ms) => runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => runtime.clearTimeout(handle),
    };
  }

  /**
   * Wraps `fn` with the selected patterns, building the pattern chain once and
   * returning a state-preserving closure (§3.2/§3.7).
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call
   * @param options - Which patterns to apply and their policies
   * @returns A hardened callable reusing one shared pattern chain
   * @throws {Error} When a pattern is requested as `true` with no matching
   * `default*` policy configured on the plugin
   */
  wrap<T>(fn: () => Promise<T>, options: WrapOptions = {}): () => Promise<T> {
    const breakerPolicy = this.#resolveCircuitBreaker(options.circuitBreaker);
    const retryPolicy = this.#resolveRetry(options.retry);
    const bulkheadPolicy = this.#resolveBulkhead(options.bulkhead);
    const timeoutMs = options.timeout;

    // Innermost first: timeout(fn).
    let call: () => Promise<T> = fn;

    if (timeoutMs !== undefined) {
      const innerCall = call;
      call = () => runWithTimeout(innerCall, timeoutMs, this.#timers);
    }

    if (retryPolicy !== undefined) {
      const innerCall = call;
      call = () => runWithRetry(innerCall, retryPolicy, this.#timers);
    }

    if (breakerPolicy !== undefined) {
      const breaker = new CircuitBreaker(breakerPolicy, () => this.#runtime.hrtime());
      const innerCall = call;
      call = () => breaker.execute(innerCall);
    }

    if (bulkheadPolicy !== undefined) {
      const bulkhead = new Bulkhead(bulkheadPolicy);
      const innerCall = call;
      call = () => bulkhead.run(innerCall);
    }

    return call;
  }

  /** Resolves the effective circuit-breaker policy, or `undefined` for none. */
  #resolveCircuitBreaker(
    value: WrapOptions['circuitBreaker'],
  ): CircuitBreakerPolicy | undefined {
    if (value === undefined || value === false) {
      return undefined;
    }
    if (value === true) {
      if (this.#options.defaultCircuitBreaker === undefined) {
        throw new Error(
          'resilience.wrap: circuitBreaker: true requires defaultCircuitBreaker in ResiliencePlugin options',
        );
      }
      return this.#options.defaultCircuitBreaker;
    }
    return value;
  }

  /** Resolves the effective retry policy, or `undefined` for none. */
  #resolveRetry(value: WrapOptions['retry']): RetryPolicy | undefined {
    if (value === undefined || value === false) {
      return undefined;
    }
    if (value === true) {
      if (this.#options.defaultRetry === undefined) {
        throw new Error(
          'resilience.wrap: retry: true requires defaultRetry in ResiliencePlugin options',
        );
      }
      return this.#options.defaultRetry;
    }
    return value;
  }

  /** Resolves the effective bulkhead policy, or `undefined` for none. */
  #resolveBulkhead(value: WrapOptions['bulkhead']): BulkheadPolicy | undefined {
    if (value === undefined || value === false) {
      return undefined;
    }
    if (value === true) {
      if (this.#options.defaultBulkhead === undefined) {
        throw new Error(
          'resilience.wrap: bulkhead: true requires defaultBulkhead in ResiliencePlugin options',
        );
      }
      return this.#options.defaultBulkhead;
    }
    return value;
  }
}
