/**
 * Internal per-origin circuit breaker for the SDK HTTP client.
 *
 * Rolling-window failure tracking with closed/open/half-open states and an
 * injected `isFailure` predicate that classifies which errors count.
 *
 * Design notes:
 * - On success in CLOSED state, the entire failure window is cleared (reset on success).
 *   This is a deliberate choice: a single successful request indicates the downstream
 *   service has recovered, so we reset the failure count to allow immediate traffic.
 *   This differs from some implementations that only age failures out over time;
 *   resetting on success provides faster recovery while still respecting the rolling window
 *   for detecting renewed failures. See comparison with resilience-plugin below.
 * - In HALF-OPEN state, only one probe is allowed in flight at a time (guarded by
 *   `halfOpenInFlight`). If the probe succeeds, the circuit closes and failures are cleared.
 *   If it fails, the circuit reopens. This single-probe strategy prevents stampeding
 *   multiple concurrent requests against a potentially unstable service.
 *
 * @internal
 */

import type { IClientTiming } from '../http/contracts.ts';
import type { CircuitBreakerPolicy } from 'jsr:@hono-enterprise/common@^0.1.0-alpha.2';
import { ClientCircuitOpenError } from '../errors.ts';

interface State {
  failures: number[];
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
  const state: State = { failures: [], halfOpenInFlight: false };

  const execute = async <T>(fn: () => Promise<T>): Promise<T> => {
    const now = timing.now();

    // Roll the failure window: drop failures older than `timeout`.
    state.failures = state.failures.filter((ts) => now - ts < policy.timeout);

    if (state.failures.length >= policy.threshold) {
      // Circuit is open — check if cooldown expired (half-open transition).
      const oldestFailure = state.failures[0]!;
      if (now - oldestFailure < policy.resetTimeout) {
        // Still within reset timeout — fail fast.
        throw new ClientCircuitOpenError(
          `Circuit breaker open for origin; ${state.failures.length} failures in window`,
        );
      }
      // Cooldown expired — transition to half-open: allow one probe.
      if (state.halfOpenInFlight) {
        throw new ClientCircuitOpenError('Circuit breaker half-open; probe in flight');
      }
      state.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      // Success: reset on half-open probe success or clear failures.
      if (state.halfOpenInFlight) {
        state.failures = [];
        state.halfOpenInFlight = false;
      } else {
        // In closed state, clear failures on success.
        state.failures = [];
      }
      return result;
    } catch (error) {
      if (isFailure(error)) {
        state.failures.push(now);
      }
      if (state.halfOpenInFlight) {
        state.halfOpenInFlight = false;
        // Half-open probe failed — stays open.
      }
      throw error;
    }
  };

  return { execute };
}
