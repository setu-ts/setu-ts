/**
 * RabbitMQ message durability: persistent publishes and publisher confirms.
 *
 * Before 0.9.0 the broker declared durable consumer-group queues and then
 * published TRANSIENT messages on a plain channel, so a RabbitMQ restart
 * emptied every queue of unconsumed messages while `publish()` had already
 * resolved. Measured against RabbitMQ 4.3.5: 5 messages → 0 after a restart.
 * These tests pin the wire properties and the confirm semantics; the restart
 * itself is proven against a real broker in `durability-real.test.ts`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IPlugin } from '@setu-ts/common';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  RabbitMqBroker,
  resolvePublishTimeoutMs,
} from '../../src/brokers/rabbitmq-broker.ts';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import type { IAmqpConnection, RabbitMqOptions } from '../../src/interfaces/index.ts';
import {
  type FakeAmqpChannel,
  FakeAmqpConnection,
  type FakeAmqpOptions,
} from '../fixtures/fake-amqplib-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A logger whose state lives in a private field, like `logger-plugin`'s. */
class PrivateFieldLogger {
  #lines: string[] = [];
  error(message: string): void {
    this.#lines.push(`error:${message}`);
  }
  warn(message: string): void {
    this.#lines.push(`warn:${message}`);
  }
  get lines(): readonly string[] {
    return this.#lines;
  }
}

async function connected(
  fake: FakeAmqpOptions = {},
  options: Omit<RabbitMqOptions, 'client'> = {},
): Promise<{ broker: RabbitMqBroker; channel: FakeAmqpChannel; connection: FakeAmqpConnection }> {
  const connection = new FakeAmqpConnection(fake);
  const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
    ...options,
    client: connection as unknown as IAmqpConnection,
  });
  await broker.connect();
  const channel = await connection.createChannel();
  return { broker, channel, connection };
}

function publishedProperties(channel: FakeAmqpChannel): Record<string, unknown>[] {
  return channel.calls
    .filter((call) => call.method === 'publish')
    .map((call) => call.args[3] as Record<string, unknown>);
}

/** Resolves after `ms` of real time (the fake runtime's timers are real). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('RabbitMqBroker durability', () => {
  it('publishes persistent messages by default', async () => {
    const { broker, channel } = await connected();
    await broker.publish('orders.created', { id: 1 });
    const [properties] = publishedProperties(channel);
    expect(properties?.persistent).toBe(true);
    await broker.disconnect();
  });

  it('persistentMessages: false publishes exactly the pre-0.9.0 properties', async () => {
    const { broker, channel } = await connected({}, { persistentMessages: false });
    await broker.publish('orders.created', { id: 1 });
    const [properties] = publishedProperties(channel);
    // ABSENT, not `false`: the opt-out must put the same bytes on the wire as
    // every earlier release did.
    expect(properties !== undefined && 'persistent' in properties).toBe(false);
    expect(Object.keys(properties ?? {}).sort()).toEqual(['headers', 'messageId']);
    await broker.disconnect();
  });

  it('publishes on a confirm channel and resolves only once the broker accepts', async () => {
    const { broker, channel } = await connected({ withholdConfirms: true });
    expect(channel.confirmMode).toBe(true);
    let settled = false;
    const publishing = broker.publish('orders.created', { id: 1 }).then(() => {
      settled = true;
    });
    await sleep(10);
    expect(settled).toBe(false);
    channel.releaseConfirms();
    await publishing;
    expect(settled).toBe(true);
    await broker.disconnect();
  });

  it('rejects when the broker refuses the message, naming the destination and the cause', async () => {
    const refusal = new Error('channel closed');
    const { broker } = await connected({ confirmError: refusal });
    const error = await broker.publish('orders.created', { id: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('exchange "messaging"');
    expect((error as Error).message).toContain('routing key "orders.created"');
    expect((error as Error).message).toContain('channel closed');
    expect((error as Error).cause).toBe(refusal);
    await broker.disconnect();
  });

  it('rejects (never throws) when the channel is already closed', async () => {
    // amqplib throws SYNCHRONOUSLY from publish() on a closed channel.
    const { broker } = await connected({ rejectPublish: true });
    const outcome = broker.publish('orders.created', { id: 1 });
    expect(outcome).toBeInstanceOf(Promise);
    await expect(outcome).rejects.toThrow('Publish failed');
    await broker.disconnect();
  });

  it('bounds a confirm that never arrives', async () => {
    const { broker, channel } = await connected(
      { withholdConfirms: true },
      { publishTimeoutMs: 20 },
    );
    await expect(broker.publish('orders.created', { id: 1 })).rejects.toThrow(
      'within 20 ms (publishTimeoutMs); it may still be accepted',
    );
    channel.releaseConfirms();
    await broker.disconnect();
  });

  it('bounds the exchange assert as well — a paused broker never answers it', async () => {
    // Measured on a paused RabbitMQ: the per-publish exchange assert is the
    // call that hangs, before any confirm exists, so a bound around the confirm
    // alone never armed. connect() must succeed first, so the assert is made to
    // hang only afterwards.
    const { broker, channel } = await connected({}, { publishTimeoutMs: 20 });
    (channel as unknown as { assertExchange: () => Promise<void> }).assertExchange = () =>
      new Promise<void>(() => {});
    await expect(broker.publish('orders.created', { id: 1 })).rejects.toThrow(
      'within 20 ms (publishTimeoutMs)',
    );
    expect(publishedProperties(channel).length).toBe(0);
    await broker.disconnect();
  });

  it('publishTimeoutMs: 0 waits without a bound', async () => {
    const { broker, channel } = await connected(
      { withholdConfirms: true },
      { publishTimeoutMs: 0 },
    );
    let settled = false;
    const publishing = broker.publish('orders.created', { id: 1 }).finally(() => {
      settled = true;
    });
    await sleep(30);
    expect(settled).toBe(false);
    channel.releaseConfirms();
    await publishing;
    await broker.disconnect();
  });

  it('defaults the bound to 15 s and refuses an out-of-range value', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15_000);
    expect(resolvePublishTimeoutMs(undefined)).toBe(15_000);
    expect(resolvePublishTimeoutMs(0)).toBe(0);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => resolvePublishTimeoutMs(bad)).toThrow(RangeError);
      expect(() =>
        new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), { publishTimeoutMs: bad })
      ).toThrow('publishTimeoutMs');
    }
  });

  describe('a facade without createConfirmChannel()', () => {
    it('keeps a plain channel and warns once through the logger as a METHOD', async () => {
      const logger = new PrivateFieldLogger();
      const { broker, channel } = await connected(
        { withoutConfirmChannel: true },
        { logger },
      );
      expect(channel.confirmMode).toBe(false);
      await broker.publish('orders.created', { id: 1 });
      await broker.publish('orders.created', { id: 2 });
      // Still persistent: durability of the message does not depend on confirms.
      expect(publishedProperties(channel).every((p) => p.persistent === true)).toBe(true);
      expect(logger.lines.length).toBe(1);
      expect(logger.lines[0]).toMatch(/^warn:.*NOT confirmed/);
      await broker.disconnect();
    });

    it('falls back to error() when the logger has no warn()', async () => {
      const lines: string[] = [];
      const { broker } = await connected(
        { withoutConfirmChannel: true },
        { logger: { error: (message) => lines.push(message) } },
      );
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('createConfirmChannel()');
      await broker.disconnect();
    });

    it('stays silent with no logger at all', async () => {
      const { broker } = await connected({ withoutConfirmChannel: true });
      await broker.publish('orders.created', { id: 1 });
      expect(broker.isReady()).toBe(true);
      await broker.disconnect();
    });
  });
});

describe('MessagingPlugin RabbitMQ durability options', () => {
  function fakeRuntimePlugin(): IPlugin {
    const runtime = createFakeRuntime();
    return {
      name: 'fake-runtime',
      version: '1.0.0',
      provides: [CAPABILITIES.RUNTIME],
      register(ctx) {
        ctx.services.register(CAPABILITIES.RUNTIME, runtime);
      },
    };
  }

  it('refuses a bad publishTimeoutMs when MessagingPlugin(...) is called', () => {
    expect(() => MessagingPlugin({ broker: 'rabbitmq', publishTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('refuses a non-boolean persistentMessages when MessagingPlugin(...) is called', () => {
    expect(() =>
      MessagingPlugin({
        broker: 'rabbitmq',
        persistentMessages: 'yes' as unknown as boolean,
      })
    ).toThrow(TypeError);
  });

  it('does not validate RabbitMQ options for another broker', () => {
    expect(() => MessagingPlugin({ broker: 'memory', publishTimeoutMs: Number.NaN } as never)).not
      .toThrow();
  });

  it('threads both options into the broker through a real kernel app', async () => {
    const connection = new FakeAmqpConnection({ withholdConfirms: true });
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        MessagingPlugin({
          broker: 'rabbitmq',
          client: connection as unknown as IAmqpConnection,
          tracing: false,
          persistentMessages: false,
          publishTimeoutMs: 25,
        }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
    // publishTimeoutMs reached the broker: a withheld confirm times out at 25 ms.
    await expect(broker.publish('orders.created', { id: 1 })).rejects.toThrow(
      'within 25 ms (publishTimeoutMs)',
    );
    // persistentMessages reached the broker: no `persistent` property.
    const channel = await connection.createChannel();
    const properties = publishedProperties(channel);
    expect(properties.length).toBe(1);
    expect('persistent' in (properties[0] ?? {})).toBe(false);
    channel.releaseConfirms();
    await app.stop();
  });

  it('routes the unconfirmed-channel warning to the registered logger', async () => {
    const logger = new PrivateFieldLogger();
    const loggerPlugin: IPlugin = {
      name: 'test-logger',
      version: '1.0.0',
      provides: ['logger'],
      register(ctx) {
        ctx.services.register('logger', logger);
      },
    };
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        loggerPlugin,
        MessagingPlugin({
          broker: 'rabbitmq',
          client: new FakeAmqpConnection({
            withoutConfirmChannel: true,
          }) as unknown as IAmqpConnection,
          tracing: false,
        }),
      ],
    });
    await app.start();
    expect(logger.lines.some((line) => line.startsWith('warn:') && line.includes('NOT confirmed')))
      .toBe(true);
    await app.stop();
  });
});
