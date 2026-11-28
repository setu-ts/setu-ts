/**
 * One Worker that produces to and consumes `jobs`, with `jobs-dlq` as the
 * adapter's dead-letter producer and `jobs-platform-dlq` as the platform's
 * `dead_letter_queue`. Both dead-letter queues are consumed here into memory so
 * the e2e can read what reached them.
 *
 * Routes: `POST /add?mode=<always|once>&maxAttempts=<n>&arm=<dlq|discard|flaky>`
 * (`flaky`'s dead-letter producer refuses its first send)
 * enqueues a job; `GET /state` answers what reached each queue and how many
 * times `onFailed` ran.
 *
 * @module
 */
import { env, waitUntil } from 'cloudflare:workers';
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin, createQueueHandler } from '@setu-ts/cloudflare-plugin';
import type { IQueueMessageBatch } from '@setu-ts/cloudflare-plugin';

interface State {
  deliveries: Record<string, number>;
  onFailed: Record<string, number>;
  adapterDlq: unknown[];
  platformDlq: unknown[];
  warnings: string[];
}

const state: State = {
  deliveries: {},
  onFailed: {},
  adapterDlq: [],
  platformDlq: [],
  warnings: [],
};

const apps = new Map<string, Promise<IKernelApplication>>();

type Arm = 'dlq' | 'discard' | 'flaky';

/** A dead-letter producer that refuses its first send, then forwards to JOBS_DLQ. */
let flakySends = 0;
const flakyDlq = {
  send(body: unknown): Promise<void> {
    flakySends++;
    if (flakySends === 1) return Promise.reject(new Error('dead-letter queue unavailable'));
    return (env['JOBS_DLQ'] as { send(body: unknown): Promise<void> }).send(body);
  },
  sendBatch(): Promise<void> {
    return Promise.resolve();
  },
};

function boot(arm: Arm): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ env }),
      CloudflarePlugin({
        env: { ...env, FLAKY_DLQ: flakyDlq },
        waitUntil,
        queue: {
          binding: 'JOBS',
          maxRetries: 3,
          deadLetterQueue: arm === 'dlq' ? 'JOBS_DLQ' : arm === 'flaky' ? 'FLAKY_DLQ' : false,
        },
      }),
    ],
  });
  return app.start().then(() => {
    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    const processor = (job: { id: string; data: unknown; attempts: number }): void => {
      state.deliveries[job.id] = job.attempts;
      const mode = (job.data as { mode?: string }).mode;
      if (mode === 'always' || (mode === 'once' && job.attempts === 1)) {
        throw new Error(`fails on attempt ${job.attempts}`);
      }
    };
    queue.process(`job-${arm}`, processor, {
      onFailed: (job) => {
        state.onFailed[job.id] = (state.onFailed[job.id] ?? 0) + 1;
      },
    });
    app.router.post('/add', {
      handler: async (ctx) => {
        const url = new URL(ctx.request.url);
        const maxAttempts = url.searchParams.get('maxAttempts');
        const id = await queue.add(
          `job-${arm}`,
          { mode: url.searchParams.get('mode') ?? 'always' },
          maxAttempts === null ? {} : { maxAttempts: Number(maxAttempts) },
        );
        return ctx.response.json({ id });
      },
    });
    return app;
  });
}

function appFor(arm: Arm): Promise<IKernelApplication> {
  let app = apps.get(arm);
  if (app === undefined) {
    app = boot(arm);
    apps.set(arm, app);
  }
  return app;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/state') return Response.json(state);
    const requested = url.searchParams.get('arm');
    const arm: Arm = requested === 'discard' || requested === 'flaky' ? requested : 'dlq';
    return (await appFor(arm)).fetch(request);
  },
  async queue(batch: IQueueMessageBatch): Promise<void> {
    if (batch.queue === 'jobs-dlq') {
      for (const message of batch.messages) {
        state.adapterDlq.push(message.body);
        message.ack();
      }
      return;
    }
    if (batch.queue === 'jobs-platform-dlq') {
      for (const message of batch.messages) {
        state.platformDlq.push(message.body);
        message.ack();
      }
      return;
    }
    // Split by job name: each arm is its own application with its own processor.
    for (const arm of ['dlq', 'discard', 'flaky'] as const) {
      const messages = batch.messages.filter(
        (m) => (m.body as { name?: string } | undefined)?.name === `job-${arm}`,
      );
      if (messages.length === 0) continue;
      await createQueueHandler(await appFor(arm))({ ...batch, messages });
    }
  },
};
