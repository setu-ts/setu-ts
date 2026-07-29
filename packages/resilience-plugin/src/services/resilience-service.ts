/**
 * Resilience service — composes circuit breaker, retry, timeout, and bulkhead
 * patterns around a caller-supplied async function.
 *
 * @module
 */
import type {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  HardenedCall,
  IResilienceService,
  IRuntimeServices,
  ResilientCall,
  RetryPolicy,
  WrapOptions,
} from '@hono-enterprise/common';
import type { ITimers, ResiliencePluginOptions } from '../interfaces/index.ts';
import { throwIfAborted } from '../patterns/abort.ts';
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
   * Each layer receives and forwards the cancellation signal, so an outer
   * abort reaches the innermost call and the `timeout` layer's own abort is
   * scoped to a single attempt.
   *
   * @typeParam T - The protected call's result type
   * @param fn - The protected call, handed the current attempt's signal
   * @param options - Which patterns to apply and their policies
   * @returns A hardened callable reusing one shared pattern chain, accepting an
   * optional caller-owned signal
   * @throws {Error} When a pattern is requested as `true` with no matching
   * `default*` policy configured on the plugin
   */
  wrap<T>(fn: ResilientCall<T>, options: WrapOptions = {}): HardenedCall<T> {
    const breakerPolicy = this.#resolveCircuitBreaker(options.circuitBreaker);
    const retryPolicy = this.#resolveRetry(options.retry);
    const bulkheadPolicy = this.#resolveBulkhead(options.bulkhead);
    const timeoutMs = options.timeout;

    // Built once per wrap, not per invocation: the stand-in handed to layers
    // when the caller supplies no signal of their own. It is never aborted, so
    // sharing it across invocations is safe.
    const neverAborted = new AbortController().signal;

    // Innermost first: timeout(fn).
    let call: ResilientCall<T> = fn;

    if (timeoutMs !== undefined) {
      const innerCall = call;
      call = (signal) => runWithTimeout(innerCall, timeoutMs, this.#timers, signal);
    }

    if (retryPolicy !== undefined) {
      const innerCall = call;
      call = (signal) => runWithRetry(innerCall, retryPolicy, this.#timers, signal);
    }

    if (breakerPolicy !== undefined) {
      const breaker = new CircuitBreaker(breakerPolicy, () => this.#runtime.hrtime());
      const innerCall = call;
      call = (signal) => breaker.execute(innerCall, signal);
    }

    if (bulkheadPolicy !== undefined) {
      const bulkhead = new Bulkhead(bulkheadPolicy);
      const innerCall = call;
      call = (signal) => bulkhead.run(innerCall, signal);
    }

    const chain = call;
    // `async` is load-bearing: `throwIfAborted` must surface as a REJECTED
    // promise, never a synchronous throw, or `guarded(sig).catch(...)` would
    // raise instead of catching and `HardenedCall`'s `Promise<T>` return type
    // would be a lie.
    return async (signal?: AbortSignal): Promise<T> => {
      // Checked here rather than only inside the layers, so EVERY configuration
      // behaves the same — including a wrap with no layers at all, and the
      // timeout-only and breaker-only chains, which would otherwise invoke the
      // call and resolve successfully for a caller that had already cancelled.
      throwIfAborted(signal);
      return await chain(signal ?? neverAborted);
    };
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
