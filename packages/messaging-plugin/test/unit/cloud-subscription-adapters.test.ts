import { describe, expect, it, vi } from 'vitest';
import { adaptPubSubModule, type PubSubSdkModule } from '../../src/brokers/pubsub-broker.ts';
import {
  adaptServiceBusModule,
  type ServiceBusSdkModule,
  type IServiceBusReceiver,
} from '../../src/brokers/service-bus-broker.ts';
import { SubscriptionNameExistsError } from '../../src/brokers/fan-out.ts';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';

function pubSubSdk() {
  type Client = InstanceType<PubSubSdkModule['PubSub']>;
  type Metadata = Awaited<ReturnType<ReturnType<Client['subscription']>['getMetadata']>>[0];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emit = (event: string, value?: unknown): void => {
    for (const handler of listeners.get(event) ?? []) handler(value);
  };
  const create = vi.fn(() => Promise.resolve([{}]));
  const exists = vi.fn(() => Promise.resolve<[boolean]>([true]));
  const list = vi.fn(() => Promise.resolve<[unknown[]]>([[]]));
  const metadata = vi.fn(() =>
    Promise.resolve<[Metadata]>([{ topic: 'projects/p/topics/orders' }]),
  );
  const close = vi.fn(() => {
    emit('close');
    return Promise.resolve();
  });
  const sdk: PubSubSdkModule = {
    PubSub: class {
      getTopics() {
        return Promise.resolve([]);
      }
      topic(name: string) {
        return {
          name: name.startsWith('projects/') ? name : `projects/p/topics/${name}`,
          publishMessage: () => Promise.resolve('id'),
          createSubscription: create,
          exists,
          getSubscriptions: list,
        };
      }
      subscription() {
        return {
          on(event: string, handler: (value: never) => void): void {
            const set = listeners.get(event) ?? new Set();
            set.add(handler as (value: unknown) => void);
            listeners.set(event, set);
          },
          off(event: string, handler: (...args: never[]) => void): void {
            listeners.get(event)?.delete(handler as (value: unknown) => void);
          },
          close,
          delete: () => Promise.resolve(),
          getMetadata: metadata,
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  };
  return { sdk, create, exists, list, metadata, close, emit, listeners };
}

describe('Pub/Sub optional subscription policies and stream lifecycle', () => {
  it.each([
    { retryPolicy: { minimumBackoffMs: NaN, maximumBackoffMs: 1 } },
    { retryPolicy: { minimumBackoffMs: 2, maximumBackoffMs: 1 } },
    { deadLetterPolicy: { deadLetterTopic: 'dead', maxDeliveryAttempts: NaN } },
    { messageRetentionSeconds: NaN },
    { expirationTtlSeconds: -1 },
  ])('validates direct transport creation options %j', async (create) => {
    const h = pubSubSdk();
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p' });
    await expect(transport.open('orders', 'consumer', () => {}, { create })).rejects.toThrow(
      RangeError,
    );
    await expect(transport.createSubscription('orders', 'consumer', create)).rejects.toThrow(
      RangeError,
    );
    expect(h.create).not.toHaveBeenCalled();
    await transport.close();
  });
  it('maps policies to protobuf durations, normalizes the target and forwards native delivery metadata', async () => {
    const h = pubSubSdk();
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p', enableMessageOrdering: true });
    const delivery = vi.fn();
    const closed = vi.fn();
    const sub = await transport.open('orders', 'consumer', delivery, {
      onClosed: closed,
      create: {
        retryPolicy: { minimumBackoffMs: 1500, maximumBackoffMs: 5000 },
        deadLetterPolicy: { deadLetterTopic: 'dead', maxDeliveryAttempts: 7 },
        messageRetentionSeconds: 600,
        expirationTtlSeconds: 86400,
      },
    });
    expect(sub.created).toBe(true);
    expect(h.create).toHaveBeenCalledWith('consumer', {
      enableMessageOrdering: true,
      retryPolicy: {
        minimumBackoff: { seconds: 1, nanos: 500000000 },
        maximumBackoff: { seconds: 5, nanos: 0 },
      },
      deadLetterPolicy: { deadLetterTopic: 'projects/p/topics/dead', maxDeliveryAttempts: 7 },
      messageRetentionDuration: { seconds: 600 },
      expirationPolicy: { ttl: { seconds: 86400 } },
    });
    const ack = vi.fn();
    const nack = vi.fn();
    h.emit('message', {
      data: new TextEncoder().encode('{}'),
      ack,
      nack,
      id: 'm',
      orderingKey: 'key',
      publishTime: new Date(1),
    });
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ orderingKey: 'key', messageId: 'm' }),
    );
    h.emit('close', { code: 5 });
    expect(closed).toHaveBeenCalledOnce();
    await sub.close();
    expect(closed).toHaveBeenCalledOnce();
    expect([...h.listeners.values()].every((set) => set.size === 0)).toBe(true);
    await transport.createSubscription('orders', 'reply', { expirationTtlSeconds: 86400 });
    expect(h.create).toHaveBeenLastCalledWith('reply', {
      enableMessageOrdering: true,
      expirationPolicy: { ttl: { seconds: 86400 } },
    });
    await transport.close();
  });
  it('reports created false and reads existing policy metadata on attach, including malformed durations', async () => {
    const h = pubSubSdk();
    h.create.mockRejectedValue({ code: 6 });
    h.metadata.mockResolvedValue([
      {
        topic: 'projects/p/topics/orders',
        retryPolicy: {
          minimumBackoff: { seconds: '1', nanos: 500000000 },
          maximumBackoff: { seconds: 'bad' },
        },
        deadLetterPolicy: { deadLetterTopic: 'projects/p/topics/dead', maxDeliveryAttempts: 9 },
      },
    ]);
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p' });
    const sub = await transport.open('orders', 'existing', () => {});
    expect(sub.created).toBe(false);
    expect(sub.existing?.retryPolicy).toEqual({ minimumBackoffMs: 1500, maximumBackoffMs: NaN });
    expect(sub.existing?.deadLetterPolicy).toEqual({
      deadLetterTopic: 'projects/p/topics/dead',
      maxDeliveryAttempts: 9,
    });
    await sub.close();
    h.metadata.mockResolvedValue([
      { topic: 'projects/p/topics/orders', retryPolicy: {}, deadLetterPolicy: {} },
    ]);
    const empty = await transport.open('orders', 'empty', () => {});
    expect(empty.existing).toEqual({
      retryPolicy: { minimumBackoffMs: 0, maximumBackoffMs: 0 },
      deadLetterPolicy: { deadLetterTopic: '', maxDeliveryAttempts: 0 },
    });
    await empty.close();
    await transport.close();
  });
  it('inspects topic existence separately from a single subscription page and propagates read failures', async () => {
    const h = pubSubSdk();
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p' });
    expect(await transport.topicExists!('dead')).toBe(true);
    h.exists.mockResolvedValue([false]);
    expect(await transport.topicExists!('dead')).toBe(false);
    const error = new Error('remote-secret');
    h.exists.mockRejectedValue(error);
    await expect(transport.topicExists!('dead')).rejects.toBe(error);
    expect(await transport.topicHasSubscriptions!('dead')).toBe(false);
    h.list.mockResolvedValue([[{}]]);
    expect(await transport.topicHasSubscriptions!('dead')).toBe(true);
    expect(h.list).toHaveBeenCalledWith({ pageSize: 1, autoPaginate: false });
    h.list.mockRejectedValue(error);
    await expect(transport.topicHasSubscriptions!('dead')).rejects.toBe(error);
    await transport.close();
  });
  it('does not turn an attachment metadata failure into a dead-letter-topic refusal', async () => {
    const h = pubSubSdk();
    h.create.mockRejectedValue({ code: 6 });
    const cause = { code: 13 };
    h.metadata.mockRejectedValue(cause);
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p' });
    const inspect = vi.spyOn(transport, 'topicExists');
    const clock = clockRuntime();
    const broker = new GcpPubSubBroker(clock.runtime, new JsonSerializer(), {
      client: transport,
      deadLetterTopic: 'dead',
    });
    await broker.connect();
    await expect(broker.subscribe('orders', () => {})).rejects.toBe(cause);
    expect(inspect).not.toHaveBeenCalled();
    await broker.disconnect();
  });
  it('logs only numeric subscription error codes', async () => {
    const h = pubSubSdk();
    const error = vi.fn();
    const transport = adaptPubSubModule(h.sdk, { projectId: 'p', logger: { error } });
    const sub = await transport.open('orders', 'consumer', () => {});
    h.emit('error', { code: 13, message: 'secret' });
    h.emit('error', new Error('secret'));
    expect(error.mock.calls).toEqual([
      ['Pub/Sub subscription error (code 13)'],
      ['Pub/Sub subscription error (code unknown)'],
    ]);
    await sub.close();
    await transport.close();
  });
});

function serviceBusSdk() {
  let deliver: ((message: unknown) => Promise<void>) | undefined;
  const deadLetter = vi.fn(() => Promise.resolve());
  const create = vi.fn(() => Promise.resolve());
  const get = vi.fn(() => Promise.resolve({ maxDeliveryCount: 3 }));
  const receiver: IServiceBusReceiver = {
    subscribe: (handlers) => {
      deliver = handlers.processMessage;
      return { close: () => Promise.resolve() };
    },
    completeMessage: vi.fn(() => Promise.resolve()),
    abandonMessage: vi.fn(() => Promise.resolve()),
    deadLetterMessage: deadLetter,
    close: () => Promise.resolve(),
  };
  const receiverOptions: unknown[] = [];
  const sdk: ServiceBusSdkModule = {
    RetryMode: { Exponential: 1, Fixed: 0 },
    ServiceBusClient: class {
      createSender() {
        return { sendMessages: () => Promise.resolve(), close: () => Promise.resolve() };
      }
      createReceiver(_topic: string, subscriptionOrOptions?: unknown, options?: unknown) {
        receiverOptions.push(options ?? subscriptionOrOptions);
        return receiver;
      }
      close() {
        return Promise.resolve();
      }
    },
    ServiceBusAdministrationClient: class {
      createSubscription = create;
      deleteSubscription() {
        return Promise.resolve();
      }
      getSubscription = get;
    },
  };
  return {
    sdk,
    create,
    get,
    deadLetter,
    receiverOptions,
    receiver,
    deliver: (message: unknown) => deliver!(message),
  };
}

describe('Service Bus management and retry adapter seams', () => {
  it.each([NaN, Infinity, -1, 0.5])(
    'validates a direct autoDeleteOnIdleMs %s',
    async (autoDeleteOnIdleMs) => {
      const h = serviceBusSdk();
      const transport = adaptServiceBusModule(h.sdk, {
        connectionString: 'data',
        adminConnectionString: 'admin',
      });
      await expect(
        transport.createSubscription('orders', 'consumer', { autoDeleteOnIdleMs }),
      ).rejects.toThrow('autoDeleteOnIdleMs');
      expect(h.create).not.toHaveBeenCalled();
      await transport.close();
    },
  );
  it('maps idle deletion, inspection, zero-based delivery count, dead-letter reason and explicit lock renewal', async () => {
    const h = serviceBusSdk();
    const transport = adaptServiceBusModule(h.sdk, {
      connectionString: 'data',
      adminConnectionString: 'admin',
    });
    await transport.createSubscription('orders', 'consumer', { autoDeleteOnIdleMs: 300000 });
    expect(h.create).toHaveBeenCalledWith('orders', 'consumer', { autoDeleteOnIdle: 'PT300S' });
    expect(await transport.getSubscription!('orders', 'consumer')).toEqual({ maxDeliveryCount: 3 });
    const callback = vi.fn<Parameters<typeof transport.open>[2]>(async (message) => {
      expect(message.deliveryCount).toBe(0);
      await message.deadLetter!('setu-attempts-exhausted');
    });
    const sub = await transport.open('orders', 'consumer', callback);
    expect(h.receiverOptions).toEqual([{ maxAutoLockRenewalDurationInMs: 300000 }]);
    const raw = { body: '{}', deliveryCount: 0 };
    await h.deliver(raw);
    expect(h.deadLetter).toHaveBeenCalledExactlyOnceWith(raw, {
      deadLetterReason: 'setu-attempts-exhausted',
    });
    await sub.close();
    await transport.close();
  });
  it.each([
    { name: 'RestError', statusCode: 409, code: 'MessageEntityAlreadyExistsError' },
    { name: 'RestError', statusCode: 409, code: 'Other' },
    { name: 'RestError', statusCode: 403, code: 'MessageEntityAlreadyExistsError' },
    { name: 'Error', statusCode: 409, code: 'MessageEntityAlreadyExistsError' },
  ])('classifies only the documented entity collision %j', async (failure) => {
    const h = serviceBusSdk();
    h.create.mockRejectedValue(failure);
    const transport = adaptServiceBusModule(h.sdk, {
      connectionString: 'data',
      adminConnectionString: 'admin',
    });
    const caught = await transport
      .createSubscription('orders', 'consumer')
      .catch((error: unknown) => error);
    if (
      failure.name === 'RestError' &&
      failure.statusCode === 409 &&
      failure.code === 'MessageEntityAlreadyExistsError'
    ) {
      expect(caught).toBeInstanceOf(SubscriptionNameExistsError);
      expect((caught as Error).cause).toBe(failure);
    } else expect(caught).toBe(failure);
    await transport.close();
  });
  it('omits an unavailable receiver dead-letter method and delivery count', async () => {
    const h = serviceBusSdk();
    delete h.receiver.deadLetterMessage;
    const transport = adaptServiceBusModule(h.sdk, {
      connectionString: 'data',
      adminConnectionString: 'admin',
    });
    const callback = vi.fn();
    await transport.open('orders', 'consumer', callback);
    await h.deliver({ body: '{}' });
    expect(callback.mock.calls[0]![0]).not.toHaveProperty('deadLetter');
    expect(callback.mock.calls[0]![0]).not.toHaveProperty('deliveryCount');
    await transport.close();
  });
});
