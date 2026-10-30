import { describe, expect, it, vi } from 'vitest';
import { AssignerProtocol, KafkaJSProtocolError } from 'kafkajs';
import * as startOffsets from '../../src/brokers/kafka-start-offsets.ts';
import { KafkaBroker, validateClient } from '../../src/brokers/kafka-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import {
  FakeKafkaFactory,
  FakeKafkaAdmin,
  FakeKafkaMessage,
  unknownTopicError,
} from '../fixtures/fake-kafkajs-client.ts';
import {
  KafkaTopicUnavailableError,
  RemoteHandlerError,
  RequestTimeoutError,
} from '../../src/errors.ts';

describe('M113a Kafka bounds and start position', () => {
  it.each([undefined, '0', '9'])(
    'M119a first delivery %s while join offsets are pending',
    async (offset) => {
      const factory = new FakeKafkaFactory();
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
      });
      await broker.connect();
      const handler = vi.fn();
      try {
        await broker.subscribe('orders', handler, { queue: 'workers' });
        const consumer = factory.consumer({ groupId: 'workers' });
        const admin = factory.admins[1]!;
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof admin.fetchOffsets>>>();
        vi.spyOn(admin, 'fetchOffsets').mockReturnValueOnce(pending.promise);
        const join = consumer.join({ orders: [0] });
        if (offset !== undefined)
          await consumer.deliver('orders', new FakeKafkaMessage('{}', offset, '1000', {}));
        pending.resolve([{ topic: 'orders', partitions: [{ partition: 0, offset: '-1' }] }]);
        await join;
        expect(handler).toHaveBeenCalledTimes(offset === undefined ? 0 : 1);
        expect(consumer.calls.filter((c) => c.method === 'seek').map((c) => c.args[0])).toEqual(
          offset === '0' ? [] : [{ topic: 'orders', partition: 0, offset: '0' }],
        );
      } finally {
        await broker.disconnect();
      }
    },
  );
  it('releases the connected producer when the probe admin cannot connect', async () => {
    const factory = new FakeKafkaFactory();
    const producer = factory.producer();
    const disconnect = vi.spyOn(producer, 'disconnect');
    vi.spyOn(FakeKafkaAdmin.prototype, 'connect').mockRejectedValueOnce(new Error('admin down'));
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    try {
      await expect(broker.connect()).rejects.toThrow('admin down');
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(broker.isReady()).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('retries the group admin connect on the next subscribe after one failure', async () => {
    const factory = new FakeKafkaFactory();
    const warn = vi.fn();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      logger: { error: vi.fn(), warn },
    });
    await broker.connect();
    const connect = vi
      .spyOn(FakeKafkaAdmin.prototype, 'connect')
      .mockRejectedValueOnce(new Error('transient'));
    try {
      await broker.subscribe('first', () => {}, { queue: 'g1' });
      expect(warn).toHaveBeenCalledTimes(1);
      await broker.subscribe('second', () => {}, { queue: 'g2' });
      // A third admin (probe, failed group admin, retried group admin) did the read.
      expect(factory.admins).toHaveLength(3);
      expect(factory.admins[2]!.calls.some((c) => c.method === 'fetchOffsets')).toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      await broker.disconnect();
    }
  });

  it.each([false, true])(
    'seeks assigned uncommitted partitions once (own-offset fallback=%s)',
    async (fallback) => {
      const load = fallback
        ? vi.spyOn(startOffsets, 'optionalKafkaStartModule').mockResolvedValue(null)
        : null;
      const factory = new FakeKafkaFactory();
      const admin = new FakeKafkaAdmin();
      admin.offsets[0]!.partitions = [0, 1, 2].map((partition) => ({ partition, offset: '-1' }));
      admin.watermarks = [0, 1, 2].map((partition) => ({
        partition,
        offset: '9007199254740993',
        high: '9007199254740993',
        low: '0',
      }));
      admin.members = [
        { memberMetadata: Buffer.from([0]) },
        { memberMetadata: Buffer.from([0]) },
        {
          memberMetadata: AssignerProtocol.MemberMetadata.encode({
            version: 0,
            topics: ['orders'],
            userData: Buffer.from('{"orders":{"0":"9007199254740992","1":"0","2":"0"}}'),
          }),
        },
      ];
      vi.spyOn(factory, 'admin').mockReturnValue(admin);
      const warn = vi.fn();
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
        logger: { error: vi.fn(), warn },
      });
      try {
        await broker.connect();
        await broker.subscribe('orders', () => {}, { queue: 'workers' });
        const consumer = factory.consumer({ groupId: 'workers' });
        admin.offsets[0]!.partitions[1]!.offset = '7';
        await consumer.join({ orders: [0, 1] });
        expect(
          consumer.calls.filter((call) => call.method === 'seek').map((call) => call.args[0]),
        ).toEqual([
          {
            topic: 'orders',
            partition: 0,
            offset: fallback ? '9007199254740993' : '9007199254740992',
          },
        ]);
        await consumer.join({ orders: [2] });
        expect(consumer.calls.filter((call) => call.method === 'seek')).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(fallback ? 0 : 1);
        if (load) expect(load).toHaveBeenCalledTimes(1);
      } finally {
        await broker.disconnect();
        load?.mockRestore();
      }
    },
  );

  it.each(['fetchOffsets', 'describeGroups', 'seek'] as const)(
    'warns once and remains active when first-join %s fails',
    async (method) => {
      const factory = new FakeKafkaFactory();
      const report = vi.fn();
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
        logger: { error: report },
      });
      await broker.connect();
      await broker.subscribe('orders', () => {}, { queue: 'workers' });
      const consumer = factory.consumer({ groupId: 'workers' });
      if (method === 'seek')
        vi.spyOn(consumer, 'seek').mockImplementation(() => {
          throw new Error('failed');
        });
      else vi.spyOn(factory.admins[1]!, method).mockRejectedValue(new Error('failed'));
      await consumer.join({ orders: [0] });
      await consumer.join({ orders: [0] });
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]![0]).toContain('workers');
      expect(broker.isReady()).toBe(true);
      await broker.disconnect();
    },
  );

  it('captures watermarks when the subscribe-time group read fails (cold coordinator)', async () => {
    const load = vi.spyOn(startOffsets, 'optionalKafkaStartModule').mockResolvedValue(null);
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    admin.offsets[0]!.partitions = [{ partition: 0, offset: '-1' }];
    admin.watermarks = [{ partition: 0, offset: '42', high: '42', low: '0' }];
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    // A fresh broker's coordinator answers NOT_COORDINATOR to the first read.
    vi.spyOn(admin, 'fetchOffsets').mockRejectedValueOnce(
      Object.assign(new Error('This is not the correct coordinator for this group'), { code: 16 }),
    );
    const warn = vi.fn();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      logger: { error: vi.fn(), warn },
    });
    try {
      await broker.connect();
      await broker.subscribe('orders', () => {}, { queue: 'workers' });
      const consumer = factory.consumer({ groupId: 'workers' });
      await consumer.join({ orders: [0] });
      expect(
        consumer.calls.filter((call) => call.method === 'seek').map((call) => call.args[0]),
      ).toEqual([{ topic: 'orders', partition: 0, offset: '42' }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await broker.disconnect();
      load.mockRestore();
    }
  });

  it('does not seek when a release races the first join or removes its assignment', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const subscription = await broker.subscribe('orders', () => {}, { queue: 'workers' });
    const consumer = factory.consumer({ groupId: 'workers' });
    const pending = Promise.withResolvers<Awaited<ReturnType<FakeKafkaAdmin['describeGroups']>>>();
    vi.spyOn(factory.admins[1]!, 'describeGroups').mockReturnValue(pending.promise);
    const join = consumer.join({ orders: [0] });
    await subscription.unsubscribe();
    pending.resolve({ groups: [] });
    await join;
    expect(consumer.calls.filter((call) => call.method === 'seek')).toEqual([]);
    await broker.disconnect();
    await consumer.join({ orders: [0] });
  });

  it('an event-capable factory without admin stays unknown and skips group initialization', async () => {
    const backing = new FakeKafkaFactory();
    const client = {
      producer: () => backing.producer(),
      consumer: (options: { groupId: string }) => backing.consumer(options),
    };
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true);
    await broker.subscribe('orders', () => {});
    expect(backing.admins).toHaveLength(0);
    expect(
      backing
        .consumer({ groupId: 'messaging-consumers:orders' })
        .calls.some((call) => call.method === 'run'),
    ).toBe(true);
    await broker.disconnect();
  });
  it.each([
    [undefined, true],
    [new Error('offline'), false],
    [{ name: 'KafkaJSRequestTimeoutError' }, undefined],
    [{ cause: { name: 'KafkaJSRequestTimeoutError' } }, undefined],
    ['offline', false],
    [null, false],
    [{ cause: {} }, false],
    [
      { cause: { cause: { cause: { cause: { cause: { name: 'KafkaJSRequestTimeoutError' } } } } } },
      false,
    ],
  ] as const)('maps probe rejection %s and caches the round trip', async (error, expected) => {
    let now = 0;
    const runtime = { ...createFakeRuntime(), hrtime: () => now };
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, new JsonSerializer(), { client: factory });
    await broker.connect();
    const probe = vi.spyOn(factory.admins[0]!, 'describeCluster');
    if (error !== undefined) probe.mockRejectedValue(error);

    expect(await broker.reachability()).toBe(expected);
    expect(await broker.reachability()).toBe(expected);
    expect(probe).toHaveBeenCalledTimes(1);
    now = 5001;
    await broker.reachability();
    expect(probe).toHaveBeenCalledTimes(2);
    await broker.disconnect();
    expect(await broker.reachability()).toBeUndefined();
    expect(factory.admins[0]!.calls.filter((c) => c.method === 'disconnect')).toHaveLength(1);
  });

  it('bounds the producer close at 10 s and closes again once in-flight sends settle (audit O1)', async () => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const producer = factory.producer();
    let settleSend: (() => void) | undefined;
    vi.spyOn(producer, 'send').mockImplementation(
      () => new Promise<void>((resolve) => (settleSend = resolve)),
    );
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      publishTimeoutMs: 100,
    });
    try {
      await broker.connect();
      const publish = broker.publish('orders', {}).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(String(await publish)).toContain('publishTimeoutMs');
      // kafkajs waits for pending requests (up to its request timeout) before it closes.
      let finishClose: (() => void) | undefined;
      const close = vi
        .spyOn(producer, 'disconnect')
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finishClose = resolve)));
      let done = false;
      const disconnected = broker.disconnect().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(9999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await disconnected;
      expect(close).toHaveBeenCalledTimes(1);
      // Later the first close finishes and the abandoned send settles (its retries
      // reconnected): the broker closes again.
      finishClose!();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
      settleSend!();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the producer once when nothing was in flight', async () => {
    const factory = new FakeKafkaFactory();
    const close = vi.spyOn(factory.producer(), 'disconnect');
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.publish('orders', {});
    await broker.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds a stuck metadata probe at 2 seconds using runtime timers', async () => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    try {
      await broker.connect();
      vi.spyOn(factory.admins[0]!, 'describeCluster').mockImplementation(
        () => new Promise(() => {}),
      );
      const pending = broker.reachability();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toBeUndefined();
    } finally {
      await broker.disconnect();
      vi.useRealTimers();
    }
  });

  it('short-circuits a fault without another metadata round trip', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const probe = vi.spyOn(factory.admins[0]!, 'describeCluster');
    expect(await broker.reachability()).toBe(true);
    const fault = factory
      .producer()
      .calls.find((c) => c.method === 'on' && c.args[0] === 'producer.disconnect')!
      .args[1] as () => void;
    fault();
    expect(await broker.reachability()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await broker.disconnect();
  });

  it('fails startup on probe connect failure and cleans both connections', async () => {
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    vi.spyOn(admin, 'connect').mockRejectedValue(new Error('probe connect refused'));
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await expect(broker.connect()).rejects.toThrow('probe connect refused');
    vi.spyOn(admin, 'disconnect').mockRejectedValue(new Error('shutdown refused'));
    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });

  it.each([false, true])(
    'captures only a wholly fresh group (committed=%s), before run',
    async (committed) => {
      const factory = new FakeKafkaFactory();
      const admin = new FakeKafkaAdmin();
      admin.offsets = [
        {
          topic: 'test.topic',
          partitions: [
            { partition: 0, offset: '-1' },
            { partition: 1, offset: committed ? '12' : '-1' },
          ],
        },
      ];
      admin.watermarks = [
        { partition: 0, offset: '19', low: '0', high: '19' },
        { partition: 1, offset: '23', low: '0', high: '23' },
      ];
      vi.spyOn(factory, 'admin').mockReturnValue(admin);
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
      });
      await broker.connect();
      const consumer = factory.consumer({ groupId: 'fresh' });
      const run = vi.spyOn(consumer, 'run');
      const capture = vi.spyOn(admin, 'fetchTopicOffsets');
      await broker.subscribe('test.topic', () => {}, { queue: 'fresh' });
      expect(admin.calls.find((c) => c.method === 'fetchOffsets')?.args).toEqual([
        { groupId: 'fresh', topics: ['test.topic'] },
      ]);
      const assigner = factory.consumerOptions.get('fresh')!.partitionAssigners![0]!;
      const protocol = assigner({} as Parameters<typeof assigner>[0]).protocol({
        topics: ['test.topic'],
      });
      expect(
        JSON.parse(AssignerProtocol.MemberMetadata.decode(protocol.metadata)!.userData.toString()),
      ).toEqual(committed ? {} : { 'test.topic': { 0: '19', 1: '23' } });
      await consumer.join({ 'test.topic': [0, 1] });
      const seeks = consumer.calls.filter((call) => call.method === 'seek');
      if (committed) {
        expect(capture).not.toHaveBeenCalled();
        expect(seeks).toEqual([]);
      } else {
        expect(seeks.map((call) => call.args[0])).toEqual([
          { topic: 'test.topic', partition: 0, offset: '19' },
          { topic: 'test.topic', partition: 1, offset: '23' },
        ]);
        expect(capture.mock.invocationCallOrder[0]!).toBeLessThan(run.mock.invocationCallOrder[0]!);
      }
      await broker.disconnect();
    },
  );

  it('coalesces the group admin connect across concurrent subscribes', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const admin = new FakeKafkaAdmin();
    const deferred = Promise.withResolvers<void>();
    const connect = vi.spyOn(admin, 'connect').mockReturnValue(deferred.promise);
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    const subscriptions = [broker.subscribe('a', () => {}), broker.subscribe('b', () => {})];
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    deferred.resolve();
    await Promise.all(subscriptions);
    await broker.disconnect();
    expect(admin.calls.filter((c) => c.method === 'disconnect')).toHaveLength(1);
  });

  it('retries a retriable watermark failure and seeks to the captured offsets', async () => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    admin.watermarks = [{ partition: 0, offset: '42', high: '42', low: '0' }];
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    const capture = vi
      .spyOn(admin, 'fetchTopicOffsets')
      .mockRejectedValueOnce(
        new KafkaJSProtocolError(
          Object.assign(new Error('leader election pending'), { retriable: true }),
        ),
      );
    const warn = vi.fn();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 2, initialRetryTime: 50 },
      logger: { error: vi.fn(), warn },
    });
    try {
      await broker.connect();
      const pending = broker.subscribe('orders', () => {}, { queue: 'workers' });
      await vi.advanceTimersByTimeAsync(49);
      const consumer = factory.consumer({ groupId: 'workers' });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(consumer.calls.some((c) => c.method === 'run')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(capture).toHaveBeenCalledTimes(2);
      await consumer.join({ orders: [0] });
      expect(
        consumer.calls.filter((call) => call.method === 'seek').map((call) => call.args[0]),
      ).toEqual([{ topic: 'orders', partition: 0, offset: '42' }]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await broker.disconnect();
      vi.useRealTimers();
    }
  });

  it.each([
    new KafkaJSProtocolError(Object.assign(new Error('not authorized'), { retriable: false })),
    new Error('missing retry flag'),
    { retriable: 'true' },
    null,
    'offline',
  ])('does not retry a non-retriable watermark failure (%s)', async (failure) => {
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    const capture = vi.spyOn(admin, 'fetchTopicOffsets').mockRejectedValue(failure);
    const warn = vi.fn();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 2, initialRetryTime: 1 },
      logger: { error: vi.fn(), warn },
    });
    try {
      await broker.connect();
      await broker.subscribe('orders', () => {}, { queue: 'workers' });
      const consumer = factory.consumer({ groupId: 'workers' });
      await consumer.join({ orders: [0] });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(consumer.calls.some((c) => c.method === 'run')).toBe(true);
      expect(consumer.calls.filter((c) => c.method === 'seek')).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await broker.disconnect();
    }
  });

  it('exhausts the watermark retry budget with the subscribe backoff and cap', async () => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    const capture = vi
      .spyOn(admin, 'fetchTopicOffsets')
      .mockRejectedValue(
        new KafkaJSProtocolError(
          Object.assign(new Error('leader election pending'), { retriable: true }),
        ),
      );
    const warn = vi.fn();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 3, initialRetryTime: 10, multiplier: 2, maxRetryTime: 25 },
      logger: { error: vi.fn(), warn },
    });
    try {
      await broker.connect();
      const pending = broker.subscribe('orders', () => {}, { queue: 'workers' });
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).toHaveBeenCalledTimes(1);
      for (const [index, delay] of [10, 20, 25].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(capture).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(capture).toHaveBeenCalledTimes(index + 2);
      }
      await pending;
      const consumer = factory.consumer({ groupId: 'workers' });
      await consumer.join({ orders: [0] });
      expect(consumer.calls.some((c) => c.method === 'run')).toBe(true);
      expect(consumer.calls.filter((c) => c.method === 'seek')).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await broker.disconnect();
      vi.useRealTimers();
    }
  });

  it('cancels a watermark retry wait on disconnect without another read', async () => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const admin = new FakeKafkaAdmin();
    vi.spyOn(factory, 'admin').mockReturnValue(admin);
    const capture = vi
      .spyOn(admin, 'fetchTopicOffsets')
      .mockRejectedValue(
        new KafkaJSProtocolError(
          Object.assign(new Error('leader election pending'), { retriable: true }),
        ),
      );
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 2, initialRetryTime: 60_000 },
    });
    try {
      await broker.connect();
      const pending = broker
        .subscribe('orders', () => {}, { queue: 'workers' })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await broker.disconnect();
      expect(await pending).toEqual(new Error('KafkaBroker was disconnected while subscribing'));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(capture).toHaveBeenCalledTimes(1);
      const methods = factory.consumer({ groupId: 'workers' }).calls.map((c) => c.method);
      expect(methods).toContain('disconnect');
      expect(methods).not.toContain('run');
    } finally {
      await broker.disconnect();
      vi.useRealTimers();
    }
  });

  it.each(['warn', 'error', 'throws', 'absent'] as const)(
    'keeps the subscription active when group init fails (logger=%s)',
    async (mode) => {
      const factory = new FakeKafkaFactory();
      const report = vi.fn((message: string) => {
        void message;
        if (mode === 'throws') throw new Error('logger failed');
      });
      const logger =
        mode === 'absent'
          ? undefined
          : { error: report, ...(mode === 'warn' ? { warn: report } : {}) };
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
        ...(logger ? { logger } : {}),
      });
      await broker.connect();
      const admin = new FakeKafkaAdmin();
      vi.spyOn(admin, 'fetchTopicOffsets').mockRejectedValue(new Error('group active'));
      vi.spyOn(factory, 'admin').mockReturnValue(admin);
      await broker.subscribe('orders', () => {}, { queue: 'workers' });
      expect(factory.consumer({ groupId: 'workers' }).calls.some((c) => c.method === 'run')).toBe(
        true,
      );
      if (logger) {
        expect(report).toHaveBeenCalledTimes(1);
        expect(report.mock.calls[0]?.[0]).toContain('orders');
        expect(report.mock.calls[0]?.[0]).toContain('workers');
      }
      await broker.disconnect();
    },
  );

  it.each([0, 45])('bounds both publish entry points with timeout %s', async (timeout) => {
    vi.useFakeTimers();
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      publishTimeoutMs: timeout,
    });
    try {
      await broker.connect();
      const deferred = Promise.withResolvers<void>();
      const send = vi.spyOn(factory.producer(), 'send').mockReturnValue(deferred.promise);
      let settled = 0;
      const calls = [broker.publish('orders', {}), broker.publishWithHeaders('orders', {}, {})].map(
        (p) =>
          p.then(
            () => 'ok',
            (e: Error) => {
              settled++;
              return e.message;
            },
          ),
      );
      await vi.advanceTimersByTimeAsync(44);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(timeout === 0 ? 0 : 2);
      if (timeout)
        for (const result of await Promise.all(calls))
          expect(result).toMatch(/Kafka.*orders.*45.*it may still be delivered$/);
      deferred.resolve();
      if (!timeout) expect(await Promise.all(calls)).toEqual(['ok', 'ok']);
      send.mockResolvedValue();
      await broker.publish('settles-first', {});
    } finally {
      await broker.disconnect();
      vi.useRealTimers();
    }
  });
});

/**
 * KafkaBroker unit tests.
 *
 * Tests broker behavior using an injected fake Kafka client.
 */
describe('KafkaBroker', () => {
  it('validateClient rejects malformed client', () => {
    // Missing required methods
    expect(validateClient({})).toBe(false);
    expect(validateClient({ get: () => null })).toBe(false);

    // Valid shape
    expect(
      validateClient({
        producer: () => ({}),
        consumer: () => ({}),
      }),
    ).toBe(true);
  });

  it('publish emits producer.send with serialized payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    const message = { userId: 123, event: 'test' };
    const expectedJson = JSON.stringify(message);
    await broker.publish('test.topic', message);

    const producer = fakeFactory.producer();
    const calls = producer.calls;
    const sendCall = calls.find((c) => c.method === 'send');

    expect(sendCall).toBeDefined();
    expect((sendCall?.args[0] as { topic: string }).topic).toBe('test.topic');

    // Assert the serialized bytes match the expected JSON
    const messagesArg = (sendCall?.args[0] as { messages: unknown[] }).messages;
    const valueArg = (messagesArg[0] as { value: string }).value;
    expect(valueArg).toBe(expectedJson);

    await broker.disconnect();
  });

  it('subscribe creates consumer with groupId', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    // Subscribe
    await broker.subscribe('test.topic', () => {}, { queue: 'my-group' });

    const consumer = fakeFactory.consumer({ groupId: 'my-group' });
    const calls = consumer.calls;

    // Should have called subscribe
    const subscribeCall = calls.find((c) => c.method === 'subscribe');

    expect(subscribeCall).toBeDefined();

    await broker.disconnect();
  });

  it('disconnect stops consumer and producer', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.disconnect();

    // Should be disconnected
    expect(broker.isReady()).toBe(false);
  });

  it('connect is idempotent', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('validateClient rejects client without required methods', () => {
    expect(
      validateClient({
        producer: () => ({}),
        // Missing consumer
      }),
    ).toBe(false);
  });

  it('validateClient prefers injected client', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();

    const broker = new KafkaBroker(runtime, serializer, {
      client: fakeFactory,
      brokers: ['should-not-be-used'],
    });

    await broker.connect();

    // Should have used injected client
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('publish throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    // Don't connect
    await expect(broker.publish('test', { data: 'test' })).rejects.toThrow(
      'KafkaBroker is not connected',
    );
  });

  it('subscribe throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    // Don't connect
    await expect(broker.subscribe('test', async () => {})).rejects.toThrow(
      'KafkaBroker is not connected',
    );
  });

  it('derives a per-topic consumer group when no queue is supplied (M90d)', async () => {
    // Measured against a real broker: members of ONE group subscribing
    // DIFFERENT topics end with empty assignments and neither receives
    // anything. The default group is therefore derived per topic; an explicit
    // `queue` still names the group itself.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.subscribe('orders', () => {});
    await broker.subscribe('billing', () => {});
    await broker.subscribe('orders', () => {}, { queue: 'explicit-group' });

    const groups = fakeFactory.groupIds;
    expect(groups).toContain('messaging-consumers:orders');
    expect(groups).toContain('messaging-consumers:billing');
    expect(groups).toContain('explicit-group');
    // Different topics never share a group.
    expect(groups.filter((g) => g === 'messaging-consumers:orders')).toHaveLength(1);

    await broker.disconnect();
  });

  it('derives groups that cannot collide across prefix/topic pairs (M90d review)', async () => {
    // `${prefix}-${topic}` is not injective: ('orders-eu', 'created') and
    // ('orders', 'eu-created') both yield `orders-eu-created`, which puts two
    // consumers subscribing DIFFERENT topics into one group — the exact empty-
    // assignment failure the per-topic derivation exists to prevent. A Kafka
    // topic name may not contain `:` (probed: the broker refuses one at
    // creation) while a group id may, so the pair is recoverable and the two
    // configurations below must land in different groups.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();

    const splitA = new FakeKafkaFactory();
    const brokerA = new KafkaBroker(runtime, serializer, {
      client: splitA,
      defaultQueue: 'orders-eu',
    });
    await brokerA.connect();
    await brokerA.subscribe('created', () => {});
    await brokerA.disconnect();

    const splitB = new FakeKafkaFactory();
    const brokerB = new KafkaBroker(runtime, serializer, {
      client: splitB,
      defaultQueue: 'orders',
    });
    await brokerB.connect();
    await brokerB.subscribe('eu-created', () => {});
    await brokerB.disconnect();

    const [groupA] = splitA.groupIds;
    const [groupB] = splitB.groupIds;
    expect(groupA).toBe('orders-eu:created');
    expect(groupB).toBe('orders:eu-created');
    expect(groupA).not.toBe(groupB);
  });

  it('attaches the producer events by their WIRE values, recorded by the fake (X28-1)', async () => {
    // The corrected fake RECORDS every `on(event, …)` name and rejects the
    // ones real kafkajs rejects, so this asserts the constant and not a fake's
    // willingness to accept any string — the exact shape that hid the defect
    // for four releases.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    const producer = fakeFactory.producer();
    const attached = producer.calls
      .filter((c) => c.method === 'on')
      .map((c) => c.args[0] as string)
      .sort();
    expect(attached).toEqual(['producer.connect', 'producer.disconnect']);

    await broker.disconnect();
  });

  it('the producer disposer removes the listener through the event surface', async () => {
    // disconnect() stops the supervisor, which invokes the disposers — the
    // `off` path the no-op-guard used to swallow entirely.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.disconnect();

    const producer = fakeFactory.producer();
    expect(producer.calls.some((c) => c.method === 'off')).toBe(true);
  });

  it('isReady returns false before connect', () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    expect(broker.isReady()).toBe(false);
  });

  it('isReady returns true after connect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('isReady returns false after disconnect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });

  it('validateClient rejects null', () => {
    expect(validateClient(null)).toBe(false);
  });

  it('validateClient rejects non-object', () => {
    expect(validateClient('string')).toBe(false);
    expect(validateClient(123)).toBe(false);
    expect(validateClient(true)).toBe(false);
  });

  it('custom clientId is used', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, {
      client: fakeFactory,
      clientId: 'custom-client',
    });

    await broker.connect();

    // Client ID would be used in real Kafka factory creation
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  // Guarded real-import test - exercises the lazy-load path
  it('connect without an injected client exercises the loadKafkajs() lazy-import path', async () => {
    // Covers the real loadKafkajs() -> await import('npm:kafkajs@2.x') path by constructing
    // a broker with NO injected client. connect() rejects either way: if kafkajs is present the
    // empty broker list below is refused, and if kafkajs is absent the dynamic import rejects. In
    // both cases loadKafkajs() is entered, so this remains coverage of the real import path rather
    // than the injected-client seam (which validateClient covers separately).
    //
    // An EMPTY broker list rather than a dead port. `brokers: ['localhost:9999']` reached the same
    // lines and then spent 15 s doing it, because kafkajs treats a refused connection as retriable
    // and works through its whole default retry budget — probed against the installed package:
    // `retries: 5`, `initialRetryTime: 300`, `multiplier: 2` — before
    // giving up — the slowest step in this package's unit tests. An empty list is a
    // KafkaJSNonRetriableError raised in ~3 ms (measured), so the rejection is immediate AND
    // deterministic: the dead-port form's duration also varied with DNS and firewall behaviour.
    // `#brokers` is assigned with `??`, so `[]` is passed through rather than defaulted.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();

    const broker = new KafkaBroker(runtime, serializer, {
      brokers: [],
    });

    // Pinned to the EMPTY-LIST rejection rather than merely "it rejected". A
    // revert to `brokers: ['localhost:9999']` still rejects, so a bare
    // `rejects.toThrow()` would pass with the 15 s wait restored and nothing
    // would notice. kafkajs answers a refused connection with
    // `KafkaJSNumberOfRetriesExceeded: Connection error`, which this does not
    // match.
    await expect(broker.connect()).rejects.toThrow('brokers array is empty');
  });

  // K1: seeded-message delivery
  it('subscribe delivers a seeded message to the handler with decoded metadata', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'test.topic',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '5',
          timestamp: String(Date.now()),
          headers: { h: 'v' },
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    let handlerCalled = false;
    let receivedData: unknown;
    let receivedMetadata: unknown;

    await broker.connect();
    await broker.subscribe('test.topic', (data, metadata) => {
      handlerCalled = true;
      receivedData = data;
      receivedMetadata = metadata;
    });

    // Deliver seeded messages
    await fakeFactory.deliverAll();

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ x: 1 });
    const meta = receivedMetadata as {
      topic: string;
      messageId: string;
      timestamp: Date;
      headers: Record<string, string>;
    };
    expect(meta.topic).toBe('test.topic');
    expect(meta.messageId).toBe('0:5');
    expect(meta.timestamp instanceof Date).toBe(true);
    expect(meta.headers).toEqual({ h: 'v' });

    await broker.disconnect();
  });

  it('normalizes every IHeaders arm kafkajs can deliver', async () => {
    // kafkajs types a header value as `Buffer | string | (Buffer | string)[] |
    // undefined`. Decoding unconditionally corrupts a plain string, and
    // ignoring the array arm silently drops a repeated header — so every arm
    // needs a case. The fake passes non-string values through untouched.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const encode = (text: string) => new TextEncoder().encode(text);
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'arms',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '1',
          timestamp: String(Date.now()),
          headers: {
            // Encoded by the fake, as real kafkajs delivers a Buffer.
            fromString: 'plain',
            // Already bytes.
            fromBytes: encode('bytes'),
            // A value real kafkajs hands over as a raw string.
            rawString: 'raw' as unknown as Uint8Array,
            // A repeated header: first value wins, like `Headers.get`.
            repeated: [encode('first'), encode('second')],
            repeatedStrings: ['one', 'two'],
            // Absent and empty arms contribute no key at all.
            absent: undefined,
            emptyArray: [],
            // A shape kafkajs's types forbid but a hostile/foreign producer could
            // still surface. It must be DROPPED: `TextDecoder.decode` throws on a
            // non-BufferSource, and this runs inside `eachMessage`, where a throw
            // blocks the offset commit and the record is redelivered forever.
            malformed: { not: 'a header' } as unknown as Uint8Array,
            malformedInArray: [{ nested: true }] as unknown as Uint8Array[],
          },
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    let headers: Readonly<Record<string, string>> | undefined;
    await broker.connect();
    await broker.subscribe('arms', (_data, metadata) => {
      headers = metadata.headers;
    });
    await fakeFactory.deliverAll();

    expect(headers).toEqual({
      fromString: 'plain',
      fromBytes: 'bytes',
      rawString: 'raw',
      repeated: 'first',
      repeatedStrings: 'one',
    });
    await broker.disconnect();
  });

  // K2: unsubscribe closure
  it('unsubscribe disconnects the consumer and removes the active subscription', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    const sub = await broker.subscribe('test.topic', () => {});

    await sub.unsubscribe();

    // Verify the consumer was DISCONNECTED (kafkajs's `disconnect()` stops it
    // first); `stop()` alone left its connection open (M101b review). The
    // default group is derived per topic (M90d): `messaging-consumers:<topic>`.
    const consumer = fakeFactory.consumer({ groupId: 'messaging-consumers:test.topic' });
    const calls = consumer.calls;
    expect(calls.some((c) => c.method === 'disconnect')).toBe(true);

    await broker.disconnect();
  });

  // K3: publish with non-object payload
  it('publish with a non-object payload sends an empty header map', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.publish('test.topic', 42);

    const producer = fakeFactory.producer();
    const calls = producer.calls;
    const sendCall = calls.find((c) => c.method === 'send');

    expect(sendCall).toBeDefined();
    const messages = (sendCall?.args[0] as { messages: unknown[] }).messages;
    expect(messages[0]).toEqual({ value: '42', headers: {} });

    await broker.disconnect();
  });

  // K4: disconnect swallows consumer that rejects on stop
  it('disconnect swallows a consumer that rejects on stop', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({ rejectStop: true });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.subscribe('test.topic', () => {});

    // Should not throw
    await expect(broker.disconnect()).resolves.not.toThrow();
  });

  // K5: validateClient throws when injected client is invalid
  it('connect throws when injected client is invalid', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {
      client: { producer: () => {} } as unknown as FakeKafkaFactory, // missing consumer
    });

    await expect(broker.connect()).rejects.toThrow('does not match the required structural shape');
  });

  // K6: success-path - handler succeeds
  it('subscribe invokes the handler on a successful message', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'test.topic',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '1',
          timestamp: new Date().toISOString(),
          headers: {},
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    let handlerCalled = false;
    await broker.subscribe('test.topic', (data) => {
      handlerCalled = true;
      expect(data).toEqual({ x: 1 });
    });

    // Wait for handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    await broker.disconnect();

    expect(handlerCalled).toBe(true);
  });

  // K7: failure-path - handler throws
  it('does NOT commit the offset when the handler throws', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'test.topic',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '7',
          timestamp: '1700000000000',
          headers: {},
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    let handlerInvoked = false;
    await broker.subscribe(
      'test.topic',
      () => {
        handlerInvoked = true;
        throw new Error('handler failure');
      },
      { queue: 'g-fail' },
    );

    await fakeFactory.deliverAll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const consumer = fakeFactory.consumer({ groupId: 'g-fail' });
    expect(handlerInvoked).toBe(true);
    // eachMessage rejected → kafkajs does NOT commit the offset (message redelivers).
    expect(consumer.committedOffsets).toEqual([]);

    await broker.disconnect();
  });

  it('commits the offset when the handler succeeds', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'test.topic',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '9',
          timestamp: '1700000000000',
          headers: {},
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    let handlerInvoked = false;
    await broker.subscribe(
      'test.topic',
      () => {
        handlerInvoked = true;
      },
      { queue: 'g-ok' },
    );

    await fakeFactory.deliverAll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const consumer = fakeFactory.consumer({ groupId: 'g-ok' });
    expect(handlerInvoked).toBe(true);
    // eachMessage resolved → kafkajs auto-commits the offset.
    expect(consumer.committedOffsets).toContain('9');

    await broker.disconnect();
  });
});

describe('KafkaBroker request-reply', () => {
  /** A connected broker over a fake factory that routes produced messages. */
  const connected = async (
    factory: FakeKafkaFactory,
    options: { replyTopic?: string } = {},
  ): Promise<KafkaBroker> => {
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      ...(options.replyTopic !== undefined && { replyTopic: options.replyTopic }),
    });
    await broker.connect();
    return broker;
  };

  it('round-trips a request to a responder and resolves with its reply', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    await broker.respond<{ n: number }, { doubled: number }>('math.double', (req) => ({
      doubled: req.n * 2,
    }));
    const reply = await broker.request<{ n: number }, { doubled: number }>('math.double', {
      n: 21,
    });

    expect(reply).toEqual({ doubled: 42 });
    await broker.disconnect();
  });

  it('reads its reply inbox under a unique group, never the shared default', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    await broker.respond('t', () => 'ok');
    await broker.request('t', {});

    const inboxGroups = factory.groupIds.filter((g) => g.startsWith('rr-inbox-'));
    expect(inboxGroups.length).toBe(1);
    // The shared default group would hand this instance's replies to whichever
    // group member owns the partition — the defect this design exists to avoid.
    expect(inboxGroups[0]).not.toBe('messaging-consumers');
    await broker.disconnect();
  });

  it('defaults the reply topic to messaging.replies and honors an override', async () => {
    const defaultFactory = new FakeKafkaFactory();
    const defaultBroker = await connected(defaultFactory);
    await defaultBroker.respond('t', () => 'ok');
    await defaultBroker.request('t', {});

    const producer = defaultFactory.producer();
    const sentTopics = producer.calls
      .filter((c) => c.method === 'send')
      .map((c) => (c.args[0] as { topic: string }).topic);
    expect(sentTopics).toContain('messaging.replies');
    await defaultBroker.disconnect();

    const customFactory = new FakeKafkaFactory();
    const customBroker = await connected(customFactory, { replyTopic: 'svc.replies' });
    await customBroker.respond('t', () => 'ok');
    await customBroker.request('t', {});

    const customTopics = customFactory
      .producer()
      .calls.filter((c) => c.method === 'send')
      .map((c) => (c.args[0] as { topic: string }).topic);
    expect(customTopics).toContain('svc.replies');
    expect(customTopics).not.toContain('messaging.replies');
    await customBroker.disconnect();
  });

  it('publishes requests to the derived rr.req channel, not the caller topic', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    await broker.respond('user.lookup', () => 'ok');
    await broker.request('user.lookup', {});

    const sentTopics = factory
      .producer()
      .calls.filter((c) => c.method === 'send')
      .map((c) => (c.args[0] as { topic: string }).topic);
    expect(sentTopics).toContain('rr.req.user.lookup');
    expect(sentTopics).not.toContain('user.lookup');
    await broker.disconnect();
  });

  it('rejects with RequestTimeoutError when no responder is listening', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    await expect(broker.request('nobody.home', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
    await broker.disconnect();
  });

  it('propagates a responder throw as RemoteHandlerError', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    await broker.respond('boom', () => {
      throw new Error('handler exploded');
    });

    let caught: unknown;
    try {
      await broker.request('boom', {}, { timeoutMs: 500 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteHandlerError);
    expect((caught as RemoteHandlerError).remoteMessage).toBe('handler exploded');
    await broker.disconnect();
  });

  it('does not resolve a reply belonging to another broker instance', async () => {
    // Two instances share one reply topic; each must resolve only its own
    // correlation ids and silently drop the other's.
    const factory = new FakeKafkaFactory();
    const responder = await connected(factory);
    const caller = await connected(factory);

    await responder.respond<{ from: string }, string>('who', (req) => `hi ${req.from}`);

    const reply = await caller.request<{ from: string }, string>('who', { from: 'a' });
    expect(reply).toBe('hi a');

    await responder.disconnect();
    await caller.disconnect();
  });

  it('disconnect() rejects an in-flight request rather than leaking its timer', async () => {
    const factory = new FakeKafkaFactory();
    const broker = await connected(factory);

    const pending = broker.request('never', {}, { timeoutMs: 60_000 });
    // Let the inbox open and the request publish, so the pending entry is
    // actually registered — disconnecting before that races the publish and
    // fails with "not connected" instead, which tests nothing about close().
    await new Promise((resolve) => setTimeout(resolve, 0));
    await broker.disconnect();

    await expect(pending).rejects.toThrow('disconnected');
  });
});

describe('KafkaBroker unknown topics and consumer crashes (M101b, V8-26)', () => {
  const FAST = { retries: 2, initialRetryTime: 1 } as const;

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return await promise.then(
      () => null,
      (e: unknown) => e,
    );
  }

  function subscribeCalls(factory: FakeKafkaFactory, groupId: string): number {
    return factory.consumer({ groupId }).calls.filter((c) => c.method === 'subscribe').length;
  }

  it('names a topic still unknown after the retry budget, naming topic and group', async () => {
    const factory = new FakeKafkaFactory({ unknownTopics: ['orders'] });
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: FAST,
    });
    await broker.connect();

    const err = await rejection(broker.subscribe('orders', () => {}));

    expect(err).toBeInstanceOf(KafkaTopicUnavailableError);
    const named = err as KafkaTopicUnavailableError;
    expect(named.topic).toBe('orders');
    expect(named.groupId).toBe('messaging-consumers:orders');
    expect(named.message).toContain('"orders"');
    expect(named.message).toContain('"messaging-consumers:orders"');
    expect(named.message).toContain('auto.create.topics.enable');
    expect((named.cause as { type?: string }).type).toBe('UNKNOWN_TOPIC_OR_PARTITION');
    // One attempt plus `retries`, and the consumer is released, not leaked.
    const consumer = factory.consumer({ groupId: 'messaging-consumers:orders' });
    expect(subscribeCalls(factory, 'messaging-consumers:orders')).toBe(3);
    expect(consumer.calls.at(-1)?.method).toBe('disconnect');
    await broker.disconnect();
  });

  it('names the topic at once with retries: 0', async () => {
    const factory = new FakeKafkaFactory({ unknownTopics: ['orders'] });
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 0 },
    });
    await broker.connect();

    expect(await rejection(broker.subscribe('orders', () => {}, { queue: 'g1' }))).toBeInstanceOf(
      KafkaTopicUnavailableError,
    );
    expect(subscribeCalls(factory, 'g1')).toBe(1);
    await broker.disconnect();
  });

  it('subscribes once a topic an auto-creating broker just created becomes known', async () => {
    // A KRaft broker answers UNKNOWN_TOPIC_OR_PARTITION to the request that
    // auto-creates the topic; the next attempt finds it (measured, Kafka 4.0).
    const unknown = ['orders'];
    const factory = new FakeKafkaFactory({ unknownTopics: unknown });
    const consumer = factory.consumer({ groupId: 'messaging-consumers:orders' });
    const original = consumer.subscribe.bind(consumer);
    consumer.subscribe = (options) => {
      const result = original(options);
      unknown.length = 0; // created by the first (rejected) request
      return result;
    };
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: FAST,
    });
    await broker.connect();

    const received: unknown[] = [];
    await broker.subscribe('orders', (m) => {
      received.push(m);
    });
    await broker.publish('orders', { n: 1 });

    expect(subscribeCalls(factory, 'messaging-consumers:orders')).toBe(2);
    expect(received).toEqual([{ n: 1 }]);
    await broker.disconnect();
  });

  it('recognises an unknown topic wrapped in a retry-exhaustion cause chain', async () => {
    const factory = new FakeKafkaFactory();
    const consumer = factory.consumer({ groupId: 'g' });
    const wrapped = Object.assign(new Error('retries exceeded'), {
      name: 'KafkaJSNumberOfRetriesExceeded',
      cause: unknownTopicError(),
    });
    consumer.subscribe = () => Promise.reject(wrapped);
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 0 },
    });
    await broker.connect();

    const err = await rejection(broker.subscribe('orders', () => {}, { queue: 'g' }));
    expect(err).toBeInstanceOf(KafkaTopicUnavailableError);
    expect((err as Error).cause).toBe(wrapped);
    await broker.disconnect();
  });

  it('rethrows any other subscribe failure unchanged, without retrying', async () => {
    const factory = new FakeKafkaFactory();
    const consumer = factory.consumer({ groupId: 'g' });
    const failures: unknown[] = [
      Object.assign(new Error('not authorized'), { type: 'TOPIC_AUTHORIZATION_FAILED' }),
      'a bare string',
      // A cause chain longer than the walk, and one ending in a non-object.
      { cause: { cause: { cause: { cause: { cause: { type: 'UNKNOWN_TOPIC_OR_PARTITION' } } } } } },
      { cause: 'not an object' },
    ];
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: FAST,
    });
    await broker.connect();

    for (const failure of failures) {
      let calls = 0;
      consumer.subscribe = () => {
        calls++;
        return Promise.reject(failure);
      };
      expect(await rejection(broker.subscribe('orders', () => {}, { queue: 'g' }))).toBe(failure);
      expect(calls).toBe(1);
    }
    await broker.disconnect();
  });

  it('stops retrying when the broker is disconnected mid-wait, cancelling the wait', async () => {
    // A one-minute backoff: the wait must be CANCELLED by disconnect(), not
    // merely abandoned — a pending timer would hold this test (and a real
    // process) open for the whole minute, and Deno's sanitizer reports it.
    const factory = new FakeKafkaFactory({ unknownTopics: ['orders'] });
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 5, initialRetryTime: 60_000 },
    });
    await broker.connect();

    const started = performance.now();
    const pending = rejection(broker.subscribe('orders', () => {}));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let it enter the wait
    await broker.disconnect();
    const err = await pending;

    expect((err as Error).message).toContain('disconnected while subscribing');
    expect(subscribeCalls(factory, 'messaging-consumers:orders')).toBe(1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('stops retrying when disconnect() lands before the first attempt', async () => {
    const factory = new FakeKafkaFactory({ unknownTopics: ['orders'] });
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 5, initialRetryTime: 1 },
    });
    await broker.connect();

    const pending = rejection(broker.subscribe('orders', () => {}));
    await broker.disconnect(); // before the consumer has even connected
    const err = await pending;

    expect((err as Error).message).toContain('disconnected while subscribing');
    expect(subscribeCalls(factory, 'messaging-consumers:orders')).toBe(1);
  });

  it('refuses an out-of-range retry budget at construction', () => {
    const cases: Array<[Record<string, number>, string]> = [
      [{ retries: Number.NaN }, 'retries'],
      [{ retries: -1 }, 'retries'],
      [{ retries: 1.5 }, 'retries'],
      [{ initialRetryTime: -1 }, 'initialRetryTime'],
      [{ initialRetryTime: Number.NaN }, 'initialRetryTime'],
      [{ multiplier: 0.5 }, 'multiplier'],
      [{ multiplier: Number.POSITIVE_INFINITY }, 'multiplier'],
      [{ maxRetryTime: Number.POSITIVE_INFINITY }, 'maxRetryTime'],
      [{ maxRetryTime: -5 }, 'maxRetryTime'],
      // `factor` is forwarded to kafkajs as its jitter: a NaN, non-finite or
      // negative factor, or one above 1 (which draws negative delays), made
      // kafkajs's own retries run back to back (security audit F2).
      [{ factor: Number.NaN }, 'factor'],
      [{ factor: Number.POSITIVE_INFINITY }, 'factor'],
      [{ factor: -0.1 }, 'factor'],
      [{ factor: 1.5 }, 'factor'],
    ];
    for (const [retry, field] of cases) {
      expect(
        () =>
          new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
            client: new FakeKafkaFactory(),
            retry,
          }),
      ).toThrow(`KafkaOptions.retry.${field}`);
    }
  });

  it('reports a run() rejection through the logger and stays ready', async () => {
    const crash = new Error('consumer crashed and was not restarted');
    const errors: string[] = [];
    const factory = new FakeKafkaFactory({ runRejection: crash });
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      logger: { error: (m) => errors.push(m) },
    });
    await broker.connect();

    await broker.subscribe('orders', () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"orders"');
    expect(errors[0]).toContain('"messaging-consumers:orders"');
    expect(errors[0]).toContain('consumer crashed and was not restarted');
    expect(broker.isReady()).toBe(true);
    await broker.disconnect();
  });

  it('contains a run() rejection with no logger, or a logger that throws', async () => {
    // Either would otherwise be an unhandled rejection, which fails this test.
    for (const logger of [
      undefined,
      {
        error: () => {
          throw new Error('logger down');
        },
      },
    ]) {
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: new FakeKafkaFactory({ runRejection: new Error('crash') }),
        ...(logger !== undefined ? { logger } : {}),
      });
      await broker.connect();
      await broker.subscribe('orders', () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(broker.isReady()).toBe(true);
      await broker.disconnect();
    }
  });
});

describe('KafkaBroker releases consumer connections (M101b review)', () => {
  // `stop()` only halts fetching; the consumer's cluster connection stays open
  // and keeps the process alive after `app.stop()` (measured on real Kafka:
  // the process never exited, on develop too). kafkajs's `disconnect()` stops
  // AND closes the connection.
  it('disconnect() disconnects every active consumer', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    await broker.subscribe('payments', () => {});

    await broker.disconnect();

    for (const groupId of ['messaging-consumers:orders', 'messaging-consumers:payments']) {
      const methods = factory.consumer({ groupId }).calls.map((c) => c.method);
      expect(methods).toContain('disconnect');
    }
  });

  it('unsubscribe() disconnects that consumer — including the RPC reply inbox', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const sub = await broker.subscribe('orders', () => {}, { queue: 'g-orders' });

    await sub.unsubscribe();

    expect(factory.consumer({ groupId: 'g-orders' }).calls.map((c) => c.method)).toContain(
      'disconnect',
    );
    await broker.disconnect();
  });
});

describe('KafkaBroker disconnect during a subscribe (M101b security audit O1)', () => {
  // A disconnect() that lands while subscribe() is still connecting or making
  // its first attempt used to let the subscription complete — a consumer then
  // ran after shutdown, holding the process open and consuming messages.
  async function race(gate: 'connect' | 'subscribe') {
    const factory = new FakeKafkaFactory();
    const consumer = factory.consumer({ groupId: 'messaging-consumers:orders' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const original = consumer[gate].bind(consumer) as (o?: unknown) => Promise<void>;
    (consumer as unknown as Record<string, unknown>)[gate] = async (o?: unknown) => {
      await held;
      return await original(o);
    };
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();

    const pending = broker
      .subscribe('orders', () => {})
      .then(
        () => 'resolved',
        (e: Error) => e.message,
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await broker.disconnect();
    release();

    const outcome = await pending;
    const methods = consumer.calls.map((c) => c.method);
    return { outcome, methods };
  }

  for (const gate of ['connect', 'subscribe'] as const) {
    it(`refuses and releases the consumer when disconnect() lands during ${gate}`, async () => {
      const { outcome, methods } = await race(gate);
      expect(outcome).toBe('KafkaBroker was disconnected while subscribing');
      expect(methods).toContain('disconnect');
      expect(methods).not.toContain('run');
    });
  }
});

describe('KafkaBroker disconnect during a group join (M101b security audit F3)', () => {
  // kafkajs's consumer.run() settles only once the group join completes (or its
  // crash handler has run). Disconnecting before that is a no-op stop followed
  // by closing the connections under the join, which kafkajs treats as a
  // retriable crash and RESTARTS — the consumer rejoins after shutdown. So the
  // broker waits for run() to settle, bounded, before disconnecting.
  function joiningConsumer(factory: FakeKafkaFactory, groupId: string) {
    const consumer = factory.consumer({ groupId });
    let join!: () => void;
    const joined = new Promise<void>((resolve) => (join = resolve));
    const order: string[] = [];
    const run = consumer.run.bind(consumer);
    (consumer as unknown as Record<string, unknown>).run = (o: Parameters<typeof run>[0]) => {
      void run(o);
      return joined.then(() => void order.push('joined'));
    };
    const disconnect = consumer.disconnect.bind(consumer);
    (consumer as unknown as Record<string, unknown>).disconnect = () => {
      order.push('disconnect');
      return disconnect();
    };
    return { join, order };
  }

  it('disconnect() waits for an in-flight join before disconnecting the consumer', async () => {
    const factory = new FakeKafkaFactory();
    const { join, order } = joiningConsumer(factory, 'messaging-consumers:orders');
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});

    const stopping = broker.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]); // not disconnected mid-join
    join();
    await stopping;

    expect(order).toEqual(['joined', 'disconnect']);
  });

  it('unsubscribe() waits for an in-flight join the same way', async () => {
    const factory = new FakeKafkaFactory();
    const { join, order } = joiningConsumer(factory, 'g');
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const sub = await broker.subscribe('orders', () => {}, { queue: 'g' });

    const leaving = sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    join();
    await leaving;

    expect(order).toEqual(['joined', 'disconnect']);
    await broker.disconnect();
  });

  it('releases consumers concurrently, so stalled joins do not add up', async () => {
    // Three joins that never settle and a bound of 50 ms: released in turn,
    // shutdown would take ~150 ms; concurrently, ~50 ms.
    const factory = new FakeKafkaFactory();
    for (const topic of ['a', 'b', 'c']) joiningConsumer(factory, `messaging-consumers:${topic}`);
    const real = createFakeRuntime();
    const runtime = { ...real, setTimeout: (fn: () => void) => real.setTimeout(fn, 50) };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), { client: factory });
    await broker.connect();
    for (const topic of ['a', 'b', 'c']) await broker.subscribe(topic, () => {});

    const started = performance.now();
    await broker.disconnect();

    expect(performance.now() - started).toBeLessThan(120);
  });

  it('releases the reply inbox alongside the other consumers, disconnecting it once', async () => {
    // PR #404 review: the inbox's close awaited its own release BEFORE the
    // sweep began, so a stalled inbox join plus any other stalled join held
    // shutdown for twice the bound (~100 ms here); concurrently, ~50 ms.
    const factory = new FakeKafkaFactory();
    joiningConsumer(factory, 'messaging-consumers:orders');
    // The inbox's group is `rr-inbox-<uuid>`, so stall it as it is created.
    const create = factory.consumer.bind(factory);
    let inbox: ReturnType<typeof joiningConsumer> | null = null;
    (factory as unknown as Record<string, unknown>).consumer = (o: { groupId: string }) => {
      if (o.groupId.startsWith('rr-inbox-') && inbox === null) {
        (factory as unknown as Record<string, unknown>).consumer = create;
        inbox = joiningConsumer(factory, o.groupId);
      }
      return create(o);
    };
    const real = createFakeRuntime();
    const runtime = {
      ...real,
      // Only the release bound is shortened; RPC timeouts keep their value.
      setTimeout: (fn: () => void, ms: number) => real.setTimeout(fn, ms === 10_000 ? 50 : ms),
    };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    await broker.respond('t', () => 'ok');
    await broker.request('t', {});
    const stalled = inbox as ReturnType<typeof joiningConsumer> | null;
    if (stalled === null) throw new Error('the reply inbox was never opened');

    const started = performance.now();
    await broker.disconnect();

    expect(performance.now() - started).toBeLessThan(90);
    // Released through unsubscribe() AND the sweep; once its join settles,
    // the deferred disconnect runs exactly once.
    expect(stalled.order).toEqual([]);
    stalled.join();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stalled.order).toEqual(['joined', 'disconnect']);
  });

  it('defers the disconnect to the join when the join outlasts the bound (N1, N2)', async () => {
    // Disconnecting under a join neither stops a join that later succeeds —
    // kafkajs drops its runner while it is still joining — nor returns before
    // the pending JoinGroup is answered. So the release returns at the bound
    // and disconnects the consumer the moment its join settles.
    const factory = new FakeKafkaFactory();
    const { join, order } = joiningConsumer(factory, 'messaging-consumers:orders');
    // A runtime whose timers fire at once stands in for the bound elapsing.
    const real = createFakeRuntime();
    const runtime = { ...real, setTimeout: (fn: () => void) => real.setTimeout(fn, 0) };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});

    await broker.disconnect();
    expect(order).toEqual([]); // returned at the bound, not disconnected mid-join

    join();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['joined', 'disconnect']);
  });

  it('leaves a record delivered after the release uncommitted', async () => {
    const factory = new FakeKafkaFactory();
    joiningConsumer(factory, 'messaging-consumers:orders'); // still joining
    const real = createFakeRuntime();
    const runtime = { ...real, setTimeout: (fn: () => void) => real.setTimeout(fn, 0) };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), { client: factory });
    await broker.connect();
    const handled: unknown[] = [];
    await broker.subscribe('orders', (m) => void handled.push(m));
    await broker.disconnect();

    // The join settles and delivers before the deferred disconnect lands.
    const consumer = factory.consumer({ groupId: 'messaging-consumers:orders' });
    await consumer.deliver('orders', new FakeKafkaMessage('{"n":1}', '7', '0', {}));

    expect(handled).toEqual([]);
    expect(consumer.committedOffsets).toEqual([]);
  });
});

describe('KafkaBroker owns crash restarts (M101b security audit N2, O5)', () => {
  // kafkajs runs its own crash restart behind a timer and a group join the
  // broker cannot see, so a release during that join could neither stop nor
  // cancel it: the consumer rejoined after app.stop(). The broker's
  // `restartOnFailure` therefore always declines, and restarts the consumer
  // itself — through a timer a release clears and a run() a release waits on.
  type RetryOptions = {
    retries: number;
    restartOnFailure: (e: Error) => Promise<boolean>;
  };
  // The LAST consumer() call for the group: a test may pre-create the
  // consumer itself to instrument it, before the broker passes its options.
  function retryFor(factory: FakeKafkaFactory, groupId: string): RetryOptions {
    const call = factory.calls.findLast(
      (c) => c.method === 'consumer' && (c.args[0] as { groupId: string }).groupId === groupId,
    );
    const options = call?.args[0] as { retry?: RetryOptions } | undefined;
    if (!options?.retry) throw new Error('no retry was passed');
    return options.retry;
  }
  function crash(retryTime?: number): Error {
    return Object.assign(
      new Error('connection closed'),
      retryTime === undefined
        ? {}
        : {
            retryTime,
          },
    );
  }
  function runs(factory: FakeKafkaFactory, groupId: string): number {
    return factory.consumer({ groupId }).calls.filter((c) => c.method === 'run').length;
  }
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  it("keeps kafkajs's consumer retry count beside the hook (O5)", async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
      client: factory,
      retry: { retries: 0 },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});

    expect(retryFor(factory, 'messaging-consumers:orders').retries).toBe(5);
    await broker.disconnect();
  });

  it("declines kafkajs's restart and restarts the consumer itself", async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    const { restartOnFailure } = retryFor(factory, 'messaging-consumers:orders');

    expect(await restartOnFailure(crash(5))).toBe(false);
    expect(runs(factory, 'messaging-consumers:orders')).toBe(1);
    await tick(30);
    expect(runs(factory, 'messaging-consumers:orders')).toBe(2);
    await broker.disconnect();
  });

  it("waits the crash's retryTime, else the configured initialRetryTime", async () => {
    const factory = new FakeKafkaFactory();
    const real = createFakeRuntime();
    const delays: number[] = [];
    const runtime = {
      ...real,
      setTimeout: (fn: () => void, ms: number) => {
        delays.push(ms);
        return real.setTimeout(fn, ms);
      },
    };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), {
      client: factory,
      retry: { initialRetryTime: 77 },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    const { restartOnFailure } = retryFor(factory, 'messaging-consumers:orders');

    const hostile = Object.defineProperty(new Error('hostile'), 'retryTime', {
      get() {
        throw new Error('getter');
      },
    });
    for (const error of [crash(1234), crash(), crash(0), crash(Number.NaN), hostile]) {
      expect(await restartOnFailure(error)).toBe(false);
    }

    expect(delays).toEqual([1234, 77, 77, 77, 77]);
    await broker.disconnect(); // clears the one restart still pending
  });

  it('reads initialRetryTime: 0 as kafkajs does — 300 ms, never at once (N3)', async () => {
    // kafkajs: `e.retryTime || retry.initialRetryTime || 300`. Taking the 0
    // literally restarted ~70 times a second against a stopped broker.
    const factory = new FakeKafkaFactory();
    const real = createFakeRuntime();
    const delays: number[] = [];
    const runtime = {
      ...real,
      setTimeout: (fn: () => void, ms: number) => {
        delays.push(ms);
        return real.setTimeout(fn, ms);
      },
    };
    const broker = new KafkaBroker(runtime, new JsonSerializer(), {
      client: factory,
      retry: { initialRetryTime: 0 },
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    const { restartOnFailure } = retryFor(factory, 'messaging-consumers:orders');

    await restartOnFailure(crash());
    await restartOnFailure(crash(0));

    expect(delays).toEqual([300, 300]);
    await broker.disconnect();
  });

  it('keeps at most one restart pending, so a replaced timer never runs', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    const { restartOnFailure } = retryFor(factory, 'messaging-consumers:orders');

    await restartOnFailure(crash(5));
    await restartOnFailure(crash(40)); // replaces the 5 ms restart
    await tick(20);
    expect(runs(factory, 'messaging-consumers:orders')).toBe(1);
    await tick(40);
    expect(runs(factory, 'messaging-consumers:orders')).toBe(2);
    await broker.disconnect();
  });

  it('a release clears a scheduled restart, so the consumer is not run again', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    const { restartOnFailure } = retryFor(factory, 'messaging-consumers:orders');

    await restartOnFailure(crash(20));
    await broker.disconnect();
    await tick(50);

    expect(runs(factory, 'messaging-consumers:orders')).toBe(1);
  });

  it('a crash after unsubscribe() schedules no restart', async () => {
    const factory = new FakeKafkaFactory();
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    const sub = await broker.subscribe('orders', () => {}, { queue: 'g' });
    const { restartOnFailure } = retryFor(factory, 'g');

    await sub.unsubscribe();
    expect(await restartOnFailure(crash(1))).toBe(false);
    await tick(20);

    expect(runs(factory, 'g')).toBe(1);
    await broker.disconnect();
  });

  it("a release during the restart's join waits for that join, not the first run", async () => {
    // The N2 window: the first run() settled long ago, the restart is joining.
    const factory = new FakeKafkaFactory();
    const consumer = factory.consumer({ groupId: 'messaging-consumers:orders' });
    let join!: () => void;
    const restartJoined = new Promise<void>((resolve) => (join = resolve));
    const order: string[] = [];
    const run = consumer.run.bind(consumer);
    let calls = 0;
    (consumer as unknown as Record<string, unknown>).run = (o: Parameters<typeof run>[0]) => {
      void run(o);
      return ++calls === 1
        ? Promise.resolve()
        : restartJoined.then(() => void order.push('joined'));
    };
    const disconnect = consumer.disconnect.bind(consumer);
    (consumer as unknown as Record<string, unknown>).disconnect = () => {
      order.push('disconnect');
      return disconnect();
    };
    const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), { client: factory });
    await broker.connect();
    await broker.subscribe('orders', () => {});
    await retryFor(factory, 'messaging-consumers:orders').restartOnFailure(crash(1));
    await tick(20); // the restart has begun and is joining
    expect(calls).toBe(2);

    const stopping = broker.disconnect();
    await tick(10);
    expect(order).toEqual([]);
    join();
    await stopping;

    expect(order).toEqual(['joined', 'disconnect']);
  });
});

describe('KafkaBroker — the guarded import (M113d §3.1)', () => {
  it('connect rejects with OptionalDependencyUnavailableError when the peer is absent', async () => {
    const { KafkaBroker } = await import('../../src/brokers/kafka-broker.ts');
    const { JsonSerializer } = await import('../../src/serializers/json-serializer.ts');
    const { createFakeRuntime } = await import('../fixtures/fake-runtime.ts');
    vi.doMock('kafkajs', () => {
      throw new Error('Cannot find package');
    });
    try {
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer());
      let caught: unknown;
      try {
        await broker.connect();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('kafkajs');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('kafkajs');
    }
  });
});
