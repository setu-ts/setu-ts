/**
 * Internal per-origin circuit breaker for the SDK HTTP client.
 *
 * Rolling-window failure tracking with closed/open/half-open states and an
 * injected `isFailure` predicate that classifies which errors count.
 *
 * Design notes:
 * - The open→half-open cooldown is measured from `openedAt` — the moment the
 *   circuit tripped — NOT from the oldest failure still in the rolling window.
 *   Measuring from the oldest failure conflates the two independent policy
 *   windows: with `timeout < resetTimeout` the failures would age out of the
 *   window before the cooldown elapsed, silently closing the circuit and making
 *   the half-open probe unreachable.
 * - `timeout` (the rolling window) decides when the circuit TRIPS; `resetTimeout`
 *   decides how long it stays open. They are deliberately independent.
 * - On success the failure window is cleared and the circuit closes. This is a
 *   deliberate reset-on-success: one good response means the dependency is
 *   answering, so callers should not stay throttled by aged failures.
 * - In half-open, only one probe is in flight at a time (`halfOpenInFlight`), so
 *   a queue of waiting callers cannot stampede a fragile dependency.
 * - A FAILED probe reopens the circuit and RESTARTS the cooldown. Without the
 *   restart, `openedAt` would stay in the past, every subsequent call would
 *   satisfy the cooldown check, and the breaker would probe a dead dependency on
 *   every single request — the opposite of failing fast.
 *
 * @internal
 */

import type { IClientTiming } from '../http/contracts.ts';
import type { CircuitBreakerPolicy } from 'jsr:@hono-enterprise/common@^0.1.0-alpha.2';
import { ClientCircuitOpenError } from '../errors.ts';

interface State {
  /** Monotonic timestamps of counted failures, within the rolling window. */
  failures: number[];
  /** When the circuit last tripped, or `null` while closed. */
  openedAt: number | null;
  /** Whether a half-open probe is currently in flight. */
  halfOpenInFlight: boolean;
}

/**
 * Create a circuit breaker instance backed by monotonic time from `timing`.
 *
 * @internal
 */
export function createCircuitBreaker(
  policy: CircuitBreakerPolicy,
  timing: IClientTiming,
  isFailure: (error: unknown) => boolean,
) {
  const state: State = { failures: [], openedAt: null, halfOpenInFlight: false };

  const execute = async <T>(fn: () => Promise<T>): Promise<T> => {
    const now = timing.now();

    // `probing` is captured per call rather than read back off `state` in the
    // settlement handlers: a concurrent caller may flip `halfOpenInFlight`
    // between this gate and `fn()` settling.
    let probing = false;

    if (state.openedAt !== null) {
      if (now - state.openedAt < policy.resetTimeout) {
        throw new ClientCircuitOpenError(
          `Circuit breaker open for origin; ${state.failures.length} failures in window`,
        );
      }
      if (state.halfOpenInFlight) {
        throw new ClientCircuitOpenError('Circuit breaker half-open; probe in flight');
      }
      state.halfOpenInFlight = true;
      probing = true;
    }

    try {
      const result = await fn();
      // Success closes the circuit and clears the window.
      state.failures = [];
      state.openedAt = null;
      if (probing) state.halfOpenInFlight = false;
      return result;
    } catch (error) {
      if (probing) state.halfOpenInFlight = false;

      if (isFailure(error)) {
        // Timestamp the failure when it actually happened, not when the call
        // started — a slow request must not have its failure age prematurely.
        const at = timing.now();
        if (probing) {
          // Failed probe: reopen and restart the cooldown.
          state.openedAt = at;
          state.failures = [at];
        } else {
          state.failures = state.failures.filter((ts) => at - ts < policy.timeout);
          state.failures.push(at);
          if (state.failures.length >= policy.threshold) {
            state.openedAt = at;
          }
        }
      }

      throw error;
    }
  };

  return { execute };
}
