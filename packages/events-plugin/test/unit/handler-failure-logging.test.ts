/**
 * Unit test: the EventsPlugin's default error handler logs a failed handler's
 * error with its message and stack, not `{}` (plan §3.6, X2-5). A raw `Error`
 * in log metadata renders as `{}` under `JSON.stringify`, so the fix serializes
 * it before logging; this test asserts the serialized `message` reaches the
 * logger.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IDomainEvent,
  IEventBus,
  ILogger,
  IPluginContext,
  TimerHandle,
} from '@setu-ts/common';
import { EventsPlugin } from '../../src/plugin/events-plugin.ts';
import { defineDomainEvent } from '../../src/events/domain-event.ts';

/** A minimal runtime just enough for `defineDomainEvent`. */
function makeRuntime(): Parameters<typeof defineDomainEvent>[0] {
  return {
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
  };
}

describe('EventsPlugin — handler failure logging (X2-5)', () => {
  let ctx: IPluginContext;
  let registeredServices: Map<string, unknown>;
  let errorMeta: Record<string, unknown> | undefined;

  beforeEach(() => {
    registeredServices = new Map();
    errorMeta = undefined;
    const logger: ILogger = {
      level: 'debug',
      fatal: () => {},
      error: (_message: string, meta?: Record<string, unknown>) => {
        errorMeta = meta;
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    registeredServices.set('logger', logger);
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
        onStopping: () => {},
        onShutdown: () => {},
        onClose: () => {},
      },
      logger: undefined as never,
      runtime: makeRuntime() as never,
      metadata: undefined as never,
      container: undefined as never,
      options: {},
      app: {} as unknown as typeof ctx.app,
    };
  });

  it('logs the failing handler message (serialized), not {}', async () => {
    await EventsPlugin().register(ctx);
    const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
    const { DomainEvent } = defineDomainEvent(makeRuntime());
    class TestEvent extends DomainEvent<{ value: string }> {
      readonly type = 'TestEvent';
    }

    bus.subscribe('TestEvent', () => {
      throw new Error('the handler failure message');
    });
    const event: IDomainEvent = new TestEvent({ value: 'x' });
    await bus.publish(event);

    // The error was logged…
    expect(errorMeta).toBeDefined();
    // …with the handler's message serialized, not flattened to {}.
    const error = errorMeta?.error as Record<string, unknown>;
    expect(error).toEqual(
      expect.objectContaining({ name: 'Error', message: 'the handler failure message' }),
    );
    expect(typeof error.stack).toBe('string');
    expect(errorMeta?.eventType).toBe('TestEvent');
    // The whole metadata is JSON-serializable (the X2-5 defect would not be).
    expect(JSON.parse(JSON.stringify(errorMeta)).error.message).toBe('the handler failure message');
  });
});
