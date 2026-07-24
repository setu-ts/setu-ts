/**
 * Fake {@linkcode IPluginContext} for unit-testing the WorkerPoolPlugin's
 * `register` without a real kernel. Captures service registrations, health
 * indicators, and close handlers.
 *
 * @module
 */
import type { HealthIndicatorFn, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/** The fake context and its capture buffers. */
export interface FakeContext {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly healthIndicators: Map<string, HealthIndicatorFn>;
  readonly onCloseHandlers: Array<() => Promise<void> | void>;
}

/**
 * Creates a fake plugin context around the given runtime services.
 *
 * @param runtime - Runtime services exposed on `ctx.runtime`
 * @returns The fake context and capture buffers
 */
export function createFakeContext(runtime: IRuntimeServices): FakeContext {
  const registered = new Map<string, unknown>();
  const healthIndicators = new Map<string, HealthIndicatorFn>();
  const onCloseHandlers: Array<() => Promise<void> | void> = [];
  registered.set(CAPABILITIES.RUNTIME, runtime);

  const ctx = {
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => registered.get(token) as T,
      register: (token: string, service: unknown): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (name: string, indicator: HealthIndicatorFn): void => {
        healthIndicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose: (fn: () => Promise<void> | void): void => {
        onCloseHandlers.push(fn);
      },
    },
    runtime,
  } as unknown as IPluginContext;

  return { ctx, registered, healthIndicators, onCloseHandlers };
}
