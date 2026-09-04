/**
 * The M89c dispatch-timing contract (plan §3.1/§3.1b).
 *
 * `InMemoryBroker.publish` resolves once every matching subscription's work
 * item has been HANDED TO dispatch — never once every handler has returned —
 * and every invoked handler's promise is RETAINED: a rejection is routed to
 * the configured `onDispatchError` (or observed and dropped when absent), so
 * it can never surface as an unhandled rejection and can no longer delay or
 * abort delivery to its siblings. `publishWithHeaders` (the framework header
 * path) behaves identically.
 *
 * The second rejection case asserts the promise the subscription callback
 * RETURNS is the one whose rejection is observed, so a refactor that drops
 * the retained promise fails here rather than in production.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, IPluginContext, MessageMetadata } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { InMemoryBrokerOptions } from '../../src/index.ts';

/** Flushes the microtask queue (and short timers) so retained rejections land. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Tracks `unhandledrejection` — the only assertion that catches this failure mode. */
class UnhandledRejectionProbe {
  readonly events: unknown[] = [];
  #listener = (event: PromiseRejectionEvent): void => {
    this.events.push(event.reason);
  };

  start(): void {
    globalThis.addEventListener('unhandledrejection', this.#listener);
  }

  stop(): void {
    globalThis.removeEventListener('unhandledrejection', this.#listener);
  }
}

describe('InMemoryBroker publish resolves on dispatch hand-off (M89c §3.1)', () => {
  it('resolves before a slow handler completes, and the handler still runs', async () => {
    const broker: IMessageBroker = new InMemoryBroker(
      createFakeRuntime(),
      new JsonSerializer(),
    );
    await broker.connect();

    let handlerStarted = false;
    let handlerFinished = false;
    const { promise: completion, resolve: complete } = Promise.withResolvers<void>();

    await broker.subscribe('orders', () => {
      handlerStarted = true;
      return completion.then(() => {
        handlerFinished = true;
      });
    });

    await broker.publish('orders', { id: 1 });

    // The hand-off already happened; the handler is in flight, not finished.
    expect(handlerStarted).toBe(true);
    expect(handlerFinished).toBe(false);

    complete();
    await settle();
    expect(handlerFinished).toBe(true);

    await broker.disconnect();
  });

  it('publishWithHeaders (the framework header path) behaves identically', async () => {
    const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    await broker.connect();

    let handlerStarted = false;
    const { promise: completion, resolve: complete } = Promise.withResolvers<void>();

    await broker.subscribe('orders', () => {
      handlerStarted = true;
      return completion;
    });

    await broker.publishWithHeaders('orders', { id: 1 }, { 'x-trace': 'a' });

    expect(handlerStarted).toBe(true);

    complete();
    await settle();
    await broker.disconnect();
  });

  it('one slow handler no longer delays its siblings — all are invoked for one publish', async () => {
    const broker: IMessageBroker = new InMemoryBroker(
      createFakeRuntime(),
      new JsonSerializer(),
    );
    await broker.connect();

    const received: string[] = [];
    const { promise: slow, resolve: releaseSlow } = Promise.withResolvers<void>();

    await broker.subscribe('fanout', () => slow);
    await broker.subscribe('fanout', (message) => {
      received.push(`sibling:${String(message)}`);
    });

    await broker.publish('fanout', 'm');

    // The sibling was handed the SAME message without waiting on the slow
    // handler — the pre-M89c sequential await aborted this ordering.
    expect(received).toEqual(['sibling:m']);

    releaseSlow();
    await settle();
    await broker.disconnect();
  });

  it('resolves when there are no subscribers', async () => {
    const broker: IMessageBroker = new InMemoryBroker(
      createFakeRuntime(),
      new JsonSerializer(),
    );
    await broker.connect();
    await expect(broker.publish('nobody.listening', { v: 1 })).resolves.toBeUndefined();
    await broker.disconnect();
  });
});

describe('a rejected handler reaches onDispatchError and never the publish (M89c §3.1b)', () => {
  it('routes a synchronous throw to onDispatchError; publish still resolves; no unhandled rejection', async () => {
    const probe = new UnhandledRejectionProbe();
    probe.start();
    try {
      const reported: { error: unknown; metadata: MessageMetadata }[] = [];
      const options: InMemoryBrokerOptions = {
        onDispatchError: (error, metadata) => {
          reported.push({ error, metadata });
        },
      };
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer(), options);
      await broker.connect();

      const received: string[] = [];
      await broker.subscribe('t', () => {
        throw new Error('sync boom');
      });
      await broker.subscribe('t', (message) => {
        received.push(`sibling:${String(message)}`);
      });

      await expect(broker.publish('t', 'm')).resolves.toBeUndefined();
      await settle();

      expect(reported).toHaveLength(1);
      expect((reported[0]?.error as Error).message).toBe('sync boom');
      expect(reported[0]?.metadata.topic).toBe('t');
      expect(reported[0]?.metadata.messageId).toBeDefined();
      // The sibling still received the message.
      expect(received).toEqual(['sibling:m']);
      expect(probe.events).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  it('routes a rejected-promise handler to onDispatchError; no unhandled rejection', async () => {
    const probe = new UnhandledRejectionProbe();
    probe.start();
    try {
      const reported: unknown[] = [];
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer(), {
        onDispatchError: (error) => {
          reported.push(error);
        },
      });
      await broker.connect();

      await broker.subscribe('t', () => Promise.reject(new Error('async boom')));

      await expect(broker.publish('t', 'm')).resolves.toBeUndefined();
      await settle();

      expect((reported[0] as Error).message).toBe('async boom');
      expect(probe.events).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  it('observes and drops a rejection when no reporter is configured — never unhandled', async () => {
    const probe = new UnhandledRejectionProbe();
    probe.start();
    try {
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
      await broker.connect();

      await broker.subscribe('t', () => {
        throw new Error('dropped boom');
      });

      // Publish resolves; the rejection is observed and settled internally.
      await expect(broker.publish('t', 'm')).resolves.toBeUndefined();
      await settle();
      expect(probe.events).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  it('the RETAINED promise is the one whose rejection is observed (drop-refactor guard)', async () => {
    const probe = new UnhandledRejectionProbe();
    probe.start();
    try {
      const reported: unknown[] = [];
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer(), {
        onDispatchError: (error) => {
          reported.push(error);
        },
      });
      await broker.connect();

      const marker = new Error('identity boom');
      await broker.subscribe('t', () => Promise.reject(marker));

      await broker.publish('t', 'm');
      await settle();

      // The EXACT error from the promise the handler returned — proof the
      // broker retained that promise rather than constructing its own.
      expect(reported).toEqual([marker]);
      expect(probe.events).toEqual([]);
    } finally {
      probe.stop();
    }
  });
});

describe('MessagingPlugin supplies the in-memory failure reporter (M89c §3.1b)', () => {
  it('reports a rejected handler through the logger, read at CALL time', async () => {
    // The registered map is LIVE: the plugin registered with NO logger (so a
    // logger captured at register() would be undefined), and the logger is
    // added only before the publish. Reading at call time is the M52b lesson.
    const registered = new Map<string, unknown>();
    const errors: string[] = [];
    const harness = {
      runtime: createFakeRuntime(),
      services: {
        has: (token: string): boolean => registered.has(token),
        get: <T>(token: string): T => registered.get(token) as T,
        register: <T>(token: string, value: T): void => {
          registered.set(token, value);
        },
      },
      health: { register: (_n: string, _c: () => Promise<unknown>): void => {} },
      lifecycle: {
        onClose: (_h: () => void | Promise<void>): void => {},
        onInit: (_h: () => void | Promise<void>): void => {},
      },
    } as unknown as IPluginContext;

    const plugin = MessagingPlugin({
      broker: 'memory',
      subscriptions: [
        {
          topic: 'orders',
          handler: () => {
            throw new Error('reported boom');
          },
        },
      ],
    });
    await plugin.register(harness);

    // The logger arrives AFTER register() — the report must still see it.
    registered.set('logger', {
      error: (msg: string): void => {
        errors.push(msg);
      },
    });

    const broker = registered.get(CAPABILITIES.MESSAGING) as {
      publish: (topic: string, message: unknown) => Promise<void>;
    };
    await broker.publish('orders', { id: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('orders');
    expect(errors[0]).toContain('reported boom');
  });
});
