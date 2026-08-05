import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import type { ISqsTransport } from '../../src/adapters/sqs-queue.ts';
import {
  QueueBackendUnavailableError,
  SqsDelayTooLongError,
  SqsQueueNotConfiguredError,
} from '../../src/errors.ts';

function createRuntime(platform: string = 'node'): IRuntimeServices {
  return {
    platform: () => platform as ReturnType<IRuntimeServices['platform']>,
    uuid: () => 'uuid-1',
    now: () => 1000000,
    setTimeout: (_fn: () => void) => (1 as unknown as ReturnType<typeof setTimeout>),
    clearTimeout: () => {},
    setInterval: () => (1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: () => {},
    randomBytes: () => new Uint8Array(16),
    subtle: undefined,
    hostname: 'test',
    version: '0.1.0',
    hrtime: () => 0,
    fs: undefined,
    env: {},
    exit: () => {},
  } as unknown as IRuntimeServices;
}

describe('SqsQueue', () => {
  describe('connect()', () => {
    it('uses injected client', async () => {
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () => Promise.resolve([]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });

      await queue.connect();
      expect(queue.isReady()).toBe(true);
    });

    it('throws QueueBackendUnavailableError on cloudflare-workers', async () => {
      const queue = new SqsQueue(createRuntime('cloudflare-workers'), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
      });

      await expect(queue.connect()).rejects.toThrow(QueueBackendUnavailableError);
    });
  });

  describe('enqueue()', () => {
    it('sends job envelope to correct queue', async () => {
      const sent: Array<{ queueUrl: string; body: string }> = [];
      const transport: ISqsTransport = {
        send: (q, b) => {
          sent.push({ queueUrl: q, body: b });
          return Promise.resolve();
        },
        receive: () => Promise.resolve([]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      await queue.enqueue({
        id: 'job-1',
        name: 'jobs',
        data: { payload: 'test' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 0,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].queueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456/jobs');
      const body = JSON.parse(sent[0].body);
      expect(body.v).toBe(1);
      expect(body.id).toBe('job-1');
    });

    it('throws SqsQueueNotConfiguredError for unmapped name', async () => {
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
      });
      await queue.connect();

      await expect(queue.enqueue({
        id: 'job-1',
        name: 'unknown',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 0,
      })).rejects.toThrow(SqsQueueNotConfiguredError);
    });

    it('throws SqsDelayTooLongError when delay exceeds 900s', async () => {
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
      });
      await queue.connect();

      await expect(queue.enqueue({
        id: 'job-1',
        name: 'jobs',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 1000000 + 1_000_000,
      })).rejects.toThrow(SqsDelayTooLongError);
    });
  });

  describe('reserve()', () => {
    it('receives with correct params', async () => {
      let receivedMax = 0;
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: (_q, max) => {
          receivedMax = max;
          return Promise.resolve([{
            body: JSON.stringify({
              v: 1,
              id: 'job-1',
              name: 'jobs',
              data: { ok: true },
              maxAttempts: 3,
            }),
            receiptHandle: 'handle-1',
            approximateReceiveCount: '2',
          }]);
        },
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve<{ ok: boolean }>('jobs', 5, 1000000);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].attempts).toBe(2);
      expect(receivedMax).toBe(5);
    });

    it('clamps limit to 10', async () => {
      let receivedMax = 0;
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: (_q, max) => {
          receivedMax = max;
          return Promise.resolve([]);
        },
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      await queue.reserve('jobs', 20, 1000000);
      expect(receivedMax).toBe(10);
    });
  });

  describe('recurring (in-memory)', () => {
    it('stores and fetches due recurring jobs', async () => {
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () => Promise.resolve([]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      await queue.storeRecurring({
        id: 'rec-1',
        name: 'jobs',
        data: {},
        cron: '*/5 * * * *',
        nextRunAtMs: 1000000,
      });

      const due = await queue.fetchRecurringDue(1000000);
      expect(due).toHaveLength(1);

      await queue.advanceRecurring('rec-1', 2000000);
      const dueAfter = await queue.fetchRecurringDue(1000000);
      expect(dueAfter).toHaveLength(0);
    });
  });
});
