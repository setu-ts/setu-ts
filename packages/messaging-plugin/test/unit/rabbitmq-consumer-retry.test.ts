import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { IntegrationEventRejectedError, MessagingPlugin } from '../../src/index.ts';
import type { RabbitMqOptions } from '../../src/index.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { REPLY_INBOX_TRANSIENT } from '../../src/brokers/inbox.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';

describe('RabbitMQ consumer retry', () => {
  for (
    const [label, characters] of [
      ['CR/LF', '\r\n'],
      ['NUL', '\0'],
      ['terminal controls', '\x1b\x7f'],
      ['bidi format', '\u202e'],
      ['zero-width format', '\u200d'],
      ['line/paragraph separators', '\u2028\u2029'],
      ['printable names', '-'],
    ]
  ) {
    it(`normalizes ${label} in dead-letter logs while preserving routing names`, async () => {
      const logs: string[] = [];
      const client = new FakeAmqpConnection();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        consumerRetry: { maxAttempts: 1, delaysMs: [10] },
        logger: { error: (message) => logs.push(message) },
      });
      const queue = `queue${characters}FORGED`;
      const topic = `topic${characters}FORGED`;
      await broker.connect();
      try {
        await broker.subscribe(topic, (message) => {
          if (message === 1) throw Error('failure\nFORGED');
        }, { queue });
        const channel = await client.createChannel();
        await channel.deliver('1');
        expect(logs).toHaveLength(1);
        expect(logs[0]).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        expect(logs[0]).toContain('RabbitMQ dead-lettered to "queue');
        expect(logs[0]).toContain('FORGED.dead", topic "topic');
        expect(logs[0]).toContain('Error: failure FORGED');
        const copy = channel.calls.find((call) => call.method === 'publish')!;
        expect(copy.args[1]).toBe(`${queue}.dead`);
        expect((copy.args[3] as { headers: Record<string, unknown> }).headers['x-setu-topic'])
          .toBe(topic);
        await channel.deliver('2');
        expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(2);
        expect(channel.calls.filter((call) => call.method === 'publish')).toHaveLength(1);
      } finally {
        await broker.disconnect();
      }
    });
  }

  it('bounds the complete dead-letter diagnostic including a long topic', async () => {
    const logs: string[] = [];
    const client = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      consumerRetry: { maxAttempts: 1, delaysMs: [10] },
      logger: { error: (message) => logs.push(message) },
    });
    await broker.connect();
    try {
      await broker.subscribe('topic-🙂'.repeat(2000), () => {
        throw Error('temporary');
      }, { queue: 'q' });
      const channel = await client.createChannel();
      await channel.deliver('1');
      expect(logs).toHaveLength(1);
      expect([...logs[0]!].length).toBeLessThanOrEqual(8192);
      expect(logs[0]).toMatch(/… \[truncated\]$/u);
      expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(1);
    } finally {
      await broker.disconnect();
    }
  });

  it('does not publish if the deadline expires before its scheduled publish starts', async () => {
    const client = new FakeAmqpConnection();
    const runtime = createFakeRuntime();
    runtime.setTimeout = (fn, _ms) => {
      fn();
      return 0;
    };
    runtime.clearTimeout = (_handle) => {};
    const broker = new RabbitMqBroker(runtime, new JsonSerializer(), { client });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('temporary');
    }, { queue: 'q' });
    const channel = await client.createChannel();
    await channel.deliver('1');
    expect(channel.calls.some((c) => ['publish', 'ack', 'nack'].includes(c.method))).toBe(false);
    expect(channel.listenerCount('return')).toBe(0);
    expect(channel.listenerCount('close')).toBe(0);
    await broker.disconnect();
  });
  it('a hung retry publish reaches its deadline without acking, then a late confirm does not ack', async () => {
    const clock = clockRuntime();
    const logs: string[] = [];
    const client = new FakeAmqpConnection({ withholdConfirms: true });
    const broker = new RabbitMqBroker(clock.runtime, new JsonSerializer(), {
      client,
      publishTimeoutMs: 17,
      logger: { error: (text) => logs.push(text) },
    });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('temporary');
    }, { queue: 'q' });
    const channel = await client.createChannel();
    let settled = false;
    const delivery = channel.deliver('1').then(() => settled = true);
    await clock.advance(0);
    expect(channel.calls.some((c) => c.method === 'publish')).toBe(true);
    expect(settled).toBe(false);
    await clock.advance(16);
    expect(settled).toBe(false);
    await clock.advance(1);
    await delivery;
    expect(channel.listenerCount('return')).toBe(0);
    expect(channel.listenerCount('close')).toBe(0);
    channel.releaseConfirms();
    expect(channel.calls.some((c) => c.method === 'ack' || c.method === 'nack')).toBe(false);
    expect(logs.some((l) => l.includes('original remains unacked'))).toBe(true);
    await broker.disconnect();
    expect(clock.timerCount()).toBe(0);
  });

  it('correlates returned copies even with identical targets and message IDs, without acking them', async () => {
    const client = new FakeAmqpConnection({ withholdConfirms: true });
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('temporary');
    }, { queue: 'q' });
    const channel = await client.createChannel();
    const first = channel.deliver('1', { messageId: 'same' });
    const second = channel.deliver('2', { messageId: 'same' });
    await new Promise((r) => setTimeout(r, 0));
    const publications = channel.calls.filter((c) => c.method === 'publish');
    expect(publications).toHaveLength(2);
    const [one, two] = publications.map((c) =>
      c.args[3] as { mandatory: boolean; headers: Record<string, unknown> }
    );
    expect(one!.mandatory).toBe(true);
    expect(two!.mandatory).toBe(true);
    expect(one!.headers['x-setu-disposition-id']).not.toBe(two!.headers['x-setu-disposition-id']);
    for (
      const unrelated of [undefined, {}, { properties: { headers: {} } }, {
        properties: { headers: Object.create(one!.headers) },
      }]
    ) channel.emitReturn(unrelated);
    expect(channel.listenerCount('return')).toBe(2);
    channel.emitReturn({ properties: one });
    await first;
    expect(channel.calls.some((c) => c.method === 'ack')).toBe(false);
    expect(channel.listenerCount('return')).toBe(1);
    channel.releaseConfirms();
    await second;
    const acks = channel.calls.filter((c) => c.method === 'ack');
    expect(acks).toHaveLength(1);
    expect(new TextDecoder().decode((acks[0]!.args[0] as { content: Uint8Array }).content)).toBe(
      '2',
    );
    expect(channel.listenerCount('return')).toBe(0);
    expect(channel.listenerCount('close')).toBe(0);
    await broker.disconnect();
  });

  for (const missing of ['confirms', 'listeners', 'hostile return'] as const) {
    it(`keeps the original unacked with ${missing}`, async () => {
      const client = new FakeAmqpConnection({
        withoutConfirmChannel: missing === 'confirms',
        withholdConfirms: missing === 'hostile return',
      });
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      await broker.subscribe('t', () => {
        throw Error('temporary');
      }, { queue: 'q' });
      const channel = await client.createChannel();
      if (missing === 'listeners') Object.defineProperty(channel, 'on', { value: undefined });
      const delivery = channel.deliver('1');
      if (missing === 'hostile return') {
        await new Promise((r) => setTimeout(r, 0));
        const proxy = Proxy.revocable({}, {});
        proxy.revoke();
        channel.emitReturn(proxy.proxy);
      }
      await delivery;
      channel.releaseConfirms();
      expect(channel.calls.some((c) => c.method === 'ack' || c.method === 'nack')).toBe(false);
      expect(channel.listenerCount('return')).toBe(0);
      await broker.disconnect();
    });
  }

  for (const queue of ['orders.dead', 'orders.retry.200ms', 'é'.repeat(121)]) {
    it(`refuses reserved/oversized queue ${queue.length} before declaring it`, async () => {
      const client = new FakeAmqpConnection();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      const channel = await client.createChannel();
      await expect(broker.subscribe('t', () => {}, { queue })).rejects.toThrow(RangeError);
      expect(() =>
        MessagingPlugin({
          broker: 'rabbitmq',
          subscriptions: [{
            topic: 't',
            handler: () => {},
            options: { queue },
          }],
        })
      ).toThrow(RangeError);
      expect(channel.calls.some((c) => c.method === 'assertQueue')).toBe(false);
      await broker.subscribe('ok', () => {}, { queue: 'orders' });
      await channel.deliver('1', {}, 'orders');
      expect(channel.calls.filter((c) => c.method === 'ack')).toHaveLength(1);
      await broker.disconnect();
    });
  }

  for (const queues of [['orders', 'orders.dead'], ['orders.dead', 'orders']] as const) {
    it(`preflights declarative collisions with ${queues[0]} first`, () => {
      expect(() =>
        MessagingPlugin({
          broker: 'rabbitmq',
          subscriptions: queues.map((queue) => ({
            topic: queue,
            handler: () => {},
            options: { queue },
          })),
        })
      ).toThrow(RangeError);
    });
  }

  it('allows helper-like groups when retries are disabled and transient reply names', async () => {
    const client = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      consumerRetry: false,
    });
    await broker.connect();
    await broker.subscribe('t', () => {}, { queue: 'orders.dead' });
    await broker.disconnect();
    const reply = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await reply.connect();
    const replyOptions = { queue: 'orders.dead', [REPLY_INBOX_TRANSIENT]: true };
    await reply.subscribe('t', () => {}, replyOptions);
    await reply.subscribe('t', () => {}, { queue: 'é'.repeat(117) });
    await reply.disconnect();
    expect(() =>
      MessagingPlugin({
        broker: 'rabbitmq',
        consumerRetry: false,
        subscriptions: [{
          topic: 't',
          handler: () => {},
          options: { queue: 'orders.dead' },
        }],
      })
    ).not.toThrow();
  });

  for (const attempt of [1, 5]) {
    it(`does not ack a returned ${attempt === 1 ? 'retry' : 'dead letter'} despite a positive confirm`, async () => {
      const client = new FakeAmqpConnection({ returnMandatory: true });
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      await broker.subscribe('t', () => {
        throw Error('temporary');
      }, { queue: 'q' });
      const channel = await client.createChannel();
      await channel.deliver('1', { headers: { 'x-setu-attempt': attempt } });
      expect(channel.calls.some((c) => c.method === 'ack' || c.method === 'nack')).toBe(false);
      expect(channel.listenerCount('return')).toBe(0);
      expect(channel.listenerCount('close')).toBe(0);
      await broker.disconnect();
    });
  }

  it('settles on the delivery channel when disconnect occurs while a confirm is pending', async () => {
    const client = new FakeAmqpConnection({ withholdConfirms: true });
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('temporary');
    }, { queue: 'q' });
    const channel = await client.createChannel();
    const delivery = channel.deliver('1');
    await new Promise((r) => setTimeout(r, 0));
    expect(channel.calls.some((c) => c.method === 'ack')).toBe(false);
    await broker.disconnect();
    channel.releaseConfirms();
    await delivery;
    expect(channel.calls.filter((c) => c.method === 'ack')).toHaveLength(1);
  });
  for (
    const [name, options] of Object.entries({
      zero: { consumerRetry: { maxAttempts: 0 } },
      nan: { consumerRetry: { maxAttempts: NaN } },
      fractional: { consumerRetry: { maxAttempts: 1.5 } },
      unsafe: { consumerRetry: { maxAttempts: Number.MAX_SAFE_INTEGER + 1 } },
      empty: { consumerRetry: { delaysMs: [] } },
      decreasing: { consumerRetry: { delaysMs: [3, 2] } },
      negative: { consumerRetry: { delaysMs: [-1] } },
      nanDelay: { consumerRetry: { delaysMs: [NaN] } },
      fractionalDelay: { consumerRetry: { delaysMs: [1.1] } },
      overflowDelay: { consumerRetry: { delaysMs: [2147483648] } },
      cap: { deadLetterMaxLength: 0 },
      nanCap: { deadLetterMaxLength: NaN },
      prefetch: { prefetch: 0 },
      qosOverflow: { prefetch: 65536 },
      fractionalQos: { prefetch: 1.5 },
      nanQos: { prefetch: NaN },
      badClassifier: { consumerRetry: { isRetryable: 7 } },
      badPolicy: { consumerRetry: true },
    })
  ) {
    it(`refuses ${name} at broker AND plugin construction`, () => {
      const invalid = options as RabbitMqOptions;
      expect(() => new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), invalid))
        .toThrow(RangeError);
      expect(() => MessagingPlugin({ broker: 'rabbitmq', ...invalid })).toThrow(RangeError);
    });
  }

  it('declares distinct tiers, preserves bytes/properties/prototype-safe headers, confirms BEFORE ack', async () => {
    const client = new FakeAmqpConnection({ withholdConfirms: true });
    const delays = [200, 800, 800];
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      consumerRetry: { delaysMs: delays },
      persistentMessages: false,
    });
    await broker.connect();
    await broker.subscribe('t', () => {
      throw Error('temporary');
    }, { queue: 'q' });
    delays[0] = 1;
    const channel = await client.createChannel();
    const headers = { traceparent: 'trace', ['__proto__']: 'safe', binary: new Uint8Array([1]) };
    expect(Object.hasOwn(headers, '__proto__')).toBe(true);
    let settled = false;
    const delivery = channel.deliver('{"m":1}', {
      messageId: 'm1',
      timestamp: 42,
      headers,
      expiration: '5',
    }).then(() => settled = true);
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(channel.calls.some((c) => c.method === 'ack')).toBe(false);
    const publication = channel.calls.find((c) => c.method === 'publish')!;
    expect(publication.args.slice(0, 2)).toEqual(['', 'q.retry.200ms']);
    const props = publication.args[3] as Record<string, unknown>;
    expect(props.messageId).toBe('m1');
    expect(props.timestamp).toBe(42);
    expect(props.persistent).toBe(true);
    expect(Object.hasOwn(props, 'expiration')).toBe(false);
    const copied = props.headers as Record<string, unknown>;
    expect(copied['x-setu-attempt']).toBe(2);
    expect(copied.traceparent).toBe('trace');
    expect(Object.hasOwn(copied, '__proto__')).toBe(true);
    expect(copied['__proto__']).toBe('safe');
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(headers, 'x-setu-attempt')).toBe(false);
    channel.releaseConfirms();
    await delivery;
    const order = channel.calls.filter((c) => ['publish', 'ack', 'nack'].includes(c.method));
    expect(order.map((c) => c.method)).toEqual(['publish', 'ack']);
    expect(channel.calls.filter((c) => c.method === 'assertQueue').map((c) => c.args[0]))
      .toEqual(['q', 'q.retry.200ms', 'q.retry.800ms', 'q.dead']);
    expect(channel.calls.find((c) => c.method === 'prefetch')?.args).toEqual([32]);
    await broker.disconnect();
  });

  for (
    const [name, body, header, error, classifier, target, attempts] of [
      ['tier two', '1', 2, Error('temporary'), undefined, 'q.retry.800ms', 3],
      ['last tier', '1', 4, Error('temporary'), undefined, 'q.retry.800ms', 5],
      ['budget', '1', 5, Error('poison'), undefined, 'q.dead', 5],
      ['over budget', '1', 8, Error('poison'), undefined, 'q.dead', 8],
      [
        'deserialize',
        '{',
        undefined,
        Error('unused'),
        () => {
          throw Error('must not run');
        },
        'q.dead',
        1,
      ],
      [
        'integration rejection',
        '1',
        undefined,
        new IntegrationEventRejectedError({
          topic: 't',
          reason: 'malformed',
          expectedType: 'event',
          expectedVersion: 1,
          detail: 'bad',
        }),
        () => {
          throw Error('must not run');
        },
        'q.dead',
        1,
      ],
      ['application refusal', '1', undefined, Error('invalid'), () => false, 'q.dead', 1],
      [
        'classifier throws',
        '1',
        undefined,
        Error('temporary'),
        () => {
          throw Error('classifier');
        },
        'q.retry.200ms',
        2,
      ],
      ['invalid attempt', '1', '2', Error('invalid'), undefined, 'q.dead', 1],
      ['nan attempt', '1', NaN, Error('invalid'), undefined, 'q.dead', 1],
      ['negative attempt', '1', -1, Error('invalid'), undefined, 'q.dead', 1],
      ['utf8 error bound', '1', 5, Error('😀'.repeat(2000)), undefined, 'q.dead', 5],
      ['throw undefined', '1', undefined, undefined, undefined, 'q.retry.200ms', 2],
    ] as const
  ) {
    it(name, async () => {
      const logs: string[] = [];
      let classifications = 0;
      const client = new FakeAmqpConnection();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        logger: { error: (text) => logs.push(text) },
        consumerRetry: {
          delaysMs: [200, 800],
          ...(classifier === undefined ? {} : {
            isRetryable: () => {
              classifications++;
              return classifier();
            },
          }),
        },
      });
      await broker.connect();
      await broker.subscribe('t', () => {
        throw error;
      }, { queue: 'q' });
      const channel = await client.createChannel();
      await channel.deliver(body, { headers: { 'x-setu-attempt': header, traceparent: 'trace' } });
      const pub = channel.calls.find((c) => c.method === 'publish')!;
      expect(pub.args[1]).toBe(target);
      const headers = (pub.args[3] as { headers: Record<string, unknown> }).headers;
      expect(headers[target === 'q.dead' ? 'x-setu-attempts' : 'x-setu-attempt']).toBe(attempts);
      if (target === 'q.dead') {
        expect(headers['x-setu-topic']).toBe('t');
        expect(new TextEncoder().encode(headers['x-setu-error'] as string).length)
          .toBeLessThanOrEqual(1024);
      }
      if (name === 'deserialize' || name === 'integration rejection') {
        expect(classifications).toBe(0);
      }
      if (name === 'classifier throws') {
        expect(logs.some((l) => l.includes('classifier failed'))).toBe(true);
      }
      expect(
        channel.calls.filter((c) => ['publish', 'ack', 'nack'].includes(c.method)).map((c) =>
          c.method
        ),
      )
        .toEqual(['publish', 'ack']);
      await broker.disconnect();
    });
  }

  for (
    const mode of ['confirm refusal', 'sync publish failure', 'ack failure', 'success'] as const
  ) {
    it(`disposes once on ${mode}`, async () => {
      const client = new FakeAmqpConnection({
        ...(mode === 'confirm refusal' ? { confirmError: Error('refused') } : {}),
        ...(mode === 'sync publish failure' ? { rejectPublish: true } : {}),
      });
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      await broker.subscribe('t', () => {
        if (mode !== 'success') throw Error('temporary');
      }, { queue: 'q' });
      const channel = await client.createChannel();
      if (mode === 'ack failure') {
        channel.ack = () => {
          throw Error('closed');
        };
      }
      await channel.deliver('1');
      expect(channel.calls.some((c) => c.method === 'nack')).toBe(false);
      expect(channel.calls.filter((c) => c.method === 'publish')).toHaveLength(
        mode === 'success' ? 0 : 1,
      );
      expect(channel.calls.filter((c) => c.method === 'ack')).toHaveLength(
        mode === 'success' ? 1 : 0,
      );
      await broker.disconnect();
    });
  }

  for (const kind of ['off', 'private', 'reply'] as const) {
    it(`retains nack-and-discard for ${kind}`, async () => {
      const client = new FakeAmqpConnection();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        ...(kind === 'off' ? { consumerRetry: false } : {}),
      });
      await broker.connect();
      await broker.subscribe(
        't',
        () => {
          throw Error('failed');
        },
        kind === 'private' ? undefined : {
          queue: 'q',
          ...(kind === 'reply' ? { [REPLY_INBOX_TRANSIENT]: true } : {}),
        },
      );
      const channel = await client.createChannel();
      await channel.deliver('1');
      expect(channel.calls.filter((c) => c.method === 'assertQueue')).toHaveLength(1);
      expect(channel.calls.filter((c) => c.method === 'nack')[0]?.args.slice(1)).toEqual([
        false,
        false,
      ]);
      expect(channel.calls.some((c) => c.method === 'publish' || c.method === 'ack')).toBe(false);
      await broker.disconnect();
    });
  }
});
