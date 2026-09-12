/**
 * Integration-event contracts end to end through a REAL `createApplication`
 * with `RuntimePlugin` + `MessagingPlugin` and the default in-memory broker.
 *
 * Deliberately the default composition: case (c) proves the parse-rejection
 * diagnostic reaches an operator through the plugin's OWN dispatch reporter
 * (a recording `ILogger` provided by `createMockPlugin` — `onDispatchError`
 * is plugin-owned and not exposed as an option), and every absence assertion
 * is paired in the same suite with a positive delivery on the same definition
 * so a silently-failed subscription cannot pass vacuously.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  ILogger,
  IMessageBroker,
  IngressContext,
  IRuntimeServices,
  IServiceRegistry,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createMockPlugin } from '@setu-ts/testing';

import {
  causedBy,
  defineIntegrationEvent,
  MessagingPlugin,
  onIntegrationEvent,
  publishIntegrationEvent,
} from '../../src/index.ts';
import type { IntegrationEventEnvelope, SubscriptionDefinition } from '../../src/index.ts';

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Settles asynchronous dispatch work before asserting an absence. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
}

/** A recording `ILogger` honoring the real contract, for the plugin's reporter. */
function recordingLogger(): { logger: ILogger; errors: string[] } {
  const errors: string[] = [];
  const logger: ILogger = {
    level: 'info',
    fatal: () => {},
    error: (message) => errors.push(message),
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return { logger, errors };
}

const orderPlacedV1 = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'test.orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

const orderPlacedV2 = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 2,
  topic: 'test.orders.placed.v2',
  parse: (value) => value as { orderId: string },
});

const orderCharged = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.charged',
  version: 1,
  topic: 'test.orders.charged.v1',
  parse: (value) => value as { orderId: string },
});

/** A parser that counts its invocations — the short-circuit observable. */
function countingParse<T>(calls: { count: number }) {
  return (value: unknown): T => {
    calls.count++;
    return value as T;
  };
}

describe('integration events through the real plugin', () => {
  it('delivers one published event to each of two independent consumer groups once', async () => {
    const groupA: string[] = [];
    const groupB: string[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          subscriptions: [
            onIntegrationEvent(
              orderPlacedV1,
              (payload) => {
                groupA.push(payload.orderId);
              },
              { queue: 'billing' },
            ),
            onIntegrationEvent(
              orderPlacedV1,
              (payload) => {
                groupB.push(payload.orderId);
              },
              { queue: 'analytics' },
            ),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      await publishIntegrationEvent(runtime, broker, orderPlacedV1, { orderId: 'o-1' });

      await waitFor(() => groupA.length === 1 && groupB.length === 1, 'both consumer groups');
      await settle();
      // Delivery is COUNTED, not asserted as a happened/not-happened boolean:
      // a double delivery must fail here too.
      expect(groupA).toEqual(['o-1']);
      expect(groupB).toEqual(['o-1']);
    } finally {
      await app.stop();
    }
  });

  it('propagates the causal chain through causedBy when a handler publishes the next event', async () => {
    let deps: { runtime: IRuntimeServices; broker: IMessageBroker } | undefined;
    let rootEnvelopeId = '';
    const charged: IntegrationEventEnvelope<{ orderId: string }>[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          subscriptions: [
            onIntegrationEvent(orderPlacedV1, (_payload, envelope) => {
              rootEnvelopeId = envelope.id;
              const d = deps!;
              return publishIntegrationEvent(
                d.runtime,
                d.broker,
                orderCharged,
                { orderId: envelope.data.orderId },
                causedBy(envelope),
              );
            }),
            onIntegrationEvent(orderCharged, (_payload, envelope) => {
              charged.push(envelope);
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      deps = {
        runtime: app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
        broker: app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING),
      };
      // The producer publishes a chain ROOT: no correlationId of its own.
      await publishIntegrationEvent(deps.runtime, deps.broker, orderPlacedV1, { orderId: 'o-1' });

      await waitFor(() => charged.length === 1, 'the charged event');
      expect(charged[0].causationId).toBe(rootEnvelopeId);
      // The `?? envelope.id` chain-root rule: a root's own id IS the chain id.
      expect(charged[0].correlationId).toBe(rootEnvelopeId);
    } finally {
      await app.stop();
    }
  });

  it('reports a parse rejection through the default composition, and publish still resolves', async () => {
    const parseCalls = { count: 0 };
    let handlerCalls = 0;
    const failing = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'test.orders.placed.v1',
      parse: (): { orderId: string } => {
        parseCalls.count++;
        throw new Error('orderId: expected string');
      },
    });
    const { logger, errors } = recordingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        // PROVIDES `logger` for an application that registers no LoggerPlugin
        // (the §6.4 seam) — the plugin's reporter reads it at call time.
        createMockPlugin({ name: 'logger', service: logger }),
        MessagingPlugin({
          subscriptions: [
            onIntegrationEvent(failing, () => {
              handlerCalls++;
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      // In-memory semantics (verified from source): publish resolves on
      // dispatch hand-off and NEVER rejects for a handler failure. If this
      // await rejected, the default composition would be lying. The payload
      // is deliberately a shape `parse` rejects — §3.4: the publisher does
      // not run `parse`, so a producer CAN publish a payload its own
      // consumers reject, and that surfaces at the consumer.
      const rejectedPayload = { orderId: 42 } as unknown as { orderId: string };
      await publishIntegrationEvent(runtime, broker, failing, rejectedPayload);

      await waitFor(() => errors.length > 0, 'the dispatch report');
      expect(handlerCalls).toBe(0);
      expect(parseCalls.count).toBe(1);
      // The logged string is `error.message` flattened — it must name the
      // topic and the parse failure on its own.
      expect(errors[0]).toContain('test.orders.placed.v1');
      expect(errors[0]).toContain('reason: parse');
      expect(errors[0]).toContain('the parse function rejected the payload');
    } finally {
      await app.stop();
    }
  });

  it('delivers nothing to a v1 consumer when only v2 is published, and both during a dual-publish', async () => {
    let v1 = 0;
    let v2 = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          subscriptions: [
            onIntegrationEvent(orderPlacedV1, () => {
              v1++;
            }),
            onIntegrationEvent(orderPlacedV2, () => {
              v2++;
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

      // Rollover step 1: publish v2 only — the v1 consumer sees nothing.
      await publishIntegrationEvent(runtime, broker, orderPlacedV2, { orderId: 'o-2' });
      await waitFor(() => v2 === 1, 'the v2 delivery');
      await settle();
      expect(v1).toBe(0);

      // Rollover step 2: the dual-publish window delivers to BOTH versions.
      await publishIntegrationEvent(runtime, broker, orderPlacedV1, { orderId: 'o-1' });
      await waitFor(() => v1 === 1, 'the v1 delivery');
      await settle();
      expect(v1).toBe(1);
      expect(v2).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('registers and delivers through the RegistryFactory subscription entry', async () => {
    let received = '';
    let observedAt = 0;
    // The factory arm is how a handler needing a resolved capability is
    // written — here the runtime, resolved at `onInit` like any
    // `RegistryFactory<SubscriptionDefinition>` entry.
    const factory: RegistryFactory<SubscriptionDefinition> = (services: IServiceRegistry) => {
      const runtime = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return onIntegrationEvent(orderPlacedV1, (payload) => {
        received = payload.orderId;
        observedAt = runtime.now();
      });
    };
    const app = createApplication({
      plugins: [RuntimePlugin(), MessagingPlugin({ subscriptions: [factory] })],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      await publishIntegrationEvent(runtime, broker, orderPlacedV1, { orderId: 'o-1' });
      await waitFor(() => received !== '', 'the factory-registered delivery');
      // The resolved capability was genuinely in the handler's scope: the
      // delivered payload arrived, stamped with a runtime clock reading.
      expect(received).toBe('o-1');
      expect(observedAt).toBeGreaterThan(0);
    } finally {
      await app.stop();
    }
  });

  it('lets an ingress behaviour observe the raw envelope before the wrapper runs', async () => {
    const parseCalls = { count: 0 };
    let handled = 0;
    const counting = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'test.orders.placed.v1',
      parse: countingParse(parseCalls),
    });
    const observed: IngressContext[] = [];
    const recorder: IIngressBehavior = {
      handle: (ctx, next) => {
        observed.push(ctx);
        return next();
      },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          behaviors: [recorder],
          subscriptions: [
            onIntegrationEvent(counting, () => {
              handled++;
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      await publishIntegrationEvent(runtime, broker, counting, { orderId: 'o-9' });

      await waitFor(() => handled === 1, 'the observed delivery');
      // The chain runs BEFORE the helper's wrapper: the behaviour's payload is
      // the raw envelope, never the parsed payload — documented, not changed.
      expect(observed).toHaveLength(1);
      expect(observed[0].kind).toBe('messaging');
      expect(observed[0].name).toBe('test.orders.placed.v1');
      const raw = observed[0].payload as Record<string, unknown>;
      expect(raw['type']).toBe('orders.placed');
      expect(typeof raw['id']).toBe('string');
      expect(raw['data']).toEqual({ orderId: 'o-9' });
      expect(parseCalls.count).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('a short-circuiting behaviour prevents both the parse and the handler', async () => {
    const parseCalls = { count: 0 };
    let handled = 0;
    const counting = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'test.orders.placed.v1',
      parse: countingParse(parseCalls),
    });
    const guard: IIngressBehavior = {
      handle: () => {}, // returns WITHOUT next(): the chain short-circuits
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          behaviors: [guard],
          subscriptions: [
            onIntegrationEvent(counting, () => {
              handled++;
            }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      await publishIntegrationEvent(runtime, broker, counting, { orderId: 'o-9' });
      await settle();
      // Absence paired with the positive case above, same wiring minus the
      // guard, so a silently-unregistered subscription cannot pass this.
      expect(handled).toBe(0);
      expect(parseCalls.count).toBe(0);
    } finally {
      await app.stop();
    }
  });
});
