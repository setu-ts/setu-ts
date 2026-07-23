/**
 * Fake `IPluginContext` recording `services.register`, `health.register`, and
 * `lifecycle.onClose` calls for the resilience plugin factory test.
 *
 * @module
 */
import type { HealthIndicatorFn, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { FakeRuntime } from './fake-runtime.ts';

/** A fake context plus the records of what the plugin registered on it. */
export interface FakeContextResult {
  /** The context to pass to `plugin.register`. */
  readonly ctx: IPluginContext;
  /** Services registered by token. */
  readonly registeredServices: Map<string, unknown>;
  /** Health indicators registered by name. */
  readonly registeredHealth: Map<string, HealthIndicatorFn>;
  /** `onClose` callbacks registered. */
  readonly closeCallbacks: Array<() => void | Promise<void>>;
}

/**
 * Builds a fake plugin context.
 *
 * @param runtime - The runtime to expose (defaults to a fresh {@link FakeRuntime})
 * @returns The context and the mutable registration records
 */
export function createFakeContext(
  runtime: IRuntimeServices = new FakeRuntime(),
): FakeContextResult {
  const registeredServices = new Map<string, unknown>();
  const registeredHealth = new Map<string, HealthIndicatorFn>();
  const closeCallbacks: Array<() => void | Promise<void>> = [];

  const partial = {
    runtime,
    services: {
      register<T>(token: string, service: T): void {
        registeredServices.set(token, service);
      },
    },
    health: {
      register(name: string, fn: HealthIndicatorFn): void {
        registeredHealth.set(name, fn);
      },
    },
    lifecycle: {
      onClose(fn: () => void | Promise<void>): void {
        closeCallbacks.push(fn);
      },
    },
  };

  return {
    ctx: partial as unknown as IPluginContext,
    registeredServices,
    registeredHealth,
    closeCallbacks,
  };
}
