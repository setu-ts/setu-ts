/** Real RabbitMQ retries through a kernel app, including TTL tiers and restart recovery. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Buffer } from 'node:buffer';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, MessageHandler } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/index.ts';
import {
  loggerPlugin,
  RecordingLogger,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

const rabbitUrl = Deno.env.get('RABBITMQ_URL');
const guard = { ignore: rabbitUrl === undefined };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await check()) return;
    await wait(20);
  }
  throw Error('Timed out waiting for RabbitMQ consumer retry');
}
type Amqp = typeof import('npm:amqplib@0.10.x');
async function fixture(delaysMs: number[] = [200, 800], prefetch = 3, topicSuffix = '') {
  const url = rabbitUrl!.replace('localhost', '127.0.0.1');
  const amqp = await import('npm:amqplib@0.10.x');
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  const queue = `fix2-${crypto.randomUUID()}`;
  const topic = `${queue}.topic${topicSuffix}`;
  const logger = new RecordingLogger();
  const queues = new Set([queue, `${queue}.dead`, ...delaysMs.map((d) => `${queue}.retry.${d}ms`)]);
  const application = (handler: MessageHandler, delays = delaysMs, maxAttempts = 3) => {
    for (const d of delays) queues.add(`${queue}.retry.${d}ms`);
    return createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        MessagingPlugin({
          broker: 'rabbitmq',
          url,
          tracing: false,
          prefetch,
          deadLetterMaxLength: 7,
          consumerRetry: { maxAttempts, delaysMs: delays },
          subscriptions: [{ topic, handler, options: { queue } }],
        }),
      ],
    });
  };
  return {
    url,
    amqp,
    channel,
    queue,
    topic,
    logger,
    application,
    async close() {
      // A fresh connection also works when the test restarted the broker.
      try {
        await connection.close();
      } catch { /* restart closed the original */ }
      const cleanup = await amqp.connect(url);
      try {
        const ch = await cleanup.createChannel();
        for (const q of queues) await ch.deleteQueue(q);
      } finally {
        await cleanup.close();
      }
    },
  };
}
async function docker(args: string[]): Promise<string> {
  const result = await new Deno.Command('docker', { args }).output();
  if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
async function restartTarget(url: string): Promise<string> {
  const port = new URL(url).port || '5672';
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).split('\n').filter(
    Boolean,
  );
  if (ids.length !== 1) throw Error('Expected exactly one RabbitMQ container');
  const name = await docker(['inspect', '--format', '{{.Name}}', ids[0]!]);
  if (name.startsWith('/smoke-')) throw Error('Refusing to restart a smoke-* container');
  return ids[0]!;
}
async function waitForBroker(amqp: Amqp, url: string, containerId: string): Promise<void> {
  await until(async () => {
    try {
      await docker(['exec', containerId, 'rabbitmq-diagnostics', '-q', 'check_port_connectivity']);
      const c = await amqp.connect(url);
      await c.close();
      return true;
    } catch {
      return false;
    }
  }, 90000);
}

describe('REAL RabbitMQ consumer retry', () => {
  it('normalizes dead-letter logs while preserving original routing names', guard, async () => {
    const f = await fixture([200], 3, '\r\nFORGED');
    let good = 0;
    const app = f.application(
      (message) => {
        if (message === 'bad') throw Error('failure\nFORGED');
        good++;
      },
      [200],
      1,
    );
    try {
      await app.start();
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await broker.publish(f.topic, 'bad');
      await until(() => f.logger.entries.some((entry) => entry.message.includes('dead-lettered')));
      const line = f.logger.entries.find((entry) =>
        entry.message.includes('dead-lettered')
      )!.message;
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(line).toContain(`${f.queue}.dead`);
      expect(line).toContain('.topic FORGED');
      expect(line).toContain('Error: failure FORGED');
      expect([...line].length).toBeLessThanOrEqual(8192);
      const retained = await f.channel.get(`${f.queue}.dead`, { noAck: true });
      expect(retained).not.toBe(false);
      if (retained === false) throw Error('Expected retained dead letter');
      expect(retained.properties.headers?.['x-setu-topic']).toBe(f.topic);
      expect(JSON.parse(retained.content.toString())).toBe('bad');
      await broker.publish(f.topic, 'good');
      await until(() => good === 1);
    } finally {
      await app.stop();
      await f.close();
    }
  });

  for (const kind of ['retry', 'dead'] as const) {
    it(
      `keeps the original when the ${kind} destination disappears before disposition`,
      guard,
      async () => {
        const f = await fixture();
        const held = Promise.withResolvers<void>();
        let started = false;
        const app = f.application(
          async () => {
            started = true;
            await held.promise;
            throw Error('temporary');
          },
          [200, 800],
          kind === 'dead' ? 1 : 3,
        );
        let recovered = 0;
        const next = f.application(() => {
          recovered++;
        });
        try {
          await app.start();
          await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(f.topic, 'canary');
          await until(() => started);
          await f.channel.deleteQueue(
            kind === 'dead' ? `${f.queue}.dead` : `${f.queue}.retry.200ms`,
          );
          held.resolve();
          await wait(300);
          await app.stop(); // Closing the owning channel must recover the unacked original.
          expect((await f.channel.checkQueue(f.queue)).messageCount).toBe(1);
          await next.start();
          await until(() => recovered === 1);
        } finally {
          held.resolve();
          await app.stop();
          await next.stop();
          await f.close();
        }
      },
    );
  }

  it(
    'refuses reserved group names without closing the active consumer channel',
    guard,
    async () => {
      const f = await fixture();
      let received = 0;
      const app = f.application(() => {
        received++;
      });
      try {
        await app.start();
        const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
        await expect(broker.subscribe('other', () => {}, { queue: `${f.queue}.dead` }))
          .rejects.toThrow(RangeError);
        await broker.publish(f.topic, 'canary');
        await until(() => received === 1);
      } finally {
        await app.stop();
        await f.close();
      }
    },
  );

  it(
    'm1 redelivers after the first delay and a second failure uses the second tier',
    guard,
    async () => {
      const f = await fixture();
      const times = { m1: [] as number[], m2: [] as number[] };
      const ids = { m1: [] as string[], m2: [] as string[] };
      const app = f.application((message, metadata) => {
        if (message !== 'm1' && message !== 'm2') throw Error('Unexpected payload');
        expect(metadata.messageId).toBeDefined();
        ids[message].push(metadata.messageId!);
        times[message].push(performance.now());
        if (times[message].length < (message === 'm1' ? 2 : 3)) throw Error('temporary');
      });
      try {
        await app.start();
        await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(f.topic, 'm1');
        await until(() => times.m1.length === 2).catch((error) => {
          throw Error(`Expected 2 deliveries, received ${times.m1.length}`, { cause: error });
        });
        expect(times.m1[1]! - times.m1[0]!).toBeGreaterThanOrEqual(200);
        expect(new Set(ids.m1).size).toBe(1);
        await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(f.topic, 'm2');
        await until(() => times.m2.length === 3);
        expect(times.m2[1]! - times.m2[0]!).toBeGreaterThanOrEqual(200);
        expect(times.m2[2]! - times.m2[1]!).toBeGreaterThanOrEqual(800);
        expect(new Set(ids.m2).size).toBe(1);
        await wait(200);
        expect(times.m1).toHaveLength(2);
        expect(times.m2).toHaveLength(3);
      } finally {
        await app.stop();
        await f.close();
      }
    },
  );

  it(
    'always-failing handler reaches Q.dead after maxAttempts with original headers',
    guard,
    async () => {
      const f = await fixture();
      let attempts = 0;
      const app = f.application(() => {
        attempts++;
        throw Error('poison');
      });
      try {
        await app.start();
        const headers = { traceparent: 'trace-canary', ['__proto__']: 'safe' };
        expect(Object.hasOwn(headers, '__proto__')).toBe(true);
        f.channel.publish('messaging', f.topic, Buffer.from('"m1"'), {
          persistent: true,
          messageId: 'm1',
          timestamp: 42,
          headers,
        });
        await f.channel.waitForConfirms();
        await until(async () => (await f.channel.checkQueue(`${f.queue}.dead`)).messageCount === 1);
        const dead = await f.channel.get(`${f.queue}.dead`, { noAck: true });
        expect(dead).not.toBe(false);
        if (dead === false) throw Error('Missing dead letter');
        expect(attempts).toBe(3);
        expect(dead.content.toString()).toBe('"m1"');
        expect(dead.properties.messageId).toBe('m1');
        expect(dead.properties.timestamp).toBe(42);
        expect(dead.properties.deliveryMode).toBe(2);
        const copied = dead.properties.headers!;
        expect(copied.traceparent).toBe('trace-canary');
        expect(Object.hasOwn(copied, '__proto__')).toBe(true);
        expect(copied['__proto__']).toBe('safe');
        expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
        expect(copied['x-setu-attempts']).toBe(3);
        expect(copied['x-setu-topic']).toBe(f.topic);
        expect(copied['x-setu-error']).toContain('poison');
      } finally {
        await app.stop();
        await f.close();
      }
    },
  );

  it('a CC header never routes a retry or dead copy to the queue it names', guard, async () => {
    const f = await fixture();
    const bystander = `${f.queue}-bystander`;
    await f.channel.assertQueue(bystander, { durable: true });
    const app = f.application(() => {
      throw Error('poison');
    });
    try {
      await app.start();
      f.channel.publish('messaging', f.topic, Buffer.from('"m1"'), {
        persistent: true,
        CC: [bystander],
      });
      await f.channel.waitForConfirms();
      await until(async () => (await f.channel.checkQueue(`${f.queue}.dead`)).messageCount === 1);
      // Copies the CC header would have routed: two retries and the dead letter.
      expect((await f.channel.checkQueue(bystander)).messageCount).toBe(0);
    } finally {
      await app.stop();
      await f.channel.deleteQueue(bystander);
      await f.close();
    }
  });

  it('changing delays between two app boots avoids a 406', guard, async () => {
    const f = await fixture([200]);
    let first = 0;
    const app = f.application(() => {
      first++;
      throw Error('temporary');
    });
    let delivered = 0;
    const next = f.application(() => {
      delivered++;
    }, [800]);
    try {
      await app.start();
      await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(f.topic, 'm1');
      await until(async () =>
        (await f.channel.checkQueue(`${f.queue}.retry.200ms`)).messageCount === 1
      );
      await app.stop();
      await next.start();
      await until(() => delivered === 1);
      expect(first).toBe(1);
    } finally {
      await app.stop();
      await next.stop();
      await f.close();
    }
  });

  it(
    'prefetch bounds in-flight deliveries and elapsed handler time never duplicates them',
    guard,
    async () => {
      const f = await fixture([200], 3);
      let started = 0;
      let active = 0;
      let max = 0;
      let finished = 0;
      let release!: () => void;
      const held = new Promise<void>((r) => release = r);
      const app = f.application(async () => {
        started++;
        active++;
        max = Math.max(max, active);
        await held;
        active--;
        finished++;
      });
      try {
        await app.start();
        const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
        for (let i = 0; i < 8; i++) await broker.publish(f.topic, i);
        await until(() => started >= 3);
        await wait(1000); // Longer than the retry tier, while no delivery is acked.
        expect(started).toBe(3);
        expect((await f.channel.checkQueue(f.queue)).messageCount).toBe(5);
        release();
        await until(() => finished === 8);
        expect(started).toBe(8);
        expect(max).toBe(3);
      } finally {
        release();
        await app.stop();
        await f.close();
      }
    },
  );

  it(
    'a message waiting in a retry queue survives a broker restart and consumer replay',
    guard,
    async () => {
      const f = await fixture([3000]);
      // The admin connection also loses its socket during restart.
      f.channel.on('error', () => {});
      let attempts = 0;
      const app = f.application(() => {
        if (++attempts === 1) throw Error('temporary');
      });
      try {
        const containerId = await restartTarget(f.url);
        await app.start();
        await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(f.topic, 'm1');
        await until(async () =>
          (await f.channel.checkQueue(`${f.queue}.retry.3000ms`)).messageCount === 1
        );
        await docker(['restart', containerId]);
        await waitForBroker(f.amqp, f.url, containerId);
        await until(() => attempts === 2, 15000);
        await wait(200);
        expect(attempts).toBe(2);
      } finally {
        await app.stop();
        await f.close();
      }
    },
  );
});
