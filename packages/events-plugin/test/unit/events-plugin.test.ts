/**
 * Unit tests for EventsPlugin.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { EventsPlugin } from '../../src/plugin/events-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ILogger, IPluginContext, TimerHandle } from '@hono-enterprise/common';

describe('EventsPlugin', () => {
  let ctx: IPluginContext;
  let registeredServices: Map<string, unknown>;
  let healthIndicator: {
    name: string;
    indicator: () => Promise<{ status: string; data?: unknown }>;
  };
  let onCloseHandler: () => Promise<void>;

  beforeEach(() => {
    registeredServices = new Map();
    healthIndicator = {} as unknown as typeof healthIndicator;
    onCloseHandler = async () => {};

    ctx = {
      services: {
        register: <T>(token: string, service: T) => {
          registeredServices.set(token, service);
        },
        get: <T>(token: string): T => registeredServices.get(token) as T,
        has: (token: string): boolean => registeredServices.has(token),
        getAll: <T>(token: string): T[] => {
          const svc = registeredServices.get(token);
          return svc ? [svc as T] : [];
        },
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
        register: (name: string, indicator: () => Promise<{ status: string; data?: unknown }>) => {
          healthIndicator = { name, indicator };
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
        platform: () => 'deno',
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

  it('should have correct name and version', () => {
    const plugin = EventsPlugin();
    expect(plugin.name).toBe('events-plugin');
    expect(plugin.version).toBe('0.1.0');
  });

  it('should declare optionalDependencies: [logger]', () => {
    const plugin = EventsPlugin();
    expect(plugin.optionalDependencies).toEqual(['logger']);
  });

  it('should provide CAPABILITIES.EVENTS', () => {
    const plugin = EventsPlugin();
    expect(plugin.provides).toEqual([CAPABILITIES.EVENTS]);
  });

  it('should register IEventBus under CAPABILITIES.EVENTS', async () => {
    const plugin = EventsPlugin();
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      publish: unknown;
      subscribe: unknown;
      publishBatch: unknown;
    };
    expect(bus).toBeDefined();
    expect(typeof bus.publish).toBe('function');
    expect(typeof bus.subscribe).toBe('function');
    expect(typeof bus.publishBatch).toBe('function');
  });

  it('should register health indicator', async () => {
    const plugin = EventsPlugin();
    await plugin.register(ctx);

    expect(healthIndicator.name).toBe('events');
    const status = await healthIndicator.indicator();
    expect(status.status).toBe('up');
    expect(status.data).toHaveProperty('handlers');
  });

  it('should register onClose handler that clears subscriptions', async () => {
    const plugin = EventsPlugin();
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: unknown;
      subscriptionCount: number;
    };
    (bus as { subscribe: (e: string, h: () => void) => void }).subscribe('TestEvent', () => {});
    expect(bus.subscriptionCount).toBe(1);

    await onCloseHandler();

    expect(bus.subscriptionCount).toBe(0);
  });

  it('should wire async:true option', async () => {
    const plugin = EventsPlugin({ async: true });
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => Promise<void>) => void;
      publish: (e: unknown) => Promise<void>;
      whenIdle: () => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'async-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let completed = false;
    bus.subscribe('TestEvent', async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(completed).toBe(false); // fire-and-forget
    await bus.whenIdle();
    expect(completed).toBe(true);
  });

  it('should wire errorHandler option', async () => {
    let errorReceived: unknown = null;
    const plugin = EventsPlugin({
      errorHandler: (err) => {
        errorReceived = err;
      },
    });
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => void) => void;
      publish: (e: unknown) => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'err-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {
      throw new Error('handler error');
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(errorReceived).toBeInstanceOf(Error);
    expect((errorReceived as Error).message).toBe('handler error');
  });

  it('should wire async:false option explicitly', async () => {
    const plugin = EventsPlugin({ async: false });
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => Promise<void>) => void;
      publish: (e: unknown) => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'sync-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    let completed = false;
    bus.subscribe('TestEvent', async () => {
      await new Promise((r) => setTimeout(r, 50));
      completed = true;
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(completed).toBe(true); // synchronous, should complete
  });

  it('should resolve optional logger when present', async () => {
    let loggerResolved = false;
    const fakeLogger: ILogger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {
        loggerResolved = true;
      },
      fatal: () => {},
      trace: () => {},
      child: () => fakeLogger,
    };
    registeredServices.set('logger', fakeLogger);

    const plugin = EventsPlugin();
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => void) => void;
      publish: (e: unknown) => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'log-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {
      throw new Error('fail');
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    expect(loggerResolved).toBe(true);
  });

  it('should use default errorHandler without crashing when logger is absent', async () => {
    // Ensure logger is NOT in the services registry.
    registeredServices.delete('logger');

    const plugin = EventsPlugin();
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => void) => void;
      publish: (e: unknown) => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'no-logger-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    // This should NOT throw even though handler fails and there's no logger.
    bus.subscribe('TestEvent', () => {
      throw new Error('handler fails');
    });

    const event = new TestEvent({ value: 'test' });
    await expect(bus.publish(event)).resolves.toBeUndefined();
  });

  it('should use default errorHandler with logger when no custom errorHandler provided', async () => {
    // Add logger to services.
    let errorLogged = false;
    const fakeLogger: ILogger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {
        errorLogged = true;
      },
      fatal: () => {},
      trace: () => {},
      child: () => fakeLogger,
    };
    registeredServices.set('logger', fakeLogger);

    const plugin = EventsPlugin(); // No custom errorHandler
    await plugin.register(ctx);

    const bus = ctx.services.get(CAPABILITIES.EVENTS) as {
      subscribe: (e: string, h: () => void) => void;
      publish: (e: unknown) => Promise<void>;
    };
    const { defineDomainEvent } = await import('../../src/events/domain-event.ts');
    const runtime = {
      platform: () => 'deno' as const,
      version: () => 'test',
      now: () => Date.now(),
      hrtime: () => 0,
      setTimeout: (fn: () => void) => ({ id: setTimeout(fn, 0) }) as TimerHandle,
      clearTimeout: (h: TimerHandle) => clearTimeout((h as { id: number }).id),
      setInterval: (fn: () => void) => ({ id: setInterval(fn, 1000) }) as TimerHandle,
      clearInterval: (h: TimerHandle) => clearInterval((h as { id: number }).id),
      uuid: () => 'default-logger-uuid',
      randomBytes: (n: number) => new Uint8Array(n),
      subtle: {} as SubtleCrypto,
      env: {},
      exit: () => {
        throw new Error('exit');
      },
      hostname: () => 'localhost',
    };
    const { DomainEvent } = defineDomainEvent(runtime);

    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {
      throw new Error('handler fails');
    });

    const event = new TestEvent({ value: 'test' });
    await bus.publish(event);

    // Default errorHandler should have logged via the logger.
    expect(errorLogged).toBe(true);
  });
});
