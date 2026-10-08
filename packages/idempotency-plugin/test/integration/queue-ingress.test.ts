/**
 * `idempotentIngress` on a REAL kernel with the in-memory queue (M109a §3.7):
 * a second job with the same key runs the processor once, and an unlisted job
 * name runs every time.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IQueue } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { QueuePlugin } from '@setu-ts/queue-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin, idempotentIngress } from '../../src/index.ts';

const POLL_MS = 5;

/** Waits for `predicate`, or fails the test rather than hanging forever. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Builds an app whose listed job runs the idempotent behaviour. */
async function buildApp() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      IdempotencyPlugin(),
      QueuePlugin({
        adapter: 'memory',
        pollIntervalMs: POLL_MS,
        defaultMaxAttempts: 1,
        behaviors: [
          idempotentIngress({ jobNames: ['email.send'], key: (ctx) => ctx.headers?.['x-order'] }),
        ],
      }),
    ],
  });
  await app.start();
  const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
  return { app, queue };
}

describe('idempotentIngress on a real queue (M109a §3.7)', () => {
  it('runs the processor once for two jobs sharing a key, and every time for an unlisted name', async () => {
    const { app, queue } = await buildApp();
    try {
      let listed = 0;
      let unlisted = 0;

      queue.process('email.send', () => {
        listed++;
      });
      queue.process('other.job', () => {
        unlisted++;
      });

      await queue.add('email.send', { to: 'a@example.com' }, { headers: { 'x-order': 'o1' } });
      await until(() => listed === 1, 'the first listed job to run');

      // The same key again is answered from the completed record — the
      // processor is not called a second time.
      await queue.add('email.send', { to: 'a@example.com' }, { headers: { 'x-order': 'o1' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(listed).toBe(1);

      // An unlisted job name passes through untouched, every time.
      await queue.add('other.job', { n: 1 });
      await queue.add('other.job', { n: 2 });
      await until(() => unlisted === 2, 'both unlisted jobs to run');
      expect(unlisted).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('runs two jobs with different keys', async () => {
    const { app, queue } = await buildApp();
    try {
      let listed = 0;
      queue.process('email.send', () => {
        listed++;
      });
      await queue.add('email.send', { to: 'a@example.com' }, { headers: { 'x-order': 'o1' } });
      await queue.add('email.send', { to: 'b@example.com' }, { headers: { 'x-order': 'o2' } });
      await until(() => listed === 2, 'both distinct-key jobs to run');
      expect(listed).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('releases a FAILED attempt, so the retried job runs (M109a §3.7, §3.13)', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin(),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: POLL_MS,
          defaultMaxAttempts: 2,
          behaviors: [
            idempotentIngress({ jobNames: ['email.send'], key: (ctx) => ctx.headers?.['x-order'] }),
          ],
        }),
      ],
    });
    await app.start();
    try {
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      let attempts = 0;
      queue.process('email.send', () => {
        attempts++;
        if (attempts === 1) throw new Error('the first attempt fails');
      });
      await queue.add('email.send', { to: 'a@example.com' }, { headers: { 'x-order': 'retry-1' } });

      // A failed handler releases the claim, so the retry is NOT refused
      // in-progress: the second attempt runs after the queue's own backoff.
      await until(() => attempts >= 2, 'the retried attempt to run');
      expect(attempts).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
