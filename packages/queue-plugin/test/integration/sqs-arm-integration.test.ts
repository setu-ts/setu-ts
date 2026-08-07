/**
 * The `'sqs'` arm driven through a REAL kernel application and the public
 * {@linkcode IQueue} surface — `add` → poll → processor → settle.
 *
 * Every other SQS test calls the adapter directly and supplies the claim token
 * itself, which is the token the real caller (`runJob`) produces. That left the
 * one path an application actually takes unexercised: `runJob` passed the job
 * id where the adapter expected its claim token, so every settle failed its own
 * claim check and NOTHING was ever deleted, requeued, or dead-lettered — a
 * processed job redelivered forever. These tests fail without that fix.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import type { IQueue } from '@hono-enterprise/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs';
const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs-dead';
const POLL_MS = 20;

/** Waits until `predicate` holds or the budget elapses, then returns. */
async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('QueuePlugin sqs arm — through a real kernel application', () => {
  it('deletes a successfully processed job from SQS', async () => {
    const transport = new FakeSqsTransport();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'sqs',
          pollIntervalMs: POLL_MS,
          sqs: { queues: { report: QUEUE_URL }, client: transport },
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>('queue');
    const seen: number[] = [];
    queue.process<{ n: number }>('report', (job) => {
      seen.push(job.data.n);
    });

    await queue.add('report', { n: 7 });
    await until(() => transport.deleted.length > 0);
    await app.stop();

    expect(seen).toEqual([7]);
    // The claim must be settled, else the message reappears after every
    // visibility timeout and the processor runs forever.
    expect(transport.deleted.length).toBe(1);
    expect(transport.deleted[0]?.queueUrl).toBe(QUEUE_URL);
    expect(transport.depth(QUEUE_URL)).toBe(0);
  });

  it('requeues a failing job with a visibility-timeout backoff', async () => {
    const transport = new FakeSqsTransport();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'sqs',
          pollIntervalMs: POLL_MS,
          defaultMaxAttempts: 3,
          sqs: { queues: { flaky: QUEUE_URL }, client: transport },
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>('queue');
    let runs = 0;
    queue.process<{ n: number }>('flaky', () => {
      runs++;
      throw new Error('boom');
    });

    await queue.add('flaky', { n: 1 });
    await until(() => transport.visibilityChanges.length > 0);
    await app.stop();

    expect(runs).toBeGreaterThan(0);
    // A retry is a ChangeMessageVisibility, never a delete.
    expect(transport.visibilityChanges.length).toBeGreaterThan(0);
    expect(transport.deleted.length).toBe(0);
  });

  it('dead-letters to the configured DLQ once attempts are exhausted', async () => {
    const transport = new FakeSqsTransport();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'sqs',
          pollIntervalMs: POLL_MS,
          // One attempt, so the first failure dead-letters immediately.
          defaultMaxAttempts: 1,
          sqs: {
            queues: { doomed: QUEUE_URL },
            deadLetterQueues: { doomed: DLQ_URL },
            client: transport,
          },
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>('queue');
    queue.process<{ n: number }>('doomed', () => {
      throw new Error('always fails');
    });

    await queue.add('doomed', { n: 1 });
    await until(() => transport.sent.some((s) => s.queueUrl === DLQ_URL));
    await app.stop();

    // The body lands on the DLQ and the source claim is settled.
    expect(transport.sent.some((s) => s.queueUrl === DLQ_URL)).toBe(true);
    expect(transport.deleted.some((d) => d.queueUrl === QUEUE_URL)).toBe(true);
    expect(transport.depth(QUEUE_URL)).toBe(0);
  });

  it('keeps one job name from consuming another name of the same plugin', async () => {
    const transport = new FakeSqsTransport();
    const alphaUrl = `${QUEUE_URL}-alpha`;
    const betaUrl = `${QUEUE_URL}-beta`;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'sqs',
          pollIntervalMs: POLL_MS,
          sqs: { queues: { alpha: alphaUrl, beta: betaUrl }, client: transport },
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>('queue');
    const alphaSeen: string[] = [];
    const betaSeen: string[] = [];
    queue.process<{ tag: string }>('alpha', (job) => {
      alphaSeen.push(job.data.tag);
    });
    queue.process<{ tag: string }>('beta', (job) => {
      betaSeen.push(job.data.tag);
    });

    await queue.add('alpha', { tag: 'a' });
    await queue.add('beta', { tag: 'b' });
    await until(() => alphaSeen.length > 0 && betaSeen.length > 0);
    await app.stop();

    expect(alphaSeen).toEqual(['a']);
    expect(betaSeen).toEqual(['b']);
  });
});
