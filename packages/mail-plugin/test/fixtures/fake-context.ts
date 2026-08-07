/**
 * Fake {@linkcode IPluginContext} for unit/integration-testing the MailPlugin's
 * `register` without a real kernel. Captures service registrations, health
 * indicators, close handlers, and (optionally) exposes a capturing logger on
 * `ctx.logger` — the MailPlugin reads the logger directly off the context.
 *
 * @module
 */
import type { ILogger, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

/** A captured logger call. */
export interface LogCall {
  readonly message: string;
  readonly meta?: Record<string, unknown> | undefined;
}

/** The fake context and its capture buffers. */
export interface FakeContext {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly healthIndicators: Map<string, () => Promise<{ status: string; data?: unknown }>>;
  readonly onCloseHandlers: Array<() => Promise<void> | void>;
  readonly logs: LogCall[];
}

/**
 * Creates a fake plugin context.
 *
 * @param withLogger - When `true`, exposes a capturing logger on `ctx.logger`
 * @returns The fake context and capture buffers
 */
export function createFakeContext(withLogger = false): FakeContext {
  const registered = new Map<string, unknown>();
  const healthIndicators = new Map<
    string,
    () => Promise<{ status: string; data?: unknown }>
  >();
  const onCloseHandlers: Array<() => Promise<void> | void> = [];
  const logs: LogCall[] = [];

  const runtime = {
    env: {},
    hrtime: (): number => performance.now(),
  } as unknown as IRuntimeServices;
  registered.set(CAPABILITIES.RUNTIME, runtime);

  const push = (message: string, meta?: Record<string, unknown>): void => {
    logs.push({ message, meta });
  };
  const logger: ILogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
  } as unknown as ILogger;

  const ctx = {
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => registered.get(token) as T,
      getAll: <T>(token: string): readonly T[] => {
        const v = registered.get(token);
        return v ? [v as T] : [];
      },
      register: (token: string, svc: unknown): void => {
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
    ...(withLogger ? { logger } : {}),
  } as unknown as IPluginContext;

  return { ctx, registered, healthIndicators, onCloseHandlers, logs };
}
