/**
 * `publishIntegrationEvent` and `causedBy`, driven against a recording
 * `IMessageBroker` stand-in.
 *
 * Load-bearing (verified from source): the publisher never runs
 * `definition.parse` — a definition whose parser throws unconditionally still
 * publishes, and the recorded payload is the caller's object unchanged.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  PublishOptions,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';

import { defineIntegrationEvent } from '../../../src/integration/definition.ts';
import { causedBy, publishIntegrationEvent } from '../../../src/integration/publish.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

const FIXED_MS = 1_700_000_000_000;

/** A stand-in broker that records every `publish` call. */
class RecordingBroker implements IMessageBroker {
  readonly published: { topic: string; message: unknown; options?: PublishOptions }[] = [];
  readonly rejectWith: Error | undefined;

  constructor(opts?: { rejectWith?: Error }) {
    this.rejectWith = opts?.rejectWith;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    if (this.rejectWith !== undefined) return Promise.reject(this.rejectWith);
    this.published.push({ topic, message, ...(options !== undefined ? { options } : {}) });
    return Promise.resolve();
  }

  subscribe<T>(
    _topic: string,
    _handler: MessageHandler<T>,
    _options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  }

  request<TReq, TRes>(
    _topic: string,
    _message: TReq,
    _options?: RequestOptions,
  ): Promise<TRes> {
    return Promise.reject(new Error('request is not exercised by this suite'));
  }

  respond<TReq, TRes>(
    _topic: string,
    _handler: RequestHandler<TReq, TRes>,
    _options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return Promise.reject(new Error('respond is not exercised by this suite'));
  }
}

const definition = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

const runtime = createFakeRuntime({ uuidPrefix: 'pub-uuid', startTimestamp: FIXED_MS });

describe('publishIntegrationEvent', () => {
  it('calls publish exactly once with the definition topic and the §3.3 envelope', async () => {
    const broker = new RecordingBroker();
    const payload = { orderId: 'o-1' };

    await publishIntegrationEvent(runtime, broker, definition, payload);

    expect(broker.published).toHaveLength(1);
    const { topic, message } = broker.published[0];
    expect(topic).toBe('orders.placed.v1');
    expect(message).toEqual({
      id: 'pub-uuid-0',
      type: 'orders.placed',
      version: 1,
      occurredAt: new Date(FIXED_MS).toISOString(),
      data: { orderId: 'o-1' },
    });
  });

  it('carries the causal metadata it is given onto the envelope', async () => {
    const broker = new RecordingBroker();

    await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' }, {
      correlationId: 'root-1',
      causationId: 'e-0',
      aggregateId: 'order-1',
      aggregateVersion: 3,
    });

    const message = broker.published[0].message as Record<string, unknown>;
    expect(message['correlationId']).toBe('root-1');
    expect(message['causationId']).toBe('e-0');
    expect(message['aggregateId']).toBe('order-1');
    expect(message['aggregateVersion']).toBe(3);
  });

  it('omits absent metadata fields rather than writing undefined', async () => {
    const broker = new RecordingBroker();

    await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' }, {
      correlationId: 'root-1',
    });

    const message = broker.published[0].message as Record<string, unknown>;
    expect(message['correlationId']).toBe('root-1');
    expect('causationId' in message).toBe(false);
    expect('aggregateId' in message).toBe(false);
    expect('aggregateVersion' in message).toBe(false);
  });

  it('publishes even when the definition parse throws, with the payload unchanged', async () => {
    // §3.4: `parse` runs on the consumer side only. A coercing parser returns
    // a different object than it was given — running it on publish would
    // silently change what the producer asked to send.
    const neverParse = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (_value) => {
        throw new Error('parse must never run on publish');
      },
    });
    const broker = new RecordingBroker();
    const payload = { orderId: 'o-1' };

    await publishIntegrationEvent(runtime, broker, neverParse, payload);

    expect(broker.published).toHaveLength(1);
    expect((broker.published[0].message as { data: unknown }).data).toBe(payload);
  });

  it('propagates a rejecting publish unchanged', async () => {
    const boom = new Error('transport down');
    const broker = new RecordingBroker({ rejectWith: boom });

    let caught: unknown;
    try {
      await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });

  it('defaults deduplicationId to the envelope id and carries empty headers (M106 §3.7)', async () => {
    const broker = new RecordingBroker();

    await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' });

    const options = broker.published[0].options!;
    const envelope = broker.published[0].message as { id: string };
    expect(options.deduplicationId).toBe(envelope.id);
    expect(options.headers).toEqual({});
    expect('orderingKey' in options).toBe(false);
  });

  it('lets a caller-supplied deduplicationId win over the envelope id', async () => {
    const broker = new RecordingBroker();

    await publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' }, undefined, {
      deduplicationId: 'caller-1',
    });

    expect(broker.published[0].options?.deduplicationId).toBe('caller-1');
  });

  it('applies the definition selector as orderingKey, and the caller wins (M106 §3.7)', async () => {
    const withSelector = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (value) => value as { orderId: string },
      orderingKey: (envelope) => envelope.aggregateId,
    });

    const fromSelector = new RecordingBroker();
    await publishIntegrationEvent(runtime, fromSelector, withSelector, { orderId: 'o-1' }, {
      aggregateId: 'agg-9',
    });
    expect(fromSelector.published[0].options?.orderingKey).toBe('agg-9');

    const callerWins = new RecordingBroker();
    await publishIntegrationEvent(
      runtime,
      callerWins,
      withSelector,
      { orderId: 'o-1' },
      { aggregateId: 'agg-9' },
      { orderingKey: 'caller-key' },
    );
    expect(callerWins.published[0].options?.orderingKey).toBe('caller-key');
  });

  it('treats a selector returning undefined as no key at all', async () => {
    const noKey = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (value) => value as { orderId: string },
      orderingKey: () => undefined,
    });
    const broker = new RecordingBroker();

    await publishIntegrationEvent(runtime, broker, noKey, { orderId: 'o-1' });

    expect('orderingKey' in broker.published[0].options!).toBe(false);
  });

  it('rejects when the selector throws, never synchronously (M106 §3.7)', async () => {
    const throwing = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (value) => value as { orderId: string },
      orderingKey: () => {
        throw new Error('selector boom');
      },
    });
    const broker = new RecordingBroker();

    await expect(publishIntegrationEvent(runtime, broker, throwing, { orderId: 'o-1' })).rejects
      .toThrow('selector boom');
    expect(broker.published).toHaveLength(0);
  });

  it('rejects when the selector returns a value §3.4 refuses (M106 §3.7)', async () => {
    const invalid = defineIntegrationEvent<{ orderId: string }>({
      type: 'orders.placed',
      version: 1,
      topic: 'orders.placed.v1',
      parse: (value) => value as { orderId: string },
      orderingKey: () => 'x'.repeat(129),
    });
    const broker = new RecordingBroker();

    await expect(publishIntegrationEvent(runtime, broker, invalid, { orderId: 'o-1' })).rejects
      .toThrow(RangeError);
    expect(broker.published).toHaveLength(0);
  });

  it('validates the caller options before touching the broker (M106 §3.4)', async () => {
    const broker = new RecordingBroker();

    await expect(
      publishIntegrationEvent(runtime, broker, definition, { orderId: 'o-1' }, undefined, {
        headers: { cc: 'x' },
      }),
    ).rejects.toThrow(RangeError);
    expect(broker.published).toHaveLength(0);
  });
});

describe('causedBy', () => {
  it('derives the chain root from its own id when the envelope has no correlationId', () => {
    const envelope = {
      id: 'e-1',
      type: 'orders.placed',
      version: 1,
      occurredAt: new Date(FIXED_MS).toISOString(),
      data: { orderId: 'o-1' },
    };
    expect(causedBy(envelope)).toEqual({ correlationId: 'e-1', causationId: 'e-1' });
  });

  it('inherits the correlationId and names the consumed event as the direct cause', () => {
    const envelope = {
      id: 'e-2',
      type: 'orders.placed',
      version: 1,
      occurredAt: new Date(FIXED_MS).toISOString(),
      data: { orderId: 'o-1' },
      correlationId: 'root-1',
    };
    expect(causedBy(envelope)).toEqual({ correlationId: 'root-1', causationId: 'e-2' });
  });
});
