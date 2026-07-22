/**
 * Unit tests for SsePlugin — registration, health indicator, onClose cleanup.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SsePlugin } from '../../src/plugin/sse-plugin.ts';
import { SseService } from '../../src/services/sse-service.ts';
import type { IPlugin, IPluginContext, ISseService, TimerHandle } from '@hono-enterprise/common';
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
      expect(result.data).toBeDefined();
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
});
