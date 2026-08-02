/**
 * Fake {@linkcode IPluginContext} for unit-testing without a real kernel.
 * Provides a minimal `runtime`, optional logger, and captures registrations, health indicators, close handlers.
 *
 * @module
 */

import type { IFileSystem, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/** A captured logger call. */
export interface LogCall {
  readonly message: string;
  readonly meta?: Record<string, unknown> | undefined;
}

/** The fake context and its capture buffers. */
export interface FakeFlagContext {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly healthIndicators: Map<string, () => Promise<{ status: string; data?: unknown }>>;
  readonly onCloseHandlers: Array<() => Promise<void> | void>;
  readonly logs: LogCall[];
}

/**
 * Creates a fake plugin context.
 *
 * @param env - The runtime env map exposed to the plugin
 * @param withLogger - When `true`, registers a capturing logger under `logger`
 * @param fs - Optional file-system service
 * @returns The fake context and capture buffers
 */
export function createFakeContext(
  env: Record<string, string | undefined> = {},
  withLogger = false,
  fs?: IFileSystem,
): FakeFlagContext {
  const registered = new Map<string, unknown>();
  const healthIndicators = new Map<
    string,
    () => Promise<{ status: string; data?: unknown }>
  >();
  const onCloseHandlers: Array<() => Promise<void> | void> = [];
  const logs: LogCall[] = [];

  const runtime = {
    env,
    now: (): number => 1_700_000_000_000,
    hrtime: (): number => performance.now(),
    fs,
  } as unknown as IRuntimeServices;

  registered.set(CAPABILITIES.RUNTIME, runtime);

  if (withLogger) {
    registered.set(CAPABILITIES.LOGGER, {
      debug: (message: string, meta?: Record<string, unknown>): void => {
        logs.push({ message, meta });
      },
      info: (): void => {},
      warn: (message: string, meta?: Record<string, unknown>): void => {
        logs.push({ message, meta });
      },
      error: (): void => {},
      fatal: (): void => {},
      trace: (): void => {},
      child: (): unknown => ({}),
    });
  }

  const ctx = {
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        const v = registered.get(token);
        if (v === undefined) {
          throw new Error(`Capability not registered: ${token}`);
        }
        return v as T;
      },
      getAll: <T>(token: string): readonly T[] => {
        const v = registered.get(token);
        return v ? ([v as T] as readonly T[]) : [];
      },
      register: (token: string, svc: unknown): void => {
        if (registered.has(token)) {
          throw new Error(`Duplicate capability registration: ${token}`);
        }
        registered.set(token, svc);
      },
      registerFactory: (): void => {},
      unregister: (): boolean => false,
    },
    health: {
      register: (
        name: string,
        indicator: () => Promise<{ status: string; data?: unknown }>,
      ): void => {
        healthIndicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose: (fn: () => Promise<void> | void): void => {
        onCloseHandlers.push(fn);
      },
      onRegister: (): void => {},
      onInit: (): void => {},
      onBootstrap: (): void => {},
      onRequest: (): void => {},
      onResponse: (): void => {},
      onError: (): void => {},
      onStopping: (): void => {},
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

  return { ctx, registered, healthIndicators, onCloseHandlers, logs };
}
