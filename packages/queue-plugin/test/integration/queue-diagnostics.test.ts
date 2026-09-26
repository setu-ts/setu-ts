/**
 * M98f — queue observations through a REAL kernel application: every
 * QueuePlugin instance contributes one multi-provider source, the support
 * matrix is what each adapter can honestly claim, the minimization holds
 * end to end, and observation never adds a reserve, settlement or count call
 * a diagnostic read did not explicitly schedule.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import type { IQueue, IQueueDiagnosticsSource, QueueDiagnosticsSourceBatch } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { QueuePlugin } from '../../src/index.ts';
import type { QueueDiagnosticsOptions, QueuePluginOptions } from '../../src/index.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';

const POLL_MS = 5;
const PAYLOAD_CANARY = 'payload-canary-SYNTHETIC';
const HEADER_CANARY = 'header-canary-SYNTHETIC';
const ERROR_CANARY = 'error-canary-SYNTHETIC';
const JOB_NAME = 'email.send';

/** Waits for `predicate`, or fails the test rather than hanging forever. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const DIAGNOSTICS: QueueDiagnosticsOptions = {
  enabled: true,
  instanceAlias: 'mailer',
  queues: { [JOB_NAME]: 'emails' },
};

function sources(app: IKernelApplication): readonly IQueueDiagnosticsSource[] {
  return app.services.getAll<IQueueDiagnosticsSource>(CAPABILITIES.QUEUE_DIAGNOSTICS);
}

/**
 * Starts an app with one queue plugin whose processor is DECLARED, so it
 * exists when the bootstrap depth cycle runs, and returns handles.
 */
async function startWith(options: QueuePluginOptions, fail = false) {
  const delivered: number[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      QueuePlugin({
        ...options,
        processors: [{
          name: JOB_NAME,
          processor: (job) => {
            delivered.push(job.attempts);
            if (fail) {
              throw new Error(ERROR_CANARY);
            }
          },
        }],
      }),
    ],
  });
  await app.start();
  const queue = app.services.get<IQueue>('queue');
  return { app, queue, delivered, source: sources(app)[0] };
}

describe('queue diagnostics — registration', () => {
  it('registers one multi-provider source per instance, disabled unless configured', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({ adapter: 'memory' }),
        QueuePlugin({
          adapter: 'memory',
          name: 'background',
          diagnostics: { ...DIAGNOSTICS, instanceAlias: 'bg' },
        }),
      ],
    });
    await app.start();
    try {
      const all = sources(app);
      expect(all.length).toBe(2);
      expect(all[0].read(0).state).toBe('disabled');
      const enabled = all[1].read(0);
      expect(enabled.state).toBe('no-data');
      expect(enabled.instanceAlias).toBe('bg');
      // Registry topology never reaches a batch.
      expect(JSON.stringify(enabled)).not.toMatch(/background|queue-plugin|queue\./);
    } finally {
      await app.stop();
    }
  });

  it('closes the source on stop, so it retains nothing afterwards', async () => {
    const { app, queue, source } = await startWith({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      diagnostics: DIAGNOSTICS,
    });
    await queue.add(JOB_NAME, { secret: PAYLOAD_CANARY });
    await until(() => source.read(0).attempts.length === 1, 'the attempt');
    await app.stop();
    const closed = source.read(1);
    expect(closed.closed).toBe(true);
    expect(closed.attempts).toEqual([]);
  });
});

describe('queue diagnostics — minimization end to end', () => {
  it('observes retries and the dead letter with canaries absent at the source', async () => {
    const { app, queue, delivered, source } = await startWith({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      defaultMaxAttempts: 2,
      diagnostics: DIAGNOSTICS,
    }, true);
    try {
      const id = await queue.add(JOB_NAME, { secret: PAYLOAD_CANARY }, {
        headers: { traceparent: HEADER_CANARY },
      });
      // Attempt 1 requeues with a 1 s backoff; attempt 2 dead-letters.
      await until(() => source.read(0).attempts.length === 2, 'both attempts');
      const batch: QueueDiagnosticsSourceBatch = source.read(0);
      expect(delivered).toEqual([1, 2]);
      expect(batch.attempts.map((a) => [a.attempt, a.outcome, a.settlement])).toEqual([
        [1, 'retryable-error', 'requeued'],
        [2, 'terminal-error', 'dead-lettered'],
      ]);
      expect(batch.attempts[0].jobAlias).toBe(batch.attempts[1].jobAlias);
      expect(batch.attempts[0].queueAlias).toBe('emails');
      const serialized = JSON.stringify(batch);
      for (const canary of [PAYLOAD_CANARY, HEADER_CANARY, ERROR_CANARY, id, JOB_NAME]) {
        expect(serialized).not.toContain(canary);
      }
    } finally {
      await app.stop();
    }
  });
});

describe('queue diagnostics — adapter support matrix', () => {
  const matrix = [
    {
      adapter: 'memory',
      options: (): QueuePluginOptions => ({ adapter: 'memory' }),
      settlement: 'acknowledged',
      depths: 'process-local',
    },
    {
      adapter: 'redis',
      options: (): QueuePluginOptions => ({ adapter: 'redis', client: new FakeRedisClient() }),
      settlement: 'acknowledged',
      depths: 'shared-backend',
    },
    {
      adapter: 'rabbitmq',
      options: (): QueuePluginOptions => ({
        adapter: 'rabbitmq',
        client: createFakeAmqpConnection(),
      }),
      settlement: 'unknown',
      depths: null,
    },
    {
      adapter: 'sqs',
      options: (): QueuePluginOptions => ({
        adapter: 'sqs',
        sqs: {
          queues: { [JOB_NAME]: 'https://sqs.local/000/emails' },
          client: new FakeSqsTransport(),
        },
      }),
      settlement: 'unknown',
      depths: null,
    },
  ] as const;

  for (const row of matrix) {
    it(`${row.adapter}: settlement ${row.settlement}, depths ${row.depths ?? 'unavailable'}`, async () => {
      const { app, queue, source } = await startWith({
        ...row.options(),
        pollIntervalMs: POLL_MS,
        diagnostics: {
          ...DIAGNOSTICS,
          depths: { intervalMs: 1_000, timeoutMs: 1_000, concurrency: 1 },
        },
      });
      try {
        await queue.add(JOB_NAME, { secret: PAYLOAD_CANARY });
        await until(() => source.read(0).attempts.length === 1, 'the attempt');
        await until(() => source.read(0).depthCoverage !== 'pending', 'a depth cycle');
        const batch = source.read(0);
        expect(batch.attempts[0].settlement).toBe(row.settlement);
        if (row.depths === null) {
          expect(batch.depthCoverage).toBe('unavailable');
          expect(batch.depths).toEqual([]);
        } else {
          expect(batch.depthCoverage).toBe('complete');
          expect(batch.depths.length).toBe(1);
          expect(batch.depths[0].scope).toBe(row.depths);
          expect(batch.depths[0].dead).toBe(0);
        }
      } finally {
        await app.stop();
      }
    });
  }
});

describe('queue diagnostics — observation adds no backend work', () => {
  it('diagnostic reads add zero client calls; only a scheduled cycle counts, with zcard only', async () => {
    const run = async (diagnostics?: QueueDiagnosticsOptions) => {
      const client = new FakeRedisClient();
      const { app, queue, source } = await startWith({
        adapter: 'redis',
        client,
        pollIntervalMs: POLL_MS,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });
      try {
        await queue.add(JOB_NAME, { secret: PAYLOAD_CANARY });
        await until(
          () => client.calls.some((call) => call.method === 'hdel'),
          'the acknowledgement',
        );
        // Let the worker loop idle for a few polls.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const before = client.calls.length;
        for (let index = 0; index < 25; index++) {
          source.read(0);
        }
        return { calls: client.calls, addedByReads: client.calls.length - before };
      } finally {
        await app.stop();
      }
    };
    const withoutObservation = await run();
    const withObservation = await run(DIAGNOSTICS);
    expect(withObservation.addedByReads).toBe(0);
    const settlements = (calls: { method: string }[]) =>
      calls.filter((c) => ['zrem', 'hdel', 'zadd', 'hset'].includes(c.method)).map((c) => c.method);
    expect(settlements(withObservation.calls)).toEqual(settlements(withoutObservation.calls));
    expect(withoutObservation.calls.some((c) => c.method === 'zcard')).toBe(false);
    expect(withObservation.calls.some((c) => c.method === 'zcard')).toBe(false);

    const scheduled = await run({
      ...DIAGNOSTICS,
      depths: { intervalMs: 1_000, timeoutMs: 1_000, concurrency: 1 },
    });
    // The bootstrap cycle counts the one approved processor name: three
    // `zcard`s per cycle, and nothing but `zcard` beyond the unobserved run.
    const zcards = scheduled.calls.filter((c) => c.method === 'zcard');
    expect(zcards.length).toBeGreaterThanOrEqual(3);
    expect(zcards.length % 3).toBe(0);
    expect(scheduled.addedByReads).toBe(0);
    expect(settlements(scheduled.calls)).toEqual(settlements(withoutObservation.calls));
  });

  it('settles and observes a job whose thrown value cannot be stringified', async () => {
    // With a logger registered, a processor rethrowing a value whose toString
    // is not a function used to make the failure REPORT throw before the
    // dead-letter call: the job stayed stuck in processing and its attempt was
    // never observed. It is now dead-lettered and observed like any other.
    const hostile = { toString: 1 } as unknown as Error;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin({ level: 'fatal' }),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: POLL_MS,
          defaultMaxAttempts: 1,
          processors: [{
            name: JOB_NAME,
            processor: () => {
              throw hostile;
            },
          }],
          diagnostics: {
            ...DIAGNOSTICS,
            depths: { intervalMs: 1_000, timeoutMs: 1_000, concurrency: 1 },
          },
        }),
      ],
    });
    await app.start();
    try {
      const source = sources(app)[0];
      await app.services.get<IQueue>('queue').add(JOB_NAME, { secret: PAYLOAD_CANARY });
      await until(() => source.read(0).attempts.length === 1, 'the observed attempt');
      const batch = source.read(0);
      expect(batch.attempts[0].outcome).toBe('terminal-error');
      expect(batch.attempts[0].settlement).toBe('dead-lettered');
      expect(batch.droppedAttempts).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('reports a rejected settlement as failed, and the job path is unchanged', async () => {
    class RefusingAck extends FakeRedisClient {
      override hdel(): Promise<number> {
        return Promise.reject(new Error(ERROR_CANARY));
      }
    }
    const { app, queue, delivered, source } = await startWith({
      adapter: 'redis',
      client: new RefusingAck(),
      pollIntervalMs: POLL_MS,
      diagnostics: DIAGNOSTICS,
    });
    try {
      await queue.add(JOB_NAME, { secret: PAYLOAD_CANARY });
      await until(() => source.read(0).attempts.length === 1, 'the attempt');
      const attempt = source.read(0).attempts[0];
      expect(delivered).toEqual([1]);
      expect(attempt.outcome).toBe('completed');
      expect(attempt.settlement).toBe('failed');
      expect(JSON.stringify(attempt)).not.toContain(ERROR_CANARY);
    } finally {
      await app.stop();
    }
  });
});
