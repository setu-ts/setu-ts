/**
 * Real-broker proof that queued jobs survive a RabbitMQ restart.
 *
 * Before 0.9.0 the RabbitMQ adapter published every job TRANSIENT into its
 * durable ready/delay/dead queues: measured against RabbitMQ 4.3.5, 5 jobs
 * waiting in a ready queue → 0 after `docker restart`, the queue itself
 * surviving empty. No fake can show this — a fake has no disk — so this suite restarts
 * the real broker once and asserts both sides of the option in that one
 * restart: persistent publishes survive, and the `persistentMessages: false`
 * control does not. The control is what proves the restart actually tested
 * durability; without it a restart that silently did nothing would pass.
 *
 * Guarded with `ignore:` on `RABBITMQ_URL` (never an early return, which would
 * report a skipped suite as passed). CI sets it, and `test/apps-gate.test.ts`
 * pins the guard. The variable also places this file in the serial phase of
 * `scripts/test-partition.ts`, so the restart cannot race another suite.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IQueue, IRuntimeServices } from '@setu-ts/common';
import { QueuePlugin } from '../../src/index.ts';

const rabbitUrl = Deno.env.get('RABBITMQ_URL');

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0]!;
}

/** The scoped net grant covers 127.0.0.1, not every address `localhost` resolves to. */
const toIpv4 = (url: string): string => url.replace(/localhost/, '127.0.0.1');

function runtimePlugin(): IPlugin {
  const runtime = {
    hrtime: () => performance.now(),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as number),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as number),
  } as IRuntimeServices;
  return {
    name: 'real-timers-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

type Amqp = typeof import('npm:amqplib@0.10.x');

/** Counts the messages waiting in each queue through a fresh connection. */
async function depths(amqp: Amqp, url: string, queues: string[]): Promise<number[]> {
  const connection = await amqp.connect(url);
  try {
    const channel = await connection.createChannel();
    const counts: number[] = [];
    for (const queue of queues) {
      counts.push((await channel.checkQueue(queue)).messageCount);
    }
    return counts;
  } finally {
    await connection.close();
  }
}

/** Waits until the broker accepts an AMQP connection again. */
async function waitForBroker(amqp: Amqp, url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const connection = await amqp.connect(url);
      await connection.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('RabbitMQ did not accept connections within 90 s of the restart');
}

/** Adds `count` jobs under `prefix`, with no worker processing them. */
async function fillReadyQueue(
  url: string,
  persistentMessages: boolean,
  prefix: string,
  count: number,
): Promise<void> {
  const app = createApplication({
    plugins: [
      runtimePlugin(),
      QueuePlugin({ adapter: 'rabbitmq', url, prefix, persistentMessages }),
    ],
  });
  await app.start();
  try {
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    for (let i = 0; i < count; i++) {
      // Each add() now resolves only once RabbitMQ has accepted the job.
      await queue.add('reports', { i });
    }
  } finally {
    await app.stop();
  }
}

describe('REAL RabbitMQ job durability', () => {
  it({
    name: 'persistent jobs survive a broker restart; the transient control does not',
    ignore: rabbitUrl === undefined,
    fn: async () => {
      const url = toIpv4(rabbitUrl!);
      const amqp = await import('npm:amqplib@0.10.x');
      const port = new URL(url).port === '' ? 5672 : Number(new URL(url).port);
      const containerId = await containerIdForPort(port);

      const run = crypto.randomUUID().slice(0, 8);
      const persistentPrefix = `durability-persistent-${run}`;
      const transientPrefix = `durability-transient-${run}`;
      const readyQueues = [`${persistentPrefix}.reports.ready`, `${transientPrefix}.reports.ready`];
      await fillReadyQueue(url, true, persistentPrefix, 5);
      await fillReadyQueue(url, false, transientPrefix, 5);

      try {
        expect(await depths(amqp, url, readyQueues)).toEqual([5, 5]);

        await docker(['restart', containerId]);
        await waitForBroker(amqp, url);

        // Both queues are durable, so both survive; only persistent jobs do.
        expect(await depths(amqp, url, readyQueues)).toEqual([5, 0]);
      } finally {
        const connection = await amqp.connect(url);
        const channel = await connection.createChannel();
        for (const prefix of [persistentPrefix, transientPrefix]) {
          for (const kind of ['ready', 'delay', 'dead']) {
            await channel.deleteQueue(`${prefix}.reports.${kind}`);
          }
        }
        await connection.close();
      }
    },
  });
});
