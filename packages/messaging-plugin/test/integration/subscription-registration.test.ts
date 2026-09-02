/**
 * Subscription registration arms (M86 §3.5/§6 rows 16–17) —
 * `MessagingPlugin({ subscriptions })` and `MessagingPlugin({ behaviors })`,
 * each accepting instances or `RegistryFactory` entries, split once at
 * construction with factories resolved in an ASYNC `onInit` so each declared
 * subscription is established before the application serves.
 *
 * The arms live on the SHARED `MessagingCommonOptions`, so every
 * `MessagingPluginOptions` union arm inherits them — asserted here at compile
 * time with one annotated literal per arm. Driven through a REAL
 * `InMemoryBroker` (no real backend, §6.7).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IIngressBehavior,
  IMessageBroker,
  IngressContext,
  IPluginContext,
  IServiceRegistry,
  ISubscription,
  MessageHandler,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
// Declared against the BARREL, not the interfaces module: dropping the export
// from `src/index.ts` must fail this file's type-check (the M56 defect class).
// Declared against the BARREL where the barrel exports the type; the
// pubsub/servicebus VARIANT interfaces are exported from the interfaces
// module only (the barrel exports their union aliases).
import type {
  CustomMessagingOptions,
  KafkaMessagingOptions,
  MemoryMessagingOptions,
  MessagingPluginOptions,
  NatsMessagingOptions,
  RabbitMqMessagingOptions,
  RedisStreamsMessagingOptions,
  SubscriptionDefinition,
} from '../../src/index.ts';
import type {
  PubSubMessagingOptionsInjected,
  PubSubMessagingOptionsProduction,
  ServiceBusMessagingOptionsInjected,
  ServiceBusMessagingOptionsProduction,
} from '../../src/interfaces/index.ts';

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  /** The `onInit` hooks the plugin registered, in registration order. */
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(): Harness {
  const registered = new Map<string, unknown>();
  const initHooks: (() => void | Promise<void>)[] = [];

  const ctx = {
    runtime: createFakeRuntime(),
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        const found = registered.get(token);
        if (found === undefined) {
          throw new Error(`no service for ${token}`);
        }
        return found as T;
      },
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (_name: string, _check: () => Promise<HealthCheckResult>): void => {},
    },
    lifecycle: {
      onClose: (_hook: () => void | Promise<void>): void => {},
      onInit: (hook: () => void | Promise<void>): void => {
        initHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, initHooks };
}

async function boot(options: MessagingPluginOptions): Promise<{
  harness: Harness;
  broker: IMessageBroker;
}> {
  const harness = createHarness();
  const plugin = MessagingPlugin(options);
  await plugin.register(harness.ctx);
  const broker = harness.registered.get(CAPABILITIES.MESSAGING);
  if (broker === undefined) {
    throw new Error('plugin did not register the broker');
  }
  return { harness, broker: broker as IMessageBroker };
}

/** Runs the plugin's `onInit` hooks, as the kernel does during `start()`. */
async function runInitHooks(harness: Harness): Promise<void> {
  for (const hook of harness.initHooks) {
    await hook();
  }
}

/** A factory that throws — the entry a mixed array must attribute by index. */
function subscriptionFactoryThatThrows(_services: IServiceRegistry): SubscriptionDefinition {
  throw new Error('registry exploded');
}

/** A behavior factory that throws, for the behaviors-arm label assertion. */
function behaviorFactoryThatThrows(_services: IServiceRegistry): IIngressBehavior {
  throw new Error('behavior exploded');
}

/** A pass-through recorder behaviour. */
function recorder(log: string[], label: string): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      return next();
    },
  };
}

describe('MessagingCommonOptions arms are inherited by every MessagingPluginOptions union arm', () => {
  it('accepts subscriptions and behaviors on each of the eight union arms (compile-time)', () => {
    const definition: SubscriptionDefinition = { topic: 'orders', handler: () => {} };
    const behavior: IIngressBehavior = { handle: (_ctx, next) => next() };

    // One annotated literal per concrete interface — a missing inheritance
    // would be a TS2353 compile error in THIS file.
    const memory: MemoryMessagingOptions = { subscriptions: [definition], behaviors: [behavior] };
    const redis: RedisStreamsMessagingOptions = {
      broker: 'redis-streams',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const rabbit: RabbitMqMessagingOptions = {
      broker: 'rabbitmq',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const nats: NatsMessagingOptions = {
      broker: 'nats',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const kafka: KafkaMessagingOptions = {
      broker: 'kafka',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const pubsubInjected: PubSubMessagingOptionsInjected = {
      broker: 'pubsub',
      client: undefined as unknown as PubSubMessagingOptionsInjected['client'],
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const pubsubProduction: PubSubMessagingOptionsProduction = {
      broker: 'pubsub',
      projectId: 'test',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const serviceBusInjected: ServiceBusMessagingOptionsInjected = {
      broker: 'service-bus',
      client: undefined as unknown as ServiceBusMessagingOptionsInjected['client'],
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const serviceBusProduction: ServiceBusMessagingOptionsProduction = {
      broker: 'service-bus',
      connectionString: 'Endpoint=sb://test',
      subscriptions: [definition],
      behaviors: [behavior],
    };
    const custom: CustomMessagingOptions = {
      broker: 'custom',
      instance: undefined as unknown as CustomMessagingOptions['instance'],
      subscriptions: [definition],
      behaviors: [behavior],
    };

    for (
      const arm of [
        memory,
        redis,
        rabbit,
        nats,
        kafka,
        pubsubInjected,
        pubsubProduction,
        serviceBusInjected,
        serviceBusProduction,
        custom,
      ]
    ) {
      expect(arm.subscriptions).toEqual([definition]);
      expect(arm.behaviors).toEqual([behavior]);
    }
  });
});

describe('MessagingPlugin({ subscriptions }) registration arms', () => {
  it('registers an instance entry at register() timing, with no onInit hook', async () => {
    const received: unknown[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      subscriptions: [
        {
          topic: 'orders',
          handler: (message) => {
            received.push(message);
          },
        },
      ],
    });

    // Instance timing: no init hook was registered at all.
    expect(harness.initHooks).toHaveLength(0);

    // A message published after start() reaches the arm-registered handler.
    await broker.publish('orders', { orderId: 1 });
    expect(received).toEqual([{ orderId: 1 }]);
  });

  it('resolves a RegistryFactory entry in onInit, before the app serves', async () => {
    const received: unknown[] = [];
    const factory: RegistryFactory<SubscriptionDefinition> = (services) => {
      // A factory builds its handler from a resolved capability.
      void services;
      return {
        topic: 'factory-topic',
        handler: (message) => {
          received.push(message);
        },
      };
    };
    const { harness, broker } = await boot({ broker: 'memory', subscriptions: [factory] });

    // Before onInit the factory has not run: no subscription exists yet.
    await broker.publish('factory-topic', { n: 1 });
    expect(received).toEqual([]);

    await runInitHooks(harness);
    await broker.publish('factory-topic', { n: 2 });
    expect(received).toEqual([{ n: 2 }]);
  });

  it('registers instance and factory entries alongside an imperative subscribe()', async () => {
    const received: string[] = [];
    const record = (message: unknown): void => {
      received.push((message as { id: string }).id);
    };
    const { harness, broker } = await boot({
      broker: 'memory',
      subscriptions: [
        { topic: 'instance-topic', handler: record },
        (_services): SubscriptionDefinition => ({ topic: 'factory-topic', handler: record }),
      ],
    });
    await runInitHooks(harness);
    await broker.subscribe('manual-topic', record);

    await broker.publish('instance-topic', { id: 'instance' });
    await broker.publish('factory-topic', { id: 'factory' });
    await broker.publish('manual-topic', { id: 'manual' });

    expect(received.sort()).toEqual(['factory', 'instance', 'manual']);
  });

  it('rejects onInit naming the DECLARED index when a mixed subscriptions array has a throwing factory', async () => {
    const delivered: string[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      subscriptions: [
        {
          topic: 'orders',
          handler: (message: unknown) => {
            delivered.push((message as { id: string }).id);
          },
        },
        subscriptionFactoryThatThrows,
      ],
    });

    // Index 0 is an instance and registered before the failure.
    await broker.publish('orders', { id: 'instance' });
    expect(delivered).toEqual(['instance']);

    // The label names index 1 — the DECLARED position, not the 0th factory.
    await expect(runInitHooks(harness)).rejects.toThrow('MessagingPlugin({ subscriptions })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('registry exploded');
  });
});

describe('MessagingPlugin({ behaviors }) registration arms', () => {
  it('rejects onInit naming the DECLARED index when a mixed behaviors array has a throwing factory', async () => {
    const { harness } = await boot({
      broker: 'memory',
      behaviors: [recorder([], 'instance'), behaviorFactoryThatThrows],
    });

    await expect(runInitHooks(harness)).rejects.toThrow('MessagingPlugin({ behaviors })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('behavior exploded');
  });

  it('a backlog message cannot reach the handler through a PARTIAL chain', async () => {
    // A subscription goes live the instant it is established against the
    // already-connected broker, and a broker holding a backlog delivers
    // immediately — so with the instance subscriptions registered in
    // `register()` and the factory behaviours resolved later in `onInit`, a
    // backlog message reached the handler having run only the INSTANCE
    // behaviours. Probed before the fix: the handler ran and the factory
    // behaviour never did. Reverting the deferral reproduces exactly that.
    const seenBy: string[] = [];
    const handled: string[] = [];

    /** A broker with queued work: replays one message the moment a consumer attaches. */
    class BacklogBroker implements IMessageBroker {
      connect(): Promise<void> {
        return Promise.resolve();
      }
      disconnect(): Promise<void> {
        return Promise.resolve();
      }
      publish<T>(_topic: string, _message: T): Promise<void> {
        return Promise.resolve();
      }
      subscribe<T>(topic: string, handler: MessageHandler<T>): Promise<ISubscription> {
        void handler(
          { id: 'backlog-1' } as T,
          { topic, timestamp: new Date(0), headers: {} },
        );
        return Promise.resolve({ unsubscribe: (): Promise<void> => Promise.resolve() });
      }
      request<TRes>(): Promise<TRes> {
        return Promise.reject(new Error('no rpc'));
      }
      respond(): Promise<ISubscription> {
        return Promise.resolve({ unsubscribe: (): Promise<void> => Promise.resolve() });
      }
    }

    const { harness } = await boot({
      broker: 'custom',
      instance: new BacklogBroker(),
      behaviors: [
        recorder(seenBy, 'instance'),
        (): IIngressBehavior => recorder(seenBy, 'factory'),
      ],
      subscriptions: [
        {
          topic: 'orders',
          handler: (): void => {
            handled.push('handler');
          },
        },
      ],
    });

    // Nothing may have been delivered yet: the subscription must not go live
    // until the chain is final.
    expect(handled).toEqual([]);

    await runInitHooks(harness);

    expect(handled).toEqual(['handler']);
    expect(seenBy).toEqual(['instance', 'factory']);
  });

  it('wraps arm-registered subscriptions in the chain, in declared order', async () => {
    const log: string[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      behaviors: [recorder(log, 'first'), recorder(log, 'second')],
      subscriptions: [
        {
          topic: 'orders',
          handler: () => {
            log.push('handler');
          },
        },
      ],
    });
    await runInitHooks(harness);

    await broker.publish('orders', { n: 1 });

    expect(log).toEqual(['first', 'second', 'handler']);
  });

  it('preserves declared behavior order when a factory precedes an instance', async () => {
    const log: string[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      behaviors: [
        (_services): IIngressBehavior => recorder(log, 'factory'),
        recorder(log, 'instance'),
      ],
      subscriptions: [
        {
          topic: 'orders',
          handler: () => {
            log.push('handler');
          },
        },
      ],
    });
    await runInitHooks(harness);

    await broker.publish('orders', { n: 1 });

    expect(log).toEqual(['factory', 'instance', 'handler']);
  });

  it('a behaviour short-circuit prevents the arm-registered handler from running', async () => {
    const log: string[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      behaviors: [
        {
          handle: (_ctx, _next) => {
            log.push('short-circuit');
          },
        },
      ],
      subscriptions: [
        {
          topic: 'orders',
          handler: () => {
            log.push('handler');
          },
        },
      ],
    });
    await runInitHooks(harness);

    await broker.publish('orders', { n: 1 });

    expect(log).toEqual(['short-circuit']);
  });

  it('behaviours observe the messaging envelope through the real broker', async () => {
    const envelopes: IngressContext[] = [];
    const { harness, broker } = await boot({
      broker: 'memory',
      behaviors: [
        {
          handle: (ctx, next) => {
            envelopes.push(ctx);
            return next();
          },
        },
      ],
      subscriptions: [{ topic: 'orders', handler: () => {} }],
    });
    await runInitHooks(harness);

    await broker.publish('orders', { n: 1 });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe('messaging');
    expect(envelopes[0]?.name).toBe('orders');
    expect(envelopes[0]?.payload).toEqual({ n: 1 });
    // The in-memory transport always carries a (possibly empty) header record.
    expect(envelopes[0]?.headers).toEqual({});
    expect('attempt' in (envelopes[0] as object)).toBe(false);
  });
});
