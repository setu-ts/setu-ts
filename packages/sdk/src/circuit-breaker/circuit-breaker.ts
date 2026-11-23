/**
 * Internal per-origin circuit breaker for the SDK HTTP client.
 *
 * Closed/open/half-open states over the shared trip rule from
 * `@setu-ts/common/breaker-window` (count or rate arm), with an injected
 * classifier that decides how each rejection is recorded.
 *
 * Design notes:
 * - The trip rule is `createBreakerWindow`'s, from `@setu-ts/common`; its count
 *   arm is the rule the resilience plugin's own breaker applies. A success never clears recorded failures: the count arm trips
 *   on `threshold` failures within the rolling `timeout`, however many
 *   successes fall between them.
 * - The open→half-open cooldown is measured from `openedAt` — the moment the
 *   circuit tripped — NOT from the oldest failure still in the rolling window.
 *   Measuring from the oldest failure conflates the two independent policy
 *   windows: with `timeout < resetTimeout` the failures would age out of the
 *   window before the cooldown elapsed, silently closing the circuit and making
 *   the half-open probe unreachable.
 * - `timeout` (the rolling window) decides when the circuit TRIPS; `resetTimeout`
 *   decides how long it stays open. They are deliberately independent.
 * - Only a half-open probe's success closes the circuit and empties the window.
 *   A call admitted while closed that succeeds after the circuit tripped leaves
 *   it open.
 * - In half-open, only one probe is in flight at a time (`halfOpenInFlight`), so
 *   a queue of waiting callers cannot stampede a fragile dependency.
 * - A FAILED probe reopens the circuit and RESTARTS the cooldown. Without the
 *   restart, `openedAt` would stay in the past, every subsequent call would
 *   satisfy the cooldown check, and the breaker would probe a dead dependency on
 *   every single request — the opposite of failing fast.
 * - The open-circuit message reports the failure count taken when the circuit
 *   opened, which does not age while it stays open.
 *
 * @internal
 */

import type { IClientTiming } from '../http/contracts.ts';
import type { CircuitBreakerPolicy } from '@setu-ts/common';
import { createBreakerWindow } from '@setu-ts/common/breaker-window';
import { ClientCircuitOpenError } from '../errors.ts';
import type { BreakerOutcome } from './classify.ts';

/**
 * Create a circuit breaker instance backed by monotonic time from `timing`.
 *
 * @internal
 */
export function createCircuitBreaker(
  policy: CircuitBreakerPolicy,
  timing: IClientTiming,
  classify: (error: unknown) => BreakerOutcome,
): { execute: <T>(fn: () => Promise<T>) => Promise<T> } {
  const window = createBreakerWindow(policy, () => timing.now());
  /** When the circuit last tripped, or `null` while closed. */
  let openedAt: number | null = null;
  /** The window's failure count when the circuit last opened. */
  let trippedWith = 0;
  /** Whether a half-open probe is currently in flight. */
  let halfOpenInFlight = false;

  const execute = async <T>(fn: () => Promise<T>): Promise<T> => {
    const now = timing.now();

    // `probing` is captured per call rather than read back off shared state in
    // the settlement handlers: a concurrent caller may flip `halfOpenInFlight`
    // between this gate and `fn()` settling.
    let probing = false;

    if (openedAt !== null) {
      if (now - openedAt < policy.resetTimeout) {
        throw new ClientCircuitOpenError(
          `Circuit breaker open for origin; ${trippedWith} failures in window`,
        );
      }
      if (halfOpenInFlight) {
        throw new ClientCircuitOpenError('Circuit breaker half-open; probe in flight');
      }
      halfOpenInFlight = true;
      probing = true;
    }

    try {
      const result = await fn();
      if (probing) {
        // A successful probe closes the circuit and empties the window.
        halfOpenInFlight = false;
        window.reset();
        openedAt = null;
      } else {
        window.recordSuccess();
      }
      return result;
    } catch (error) {
      if (probing) halfOpenInFlight = false;

      const outcome = classify(error);
      if (outcome === 'failure') {
        // Timestamp the failure when it actually happened, not when the call
        // started — a slow request must not have its failure age prematurely.
        const at = timing.now();
        if (probing) {
          // Failed probe: reopen and restart the cooldown.
          window.reset();
          window.recordFailure();
          openedAt = at;
          trippedWith = 1;
        } else if (window.recordFailure()) {
          openedAt = at;
          trippedWith = window.failures;
        }
      } else if (outcome === 'success' && !probing) {
        // The origin answered; a non-failure leaves a half-open circuit
        // probeable rather than closing it.
        window.recordSuccess();
      }

      throw error;
    }
  };

  return { execute };
}
