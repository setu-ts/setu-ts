/**
 * The three load-balancing strategies.
 *
 * Randomness comes from `IRuntimeServices.randomBytes`, never `Math.random()`
 * — it is on the mandatory runtime services, so a test fakes it through the
 * runtime it already builds and every selection becomes deterministic without
 * a new seam.
 *
 * @module
 */
import type { IRuntimeServices, LoadBalanceStrategy, ServiceInstance } from '@setu-ts/common';

/** Picks one instance from a non-empty candidate list, or `null` from an empty one. */
export interface LoadBalancer {
  /**
   * Chooses an instance.
   *
   * @param serviceName - Keys the round-robin cursor
   * @param instances - Candidates, already filtered for ejection
   * @param strategy - Overrides the configured strategy for this call
   * @returns The chosen instance, or `null` when there are none
   */
  pick(
    serviceName: string,
    instances: readonly ServiceInstance[],
    strategy?: LoadBalanceStrategy,
  ): ServiceInstance | null;
}

/** Reads four random bytes as a float in `[0, 1)`. */
function randomFloat(runtime: IRuntimeServices): number {
  const bytes = runtime.randomBytes(4);
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return value / 2 ** 32;
}

/** A weight of `undefined` means 1; a non-positive weight means never selected. */
function weightOf(instance: ServiceInstance): number {
  const weight = instance.weight ?? 1;
  return weight > 0 ? weight : 0;
}

/**
 * Creates a stateful balancer.
 *
 * The round-robin cursor lives in the returned closure, so it survives across
 * calls but not across plugin instances.
 *
 * @param defaultStrategy - Used when a call names none
 * @param runtime - Supplies `randomBytes`
 * @returns The balancer
 * @since 0.2.0
 */
export function createLoadBalancer(
  defaultStrategy: LoadBalanceStrategy,
  runtime: IRuntimeServices,
): LoadBalancer {
  const cursors = new Map<string, number>();

  return {
    pick(
      serviceName: string,
      instances: readonly ServiceInstance[],
      strategy?: LoadBalanceStrategy,
    ): ServiceInstance | null {
      if (instances.length === 0) {
        return null;
      }
      const chosen = strategy ?? defaultStrategy;

      if (chosen === 'round-robin') {
        const cursor = cursors.get(serviceName) ?? 0;
        cursors.set(serviceName, cursor + 1);
        // Modulo the CURRENT length, so a list that shrinks between picks
        // still selects in range rather than reading past the end.
        return instances[cursor % instances.length];
      }

      if (chosen === 'random') {
        return instances[Math.floor(randomFloat(runtime) * instances.length)];
      }

      const total = instances.reduce((sum, instance) => sum + weightOf(instance), 0);
      if (total === 0) {
        // Every weight is non-positive. Serving nothing would be worse than
        // ignoring a configuration that asked for nothing to be served, so
        // selection falls back to uniform over the whole list.
        return instances[Math.floor(randomFloat(runtime) * instances.length)];
      }

      // Walks every bucket but the last, which is the natural fallthrough —
      // so no branch here is unreachable and a floating-point edge lands on a
      // real instance rather than on a defensive `null`.
      let target = randomFloat(runtime) * total;
      for (let i = 0; i < instances.length - 1; i++) {
        target -= weightOf(instances[i]);
        if (target < 0) {
          return instances[i];
        }
      }
      return instances[instances.length - 1];
    },
  };
}
