/**
 * Fake {@linkcode IPluginContext} for unit-testing `NotificationPlugin.register`,
 * `createChannel`, and `createProvider` without a real kernel. Captures service
 * registrations and health indicators.
 *
 * `services.get` throws for an absent token and `services.register` rejects a
 * duplicate, mirroring the kernel's real `ServiceRegistry`
 * (`packages/kernel/src/registry/service-registry.ts`) — a fake that silently
 * returned `undefined` would hide a missing fail-fast guard. Registration of the
 * whole app through a real kernel is covered by the integration test.
 *
 * @module
 */
import type { HealthCheckResult, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/** The fake context and its capture buffers. */
export interface FakeContext {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly healthIndicators: Map<string, () => Promise<HealthCheckResult>>;
}

/**
 * Creates a fake plugin context.
 *
 * @param services - Capabilities pre-registered before `register` runs
 * @returns The fake context and capture buffers
 */
export function createFakeContext(services?: Readonly<Record<string, unknown>>): FakeContext {
  const registered = new Map<string, unknown>(Object.entries(services ?? {}));
  const healthIndicators = new Map<string, () => Promise<HealthCheckResult>>();

  // `subtle` and `now` are real: the FCM provider signs a service-account
  // assertion with Web Crypto and expires cached tokens against the wall clock,
  // so a stub that omitted them would let a broken signing path pass.
  const runtime = {
    env: {},
    hrtime: (): number => performance.now(),
    now: (): number => Date.now(),
    subtle: crypto.subtle,
  } as unknown as IRuntimeServices;
  registered.set(CAPABILITIES.RUNTIME, runtime);

  const ctx = {
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        if (!registered.has(token)) {
          throw new Error(
            `No service registered for capability '${token}'. ` +
              `Register a plugin that provides it, or check the token spelling against CAPABILITIES.`,
          );
        }
        return registered.get(token) as T;
      },
      getAll: <T>(token: string): readonly T[] => {
        const v = registered.get(token);
        return v ? [v as T] : [];
      },
      register: (token: string, svc: unknown): void => {
        if (registered.has(token)) {
          throw new Error(
            `Capability '${token}' is already registered. Use { override: true } to replace it.`,
          );
        }
        registered.set(token, svc);
      },
      registerFactory: (): void => {},
      unregister: (): boolean => false,
    },
    health: {
      register: (name: string, indicator: () => Promise<HealthCheckResult>): void => {
        healthIndicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose: (): void => {},
      onRegister: (): void => {},
      onInit: (): void => {},
      onBootstrap: (): void => {},
      onRequest: (): void => {},
      onResponse: (): void => {},
      onError: (): void => {},
      onShutdown: (): void => {},
    },
    middleware: { add: (): void => {} },
    router: {
      get: (): void => {},
      post: (): void => {},
      put: (): void => {},
      patch: (): void => {},
      delete: (): void => {},
      head: (): void => {},
      options: (): void => {},
      group: (): void => {},
      listRoutes: (): readonly unknown[] => [],
    },
    environment: { validate: (): void => {} },
    metrics: { register: (): void => {} },
    openapi: { addSchema: (): void => {} },
    decorators: { register: (): void => {} },
    cli: { register: (): void => {} },
    runtime,
    options: {},
    app: null as unknown as IPluginContext['app'],
  } as unknown as IPluginContext;

  return { ctx, registered, healthIndicators };
}
