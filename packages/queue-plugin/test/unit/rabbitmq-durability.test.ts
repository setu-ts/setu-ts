/**
 * RabbitMQ job durability: persistent publishes and publisher confirms.
 *
 * Before 0.9.0 every job was published TRANSIENT into durable queues on a plain
 * channel, so a RabbitMQ restart silently discarded every job not yet processed
 * — measured against RabbitMQ 4.3.5: 5 jobs → 0 after a restart — while
 * `add()` had already resolved. These tests pin the wire properties at all
 * four publish sites, the confirm semantics, and the ack-after-accept order of
 * a retry and a dead-letter; the restart itself is proven against a real broker
 * in `durability-real.test.ts`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IQueue } from '@setu-ts/common';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  RabbitMqQueue,
  resolvePublishTimeoutMs,
} from '../../src/adapters/rabbitmq-queue.ts';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import type { RabbitMqQueueOptions, StoredJob } from '../../src/interfaces/index.ts';
import {
  type FakeAmqpQueueChannel,
  FakeAmqpQueueConnection,
  type FakeAmqpQueueOptions,
} from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

async function connected(
  fake: FakeAmqpQueueOptions = {},
  options: Omit<RabbitMqQueueOptions, 'client'> = {},
): Promise<{
  queue: RabbitMqQueue;
  channel: FakeAmqpQueueChannel;
  runtime: FakeRuntimeServices;
}> {
  const runtime = new FakeRuntimeServices();
  const connection = new FakeAmqpQueueConnection(fake);
  const queue = new RabbitMqQueue(runtime, { ...options, client: connection });
  await queue.connect();
  return { queue, channel: await connection.createChannel(), runtime };
}

function job(runtime: FakeRuntimeServices, id: string, delayMs = 0): StoredJob<unknown> {
  return {
    id,
    name: 'emails',
    data: { id },
    attempts: 0,
    maxAttempts: 3,
    availableAtMs: runtime.now() + delayMs,
  };
}

function publishes(channel: FakeAmqpQueueChannel): { queue: string; options: unknown }[] {
  return channel.calls
    .filter((call) => call.method === 'publish')
    .map((call) => ({ queue: call.args[1] as string, options: call.args[3] }));
}

function acks(channel: FakeAmqpQueueChannel): number {
  return channel.calls.filter((call) => call.method === 'ack').length;
}

/** Lets queued microtasks (a delivered confirm) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Settles `call` as a string after first proving it is STILL PENDING once all
 * immediate work has run, then advances the fake clock past the bound.
 *
 * The pending check is load-bearing: `advanceMs` jumps the clock before queued
 * microtasks run, so without it the deadline wins the race even for a publish
 * that never waits on the broker — a version of this test that skipped it
 * passed with confirms disabled entirely.
 */
async function outcomeAfterBound(
  runtime: FakeRuntimeServices,
  call: Promise<unknown>,
  advanceMs: number,
): Promise<string> {
  let done = false;
  const outcome = call.then(() => 'resolved', (e: Error) => e.message).finally(() => {
    done = true;
  });
  await settle();
  expect(done).toBe(false);
  await runtime.advanceMs(advanceMs);
  return await outcome;
}

describe('RabbitMqQueue durability', () => {
  it('publishes every job persistent at all four publish sites', async () => {
    const { queue, channel, runtime } = await connected();
    await queue.enqueue(job(runtime, 'ready'));
    await queue.enqueue(job(runtime, 'delayed', 5_000));
    const [first] = await queue.reserve('emails', 1, runtime.now());
    await queue.requeue('emails', first!.id, runtime.now() + 1_000, 1);
    await queue.enqueue(job(runtime, 'doomed'));
    const [doomed] = await queue.reserve('emails', 1, runtime.now());
    await queue.deadLetter('emails', doomed!.id, runtime.now());

    const sent = publishes(channel);
    expect(sent.map((p) => p.queue)).toEqual([
      'he.queue.emails.ready',
      'he.queue.emails.delay',
      'he.queue.emails.delay',
      'he.queue.emails.ready',
      'he.queue.emails.dead',
    ]);
    for (const publish of sent) {
      expect((publish.options as { persistent?: unknown }).persistent).toBe(true);
    }
    // The site-specific options survive beside `persistent`.
    expect((sent[1]!.options as { expiration?: number }).expiration).toBe(5_000);
    expect((sent[4]!.options as { timestamp?: number }).timestamp).toBe(runtime.now());
    await queue.disconnect();
  });

  it('persistentMessages: false publishes exactly the pre-0.9.0 options', async () => {
    const { queue, channel, runtime } = await connected({}, { persistentMessages: false });
    await queue.enqueue(job(runtime, 'ready'));
    await queue.enqueue(job(runtime, 'delayed', 5_000));
    const sent = publishes(channel);
    expect(sent[0]!.options).toEqual({});
    expect(sent[1]!.options).toEqual({ expiration: 5_000 });
    await queue.disconnect();
  });

  it('enqueue resolves only once the broker accepts the job', async () => {
    const { queue, channel, runtime } = await connected({ withholdConfirms: true });
    expect(channel.confirmMode).toBe(true);
    let settled = false;
    const enqueueing = queue.enqueue(job(runtime, 'a')).then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    channel.releaseConfirms();
    await enqueueing;
    expect(settled).toBe(true);
    await queue.disconnect();
  });

  it('enqueue rejects when the broker refuses the job, carrying the cause', async () => {
    const refusal = new Error('channel closed');
    const { queue, runtime } = await connected({ confirmError: refusal });
    const error = await queue.enqueue(job(runtime, 'a')).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain('queue "he.queue.emails.ready"');
    expect((error as Error).message).toContain('channel closed');
    expect((error as Error).cause).toBe(refusal);
    await queue.disconnect();
  });

  it('a non-Error refusal is described rather than dropped', async () => {
    const { queue, runtime } = await connected({
      confirmError: 'nacked' as unknown as Error,
    });
    await expect(queue.enqueue(job(runtime, 'a'))).rejects.toThrow('nacked');
    await queue.disconnect();
  });

  it('a refused retry leaves the reserved job UNACKED, so RabbitMQ can redeliver it', async () => {
    const { queue, channel, runtime } = await connected();
    await queue.enqueue(job(runtime, 'a'));
    const [reserved] = await queue.reserve('emails', 1, runtime.now());
    // From here on, the broker refuses every publish.
    const original = channel.publish.bind(channel);
    channel.publish = (exchange, key, content, options, confirm) => {
      const accepted = original(exchange, key, content, options);
      queueMicrotask(() => confirm?.(new Error('refused')));
      return accepted;
    };
    const before = acks(channel);
    await expect(queue.requeue('emails', reserved!.id, runtime.now() + 10, 1)).rejects.toThrow(
      'refused',
    );
    expect(acks(channel)).toBe(before);
    await expect(queue.deadLetter('emails', reserved!.id, runtime.now())).rejects.toThrow(
      'refused',
    );
    expect(acks(channel)).toBe(before);
    await queue.disconnect();
  });

  it('acks a retry and a dead-letter only AFTER the replacement is accepted', async () => {
    const { queue, channel, runtime } = await connected({ withholdConfirms: true });
    const enqueueing = queue.enqueue(job(runtime, 'a'));
    await settle();
    channel.releaseConfirms();
    await enqueueing;
    const [reserved] = await queue.reserve('emails', 1, runtime.now());

    const retrying = queue.requeue('emails', reserved!.id, runtime.now() + 10, 1);
    await settle();
    expect(acks(channel)).toBe(0);
    channel.releaseConfirms();
    await retrying;
    expect(acks(channel)).toBe(1);
    await queue.disconnect();
  });

  it('a disconnect during the confirm wait still acks on the reserving channel', async () => {
    const { queue, channel, runtime } = await connected({ withholdConfirms: true });
    const enqueueing = queue.enqueue(job(runtime, 'a'));
    await settle();
    channel.releaseConfirms();
    await enqueueing;
    const [reserved] = await queue.reserve('emails', 1, runtime.now());
    const dying = queue.deadLetter('emails', reserved!.id, runtime.now());
    await settle();
    await queue.disconnect();
    channel.releaseConfirms();
    await dying;
    expect(acks(channel)).toBe(1);
  });

  it('rejects a pending enqueue when the channel closes, even with publishTimeoutMs: 0', async () => {
    // amqplib 0.10.x can leave a publish callback uncalled on close (its drain
    // stops at a slot an out-of-order confirm already settled); emitClose()
    // models exactly that, so only the per-publish close listener settles it.
    const { queue, channel, runtime } = await connected(
      { withholdConfirms: true },
      { publishTimeoutMs: 0 },
    );
    const baseline = channel.listenerCount('close');
    const enqueueing = queue.enqueue(job(runtime, 'a'));
    await settle();
    expect(channel.listenerCount('close')).toBe(baseline + 1);
    channel.emitClose();
    await expect(enqueueing).rejects.toThrow(
      'RabbitMQ did not confirm the job published to queue "he.queue.emails.ready": ' +
        'channel closed before the confirm arrived',
    );
    expect(channel.listenerCount('close')).toBe(baseline);
    // A confirm arriving after the close cannot settle the publish a second time.
    channel.releaseConfirms();
    await queue.disconnect();
  });

  it('a channel close during a retry rejects it and leaves the reserved job UNACKED', async () => {
    const { queue, channel, runtime } = await connected(
      { withholdConfirms: true },
      { publishTimeoutMs: 0 },
    );
    const enqueueing = queue.enqueue(job(runtime, 'a'));
    await settle();
    channel.releaseConfirms();
    await enqueueing;
    const [reserved] = await queue.reserve('emails', 1, runtime.now());
    const retrying = queue.requeue('emails', reserved!.id, runtime.now() + 10, 1);
    await settle();
    channel.emitClose();
    await expect(retrying).rejects.toThrow('channel closed before the confirm arrived');
    expect(acks(channel)).toBe(0);
    channel.releaseConfirms();
    await queue.disconnect();
  });

  it('removes its close listener once each publish is confirmed or throws', async () => {
    const { queue, channel, runtime } = await connected();
    const baseline = channel.listenerCount('close');
    for (const id of ['a', 'b', 'c']) {
      await queue.enqueue(job(runtime, id));
    }
    expect(channel.listenerCount('close')).toBe(baseline);
    await queue.disconnect();

    const failing = await connected({ rejectPublish: true });
    const failingBaseline = failing.channel.listenerCount('close');
    await expect(failing.queue.enqueue(job(failing.runtime, 'x'))).rejects.toThrow(
      'Publish failed',
    );
    expect(failing.channel.listenerCount('close')).toBe(failingBaseline);
    await failing.queue.disconnect();
  });

  it('bounds a confirm that never arrives', async () => {
    const { queue, channel, runtime } = await connected(
      { withholdConfirms: true },
      { publishTimeoutMs: 20 },
    );
    const outcome = await outcomeAfterBound(runtime, queue.enqueue(job(runtime, 'a')), 25);
    expect(outcome).toContain('within 20 ms (publishTimeoutMs); it may still be accepted');
    channel.releaseConfirms();
    await queue.disconnect();
  });

  it('bounds the queue declarations as well — a paused broker never answers them', async () => {
    const { queue, channel, runtime } = await connected({}, { publishTimeoutMs: 20 });
    channel.assertQueue = () => new Promise<{ queue: string }>(() => {});
    const outcome = await outcomeAfterBound(runtime, queue.enqueue(job(runtime, 'a')), 25);
    expect(outcome).toContain('within 20 ms (publishTimeoutMs)');
    expect(publishes(channel).length).toBe(0);
    await queue.disconnect();
  });

  it('defaults the bound to 15 s and refuses an out-of-range value', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15_000);
    expect(resolvePublishTimeoutMs(undefined)).toBe(15_000);
    expect(resolvePublishTimeoutMs(0)).toBe(0);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => resolvePublishTimeoutMs(bad)).toThrow(RangeError);
      expect(() => new RabbitMqQueue(new FakeRuntimeServices(), { publishTimeoutMs: bad }))
        .toThrow('publishTimeoutMs');
    }
  });

  it('a facade without createConfirmChannel() keeps a plain channel and warns once', async () => {
    const warnings: string[] = [];
    const runtime = new FakeRuntimeServices();
    const connection = new FakeAmqpQueueConnection({ withoutConfirmChannel: true });
    const queue = new RabbitMqQueue(runtime, {
      client: connection,
      reportWarning: (message) => warnings.push(message),
    });
    await queue.connect();
    await queue.disconnect();
    await queue.connect();
    const channel = await connection.createChannel();
    expect(channel.confirmMode).toBe(false);
    await queue.enqueue(job(runtime, 'a'));
    expect((publishes(channel)[0]!.options as { persistent?: boolean }).persistent).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('NOT confirmed');
    await queue.disconnect();
  });

  it('a facade without createConfirmChannel() and no reporter stays silent', async () => {
    const runtime = new FakeRuntimeServices();
    const queue = new RabbitMqQueue(runtime, {
      client: new FakeAmqpQueueConnection({ withoutConfirmChannel: true }),
    });
    await queue.connect();
    await queue.enqueue(job(runtime, 'a'));
    expect(queue.isReady()).toBe(true);
    await queue.disconnect();
  });
});

describe('QueuePlugin RabbitMQ durability options', () => {
  function runtimePlugin(runtime: FakeRuntimeServices): IPlugin {
    return {
      name: 'fake-runtime',
      version: '1.0.0',
      provides: [CAPABILITIES.RUNTIME],
      register(ctx) {
        ctx.services.register(CAPABILITIES.RUNTIME, runtime);
      },
    };
  }

  it('refuses a bad publishTimeoutMs when QueuePlugin(...) is called', () => {
    expect(() => QueuePlugin({ adapter: 'rabbitmq', publishTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('refuses a non-boolean persistentMessages when QueuePlugin(...) is called', () => {
    expect(() => QueuePlugin({ adapter: 'rabbitmq', persistentMessages: 1 as unknown as boolean }))
      .toThrow(TypeError);
  });

  it('does not validate RabbitMQ options for another adapter', () => {
    expect(() => QueuePlugin({ adapter: 'memory', publishTimeoutMs: Number.NaN })).not.toThrow();
  });

  it('threads both options into the adapter through a real kernel app', async () => {
    const runtime = new FakeRuntimeServices();
    const connection = new FakeAmqpQueueConnection({ confirmError: new Error('nacked') });
    const app = createApplication({
      plugins: [
        runtimePlugin(runtime),
        QueuePlugin({
          adapter: 'rabbitmq',
          client: connection,
          persistentMessages: false,
        }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    // The confirm channel reached `add()`: the broker's refusal rejects it.
    await expect(queue.add('emails', { to: 'a@example.com' })).rejects.toThrow('nacked');
    const channel = await connection.createChannel();
    const [sent] = publishes(channel);
    expect(sent!.options).toEqual({});
    await app.stop();
  });

  it('threads publishTimeoutMs into the adapter through a real kernel app', async () => {
    const runtime = new FakeRuntimeServices();
    const connection = new FakeAmqpQueueConnection({ withholdConfirms: true });
    const app = createApplication({
      plugins: [
        runtimePlugin(runtime),
        QueuePlugin({
          adapter: 'rabbitmq',
          client: connection,
          publishTimeoutMs: 30,
        }),
      ],
    });
    await app.start();
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    const outcome = await outcomeAfterBound(runtime, queue.add('emails', {}), 35);
    expect(outcome).toContain('within 30 ms (publishTimeoutMs)');
    (await connection.createChannel()).releaseConfirms();
    await app.stop();
  });

  it("routes the unconfirmed-channel warning to the app's logger, read at call time", async () => {
    const runtime = new FakeRuntimeServices();
    const warnings: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(runtime),
        {
          name: 'test-logger',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx) {
            ctx.services.register(CAPABILITIES.LOGGER, {
              debug: () => {},
              info: () => {},
              warn: (message: string) => warnings.push(message),
              error: () => {},
              child() {
                return this;
              },
            });
          },
        },
        QueuePlugin({
          adapter: 'rabbitmq',
          client: new FakeAmqpQueueConnection({ withoutConfirmChannel: true }),
        }),
      ],
    });
    await app.start();
    expect(warnings.some((w) => w.includes('NOT confirmed'))).toBe(true);
    await app.stop();
  });
});
