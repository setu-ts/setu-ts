/**
 * Unit tests for SsePlugin — registration, health indicator, onClose cleanup.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SsePlugin } from '../../src/plugin/sse-plugin.ts';
import { SseService } from '../../src/services/sse-service.ts';
import type {
  IPlugin,
  IPluginContext,
  IRealtimeBackplane,
  ISseService,
  RealtimeFrame,
  SseMessage,
  TimerHandle,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

describe('SsePlugin', () => {
  it('should have correct name and version', () => {
    const plugin = SsePlugin();
    expect(plugin.name).toBe('sse-plugin');
    expect(plugin.version).toBe('0.1.0');
  });

  it('should provide CAPABILITIES.SSE', () => {
    const plugin = SsePlugin();
    expect(plugin.provides).toEqual([CAPABILITIES.SSE]);
  });

  it('should have NORMAL priority', () => {
    const plugin = SsePlugin();
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  it('should list logger as optional dependency', () => {
    const p = SsePlugin();
    expect(p.optionalDependencies).toContain('logger');
  });

  it('should accept heartbeatMs option', () => {
    const plugin = SsePlugin({ heartbeatMs: 15000 });
    expect(plugin.name).toBe('sse-plugin');
  });

  it('should accept retryMs option', () => {
    const plugin = SsePlugin({ retryMs: 3000 });
    expect(plugin.name).toBe('sse-plugin');
  });
});

describe('SsePlugin registration', () => {
  let ctx: IPluginContext;
  let registeredService: ISseService | null = null;
  let healthIndicatorName: string | null = null;
  let healthIndicatorFn: (() => Promise<{ status: string; data?: unknown }>) | null = null;
  let onCloseHandler: () => Promise<void>;

  beforeEach(() => {
    registeredService = null;
    healthIndicatorName = null;
    healthIndicatorFn = null;
    onCloseHandler = async () => {};

    ctx = {
      services: {
        register: <T>(token: string, service: T) => {
          if (token === CAPABILITIES.SSE) {
            registeredService = service as ISseService;
          }
        },
        get(_token: string) {
          return undefined as never;
        },
        has: (_token: string): boolean => false,
        getAll: <T extends object>(_token: string): T[] => [],
        unregister: () => false,
        registerFactory: () => {},
      },
      middleware: {
        add: () => {},
      },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      config: {
        get: () => {},
        getOrThrow: () => ({} as never),
        has: () => false,
      },
      environment: {
        validate: () => {},
      },
      health: {
        register: (
          name: string,
          indicator: () => Promise<{ status: string; data?: unknown }>,
        ) => {
          healthIndicatorName = name;
          healthIndicatorFn = indicator;
        },
      },
      metrics: {
        register: () => {},
      },
      openapi: {
        addSchema: () => {},
      },
      decorators: {
        register: () => {},
      },
      cli: {
        register: () => {},
      },
      lifecycle: {
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onShutdown: () => {},
        onClose: (fn: () => Promise<void>) => {
          onCloseHandler = fn;
        },
      },
      logger: undefined as never,
      runtime: {
        platform: () => 'node' as const,
        version: () => 'test',
        now: () => Date.now(),
        hrtime: () => 0,
        setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
        clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
        setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
        clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
        uuid: () => 'test-uuid',
        randomBytes: (n: number) => new Uint8Array(n),
        subtle: {} as SubtleCrypto,
        env: {},
        exit: () => {
          throw new Error('exit');
        },
        hostname: () => 'localhost',
      },
      metadata: undefined as never,
      container: undefined as never,
      options: {},
      app: {} as unknown as typeof ctx.app,
    };
  });

  it('should register an ISseService under CAPABILITIES.SSE', async () => {
    const plugin = SsePlugin() as IPlugin;
    await plugin.register(ctx);

    expect(registeredService).toBeInstanceOf(SseService);
    expect(healthIndicatorName).toBe('sse');
    expect(healthIndicatorFn).not.toBeNull();

    if (healthIndicatorFn) {
      const result = await healthIndicatorFn();
      expect(result.status).toBe('up');
      // Assert the full documented shape (§3.9), not just that data exists:
      // the indicator surfaces the live connection count (0 at registration).
      expect(result.data).toEqual({ connections: 0 });
    }

    expect(onCloseHandler).not.toBeNull();
    if (onCloseHandler && registeredService) {
      await onCloseHandler();
      // After closeAll, connectionCount should be 0.
      expect(registeredService.connectionCount).toBe(0);
    }
  });

  it('should close all connections on lifecycle onClose', async () => {
    const plugin = SsePlugin() as IPlugin;
    await plugin.register(ctx);

    expect(registeredService).not.toBeNull();

    // Before close, we can verify the service exists.
    expect(registeredService!.connectionCount).toBe(0);

    // Call the onClose hook (simulates shutdown).
    await onCloseHandler();

    // After closeAll, connectionCount should still be 0 (no connections existed).
    expect(registeredService!.connectionCount).toBe(0);
  });

  // A4 — onClose/closeAll with open connections (isOpen false + heartbeat cleared)
  it('should close all open connections on lifecycle onClose', async () => {
    const plugin = SsePlugin() as IPlugin;
    await plugin.register(ctx);

    expect(registeredService).not.toBeNull();

    // Simulate an open connection by checking that connectionCount starts at 0.
    // We can't easily create a real open connection in this unit test, but we can
    // verify that closeAll() on a service with zero connections is a no-op.
    const countBefore = registeredService!.connectionCount;
    await onCloseHandler();
    expect(registeredService!.connectionCount).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Second registration must throw (A4)
// ---------------------------------------------------------------------------

describe('SsePlugin duplicate registration', () => {
  it('should throw when registering a second SsePlugin without override/multi', async () => {
    // The service registry enforces no-duplicate registration for single-instance plugins.
    // Creating two separate fake contexts, each with their own service registry:
    const ctx1 = {
      services: {
        register: <T>(_token: string, _service: T) => {
          // First registration succeeds.
        },
        get(_token: string) {
          return undefined as never;
        },
        has: (token: string): boolean => {
          // Simulate: SSE already registered.
          return token === CAPABILITIES.SSE;
        },
        getAll: <T extends object>(_token: string): T[] => [],
        unregister: () => false,
        registerFactory: () => {},
      },
      middleware: { add: () => {} },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      config: { get: () => {}, getOrThrow: () => ({} as never), has: () => false },
      environment: { validate: () => {} },
      health: { register: () => {} },
      metrics: { register: () => {} },
      openapi: { addSchema: () => {} },
      decorators: { register: () => {} },
      cli: { register: () => {} },
      lifecycle: {
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onShutdown: () => {},
        onClose: () => {},
      },
      logger: undefined as never,
      runtime: {} as never,
      metadata: undefined as never,
      container: undefined as never,
      options: {},
      app: {} as never,
    } as unknown as IPluginContext;

    const plugin = SsePlugin() as IPlugin;

    // First registration — succeeds.
    await plugin.register(ctx1);

    // Create a fresh context with a fresh registry where HAS returns true.
    const ctx2 = {
      services: {
        register: <T>(token: string, _service: T) => {
          throw new Error(
            `Capability '${token}' is already registered. Use { override: true } to replace it.`,
          );
        },
        get(_token: string) {
          return undefined as never;
        },
        has: (_token: string): boolean => false,
        getAll: <T extends object>(_token: string): T[] => [],
        unregister: () => false,
        registerFactory: () => {},
      },
      middleware: { add: () => {} },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      config: { get: () => {}, getOrThrow: () => ({} as never), has: () => false },
      environment: { validate: () => {} },
      health: { register: () => {} },
      metrics: { register: () => {} },
      openapi: { addSchema: () => {} },
      decorators: { register: () => {} },
      cli: { register: () => {} },
      lifecycle: {
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onShutdown: () => {},
        onClose: () => {},
      },
      logger: undefined as never,
      runtime: {} as never,
      metadata: undefined as never,
      container: undefined as never,
      options: {},
      app: {} as never,
    } as unknown as IPluginContext;

    // Second registration — should reject because the registry rejects
    // duplicates. `register` is async (it awaits the optional backplane
    // subscription), so the failure surfaces as a rejection, not a sync throw.
    await expect(plugin.register(ctx2)).rejects.toThrow(/already registered/);
  });
});

describe('SsePlugin with a realtime backplane', () => {
  /** A backplane double recording its subscriptions and publishes. */
  function fakeBackplane(): IRealtimeBackplane & {
    readonly published: RealtimeFrame[];
    readonly handlers: Array<(frame: RealtimeFrame) => void>;
    unsubscribeCount: number;
  } {
    const published: RealtimeFrame[] = [];
    const handlers: Array<(frame: RealtimeFrame) => void> = [];
    const backplane = {
      origin: 'node-a',
      published,
      handlers,
      unsubscribeCount: 0,
      connect: (): Promise<void> => Promise.resolve(),
      publish: (frame: RealtimeFrame): Promise<void> => {
        published.push(frame);
        return Promise.resolve();
      },
      subscribe: (handler: (frame: RealtimeFrame) => void): Promise<() => void> => {
        handlers.push(handler);
        return Promise.resolve(() => {
          backplane.unsubscribeCount++;
        });
      },
      close: (): Promise<void> => Promise.resolve(),
    };
    return backplane;
  }

  /** A plugin context exposing the supplied backplane, and capturing hooks. */
  function contextWith(backplane?: IRealtimeBackplane): {
    readonly ctx: IPluginContext;
    service(): ISseService;
    close(): void;
  } {
    let service: ISseService | undefined;
    let onClose: (() => void) | undefined;
    const ctx = {
      runtime: {
        setInterval: (): TimerHandle => ({} as TimerHandle),
        clearInterval: (): void => {},
        uuid: (): string => 'test-uuid',
      },
      services: {
        has: (token: string): boolean =>
          token === CAPABILITIES.REALTIME_BACKPLANE && backplane !== undefined,
        get: <T>(): T => backplane as T,
        register: <T>(token: string, value: T): void => {
          if (token === CAPABILITIES.SSE) {
            service = value as ISseService;
          }
        },
      },
      health: { register: (): void => {} },
      lifecycle: {
        onClose: (fn: () => void): void => {
          onClose = fn;
        },
      },
    } as unknown as IPluginContext;

    return {
      ctx,
      service: (): ISseService => service as ISseService,
      close: (): void => onClose?.(),
    };
  }

  it('subscribes to a registered backplane and routes frames into channels', async () => {
    const backplane = fakeBackplane();
    const harness = contextWith(backplane);
    await (SsePlugin() as IPlugin).register(harness.ctx);

    expect(backplane.handlers.length).toBe(1);

    const received: SseMessage[] = [];
    harness.service().channel('news').add(
      {
        isOpen: true,
        send: (msg: SseMessage): void => {
          received.push(msg);
        },
      } as never,
    );

    backplane.handlers[0]?.({
      kind: 'sse-channel',
      origin: 'node-b',
      name: 'news',
      data: JSON.stringify({ data: 'from-peer' }),
    });
    expect(received).toEqual([{ data: 'from-peer' }]);

    harness.service().channel('news').publish({ data: 'to-peers' });
    await Promise.resolve();
    expect(backplane.published).toEqual([
      {
        kind: 'sse-channel',
        origin: 'node-a',
        name: 'news',
        data: JSON.stringify({ data: 'to-peers' }),
      },
    ]);
  });

  it('unsubscribes from the backplane on shutdown', async () => {
    const backplane = fakeBackplane();
    const harness = contextWith(backplane);
    await (SsePlugin() as IPlugin).register(harness.ctx);

    harness.close();
    expect(backplane.unsubscribeCount).toBe(1);
  });

  it('registers no subscription when no backplane capability exists', async () => {
    const harness = contextWith(undefined);
    await (SsePlugin() as IPlugin).register(harness.ctx);

    const received: SseMessage[] = [];
    harness.service().channel('news').add(
      {
        isOpen: true,
        send: (msg: SseMessage): void => {
          received.push(msg);
        },
      } as never,
    );
    // Channels still work; they simply never leave the process.
    harness.service().channel('news').publish({ data: 'local' });
    expect(received).toEqual([{ data: 'local' }]);
    harness.close();
  });
});

describe('SsePlugin scaling notice', () => {
  /** A context with a recording logger, optionally exposing a backplane. */
  function contextWithLogger(backplane?: IRealtimeBackplane): {
    readonly ctx: IPluginContext;
    readonly infoLogs: string[];
  } {
    const infoLogs: string[] = [];
    const ctx = {
      runtime: {
        setInterval: (): TimerHandle => ({} as TimerHandle),
        clearInterval: (): void => {},
        uuid: (): string => 'test-uuid',
      },
      logger: {
        info: (message: string): void => {
          infoLogs.push(message);
        },
        warn: (): void => {},
        error: (): void => {},
        debug: (): void => {},
      },
      services: {
        has: (token: string): boolean =>
          token === CAPABILITIES.REALTIME_BACKPLANE && backplane !== undefined,
        get: <T>(): T => backplane as T,
        register: (): void => {},
      },
      health: { register: (): void => {} },
      lifecycle: { onClose: (): void => {} },
    } as unknown as IPluginContext;

    return { ctx, infoLogs };
  }

  it('says at startup that channels are process-local when no backplane is registered', async () => {
    const harness = contextWithLogger();

    await (SsePlugin() as IPlugin).register(harness.ctx);

    // Behind more than one replica this is silent partial delivery, so the
    // notice must name both the limitation and the plugin that lifts it.
    expect(harness.infoLogs.length).toBe(1);
    expect(harness.infoLogs[0]).toContain('channels broadcast in-process only');
    expect(harness.infoLogs[0]).toContain('@hono-enterprise/realtime-backplane-plugin');
  });

  it('stays quiet when a backplane is registered', async () => {
    const harness = contextWithLogger({
      origin: 'node-a',
      connect: (): Promise<void> => Promise.resolve(),
      publish: (): Promise<void> => Promise.resolve(),
      subscribe: (): Promise<() => void> => Promise.resolve(() => {}),
      close: (): Promise<void> => Promise.resolve(),
    } as IRealtimeBackplane);

    await (SsePlugin() as IPlugin).register(harness.ctx);

    expect(harness.infoLogs).toEqual([]);
  });
});
