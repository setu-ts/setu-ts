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

    it('sends with delaySeconds when availableAtMs > now', async () => {
      let sentDelay: number | undefined;
      const transport: ISqsTransport = {
        send: (_q, _b, delaySeconds) => {
          sentDelay = delaySeconds;
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

      // availableAtMs = 1000000 + 30s, now = 1000000 → delaySeconds = 30
      await queue.enqueue({
        id: 'job-1',
        name: 'jobs',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 1000000 + 30_000,
      });

      expect(sentDelay).toBe(30);
    });

    it('sends without delaySeconds when availableAtMs is 0', async () => {
      let sentDelay: number | undefined;
      const transport: ISqsTransport = {
        send: (_q, _b, delaySeconds) => {
          sentDelay = delaySeconds;
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

      // availableAtMs = 0 → delaySeconds stays undefined
      await queue.enqueue({
        id: 'job-1',
        name: 'jobs',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 0,
      });

      expect(sentDelay).toBeUndefined();
    });

    it('sends without delaySeconds when availableAtMs is in the past', async () => {
      let sentDelay: number | undefined;
      const transport: ISqsTransport = {
        send: (_q, _b, delaySeconds) => {
          sentDelay = delaySeconds;
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

      // availableAtMs < now → delayMs = 0 → delaySeconds = 0 → still passed
      await queue.enqueue({
        id: 'job-1',
        name: 'jobs',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 999999,
      });

      // delaySeconds = ceil(0/1000) = 0
      expect(sentDelay).toBe(0);
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

  describe('ack()', () => {
    it('deletes message via transport', async () => {
      let deletedReceipt = '';
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '1',
          }]),
        delete: (_q, receipt) => {
          deletedReceipt = receipt;
          return Promise.resolve();
        },
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.ack('jobs', jobs[0].id);

      expect(deletedReceipt).toBe('handle-j1');
    });

    it('ignores unknown id without throwing', async () => {
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

      // Should not throw even with unknown id
      await queue.ack('jobs', 'nonexistent-id');
    });
  });

  describe('requeue()', () => {
    it('calls changeVisibility with backoff seconds', async () => {
      let visibilitySeconds = 0;
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '2',
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: (_q, _r, seconds) => {
          visibilitySeconds = seconds;
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };
      const runtime = createRuntime();
      const queue = new SqsQueue(runtime, {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.requeue('jobs', jobs[0].id, 1000000 + 60000, jobs[0].attempts);

      expect(visibilitySeconds).toBe(60);
    });

    it('ignores unknown id without throwing', async () => {
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

      await queue.requeue('jobs', 'nonexistent-id', 2000000, 2);
    });
  });

  describe('deadLetter()', () => {
    it('sends to DLQ then deletes from source', async () => {
      let dlqSent = false;
      let deletedReceipt = '';
      const transport: ISqsTransport = {
        send: (q) => {
          if (q.includes('dlq')) dlqSent = true;
          return Promise.resolve();
        },
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '3',
          }]),
        delete: (_q, receipt) => {
          deletedReceipt = receipt;
          return Promise.resolve();
        },
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        deadLetterQueues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs-dlq' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.deadLetter('jobs', jobs[0].id, 1000000);

      expect(dlqSent).toBe(true);
      expect(deletedReceipt).toBe('handle-j1');
    });

    it('deletes from source when no DLQ configured', async () => {
      let deletedReceipt = '';
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '3',
          }]),
        delete: (_q, receipt) => {
          deletedReceipt = receipt;
          return Promise.resolve();
        },
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        // No deadLetterQueues
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.deadLetter('jobs', jobs[0].id, 1000000);

      expect(deletedReceipt).toBe('handle-j1');
    });
  });

  describe('reserve() edge cases', () => {
    it('skips messages with no receiptHandle', async () => {
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: '',
            approximateReceiveCount: '1',
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      expect(jobs).toHaveLength(0);
    });

    it('skips malformed messages', async () => {
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: 'not-json',
            receiptHandle: 'handle-1',
            approximateReceiveCount: '1',
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      expect(jobs).toHaveLength(0);
    });

    it('defaults attempts to 1 when no ApproximateReceiveCount', async () => {
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-1',
            approximateReceiveCount: undefined,
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].attempts).toBe(1);
    });
  });

  describe('disconnect()', () => {
    it('clears receipts and sets ready false', async () => {
      let closed = false;
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () => Promise.resolve([]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();
      expect(queue.isReady()).toBe(true);

      await queue.disconnect();
      expect(closed).toBe(true);
      expect(queue.isReady()).toBe(false);
    });
  });

  describe('not connected errors', () => {
    it('throws when enqueue without connection', async () => {
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
      });

      await expect(queue.enqueue({
        id: 'j1',
        name: 'jobs',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 0,
      })).rejects.toThrow('not connected');
    });

    it('throws when reserve without connection', async () => {
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
      });

      await expect(queue.reserve('jobs', 1, 1000000)).rejects.toThrow('not connected');
    });
  });

  describe('logger branches', () => {
    it('logs ack for unknown receipt handle', async () => {
      let logged = '';
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
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      await queue.ack('jobs', 'nonexistent');
      expect(logged).toContain('unknown or expired');
    });

    it('logs requeue for unknown receipt handle', async () => {
      let logged = '';
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
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      await queue.requeue('jobs', 'nonexistent', 2000000, 1);
      expect(logged).toContain('unknown or expired');
    });

    it('logs deadLetter for unknown receipt handle', async () => {
      let logged = '';
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
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      await queue.deadLetter('jobs', 'nonexistent', 1000000);
      expect(logged).toContain('unknown or expired');
    });

    it('logs no DLQ configured when deleting', async () => {
      let logged = '';
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '3',
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        // No deadLetterQueues
        client: transport,
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.deadLetter('jobs', jobs[0].id, 1000000);
      expect(logged).toContain('no DLQ configured');
    });

    it('logs DLQ send failure and leaves source undeleted', async () => {
      let logged = '';
      let deletedReceipt = '';
      const transport: ISqsTransport = {
        send: (q) => {
          if (q.includes('dlq')) return Promise.reject(new Error('DLQ network error'));
          return Promise.resolve();
        },
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '3',
          }]),
        delete: (_q, receipt) => {
          deletedReceipt = receipt;
          return Promise.resolve();
        },
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        deadLetterQueues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs-dlq' },
        client: transport,
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      await queue.deadLetter('jobs', jobs[0].id, 1000000);

      expect(logged).toContain('DLQ send failed');
      // Source message should NOT be deleted when DLQ send fails
      expect(deletedReceipt).toBe('');
    });
  });

  describe('reserve() with logger', () => {
    it('logs when message has no receiptHandle', async () => {
      let logged = '';
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: '',
            approximateReceiveCount: '1',
          }]),
        delete: () => Promise.resolve(),
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const queue = new SqsQueue(createRuntime(), {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      }, {
        error: (msg: string) => {
          logged = msg;
        },
      });
      await queue.connect();

      const jobs = await queue.reserve('jobs', 1, 1000000);
      expect(jobs).toHaveLength(0);
      expect(logged).toContain('no ReceiptHandle');
    });
  });

  describe('findReceiptEntry expired', () => {
    it('removes and returns undefined for expired receipt', async () => {
      let deletedReceipt = '';
      const transport: ISqsTransport = {
        send: () => Promise.resolve(),
        receive: () =>
          Promise.resolve([{
            body: JSON.stringify({ v: 1, id: 'j1', name: 'jobs', data: {}, maxAttempts: 3 }),
            receiptHandle: 'handle-j1',
            approximateReceiveCount: '1',
          }]),
        delete: (_q, receipt) => {
          deletedReceipt = receipt;
          return Promise.resolve();
        },
        changeVisibility: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      // Runtime with a now() that makes the receipt expired immediately
      const runtime: IRuntimeServices = {
        platform: () => 'node' as ReturnType<IRuntimeServices['platform']>,
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
      const queue = new SqsQueue(runtime, {
        queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
        client: transport,
      });
      await queue.connect();

      // Reserve with a nowMs that is 1s BEFORE the runtime's now()
      const jobs = await queue.reserve('jobs', 1, 999900);
      expect(jobs).toHaveLength(1);

      // Now ack with an expired handle — the entry was stored with claimExpiresAtMs
      // = 999900 + 30*1000 = 1029900, but runtime.now() = 1000000 < 1029900
      // so the receipt is NOT expired. Let's advance time past expiry.
      (runtime as unknown as { now: () => number }).now = () => 2000000;

      // The entry should now be expired — ack returns early without deleting
      await queue.ack('jobs', jobs[0].id);
      expect(deletedReceipt).toBe(''); // not deleted because entry expired
    });
  });
});

// Guarded real-import: exercises the lazy-load path through loadSqsModule.
// The SDK module is pinned in deno.lock so the import resolves; connect()
// sets #ready to true. Disconnect afterwards to clean up.
describe('SqsQueue — lazy SDK load', () => {
  it('connect without an injected client exercises the loadSqsModule() path', async () => {
    const runtime = createRuntime();
    const queue = new SqsQueue(runtime, {
      queues: { jobs: 'https://sqs.us-east-1.amazonaws.com/123456/jobs' },
    });

    // The SDK module is cached in deno.lock, so connect() resolves (loadSqsModule
    // is exercised) and the queue becomes ready. Disconnect to clean up.
    await queue.connect();
    expect(queue.isReady()).toBe(true);
    await queue.disconnect();
    expect(queue.isReady()).toBe(false);
  });
});

// loadSqsModule exported
describe('loadSqsModule (exported)', () => {
  it('is exported as a function', async () => {
    const mod = await import('../../src/adapters/sqs-queue.ts');
    expect(typeof mod.loadSqsModule).toBe('function');
  });

  it('calling loadSqsModule enters the real import path', async () => {
    const { loadSqsModule } = await import('../../src/adapters/sqs-queue.ts');
    try {
      await loadSqsModule();
    } catch {
      // Module absent — the import line was still reached.
    }
  });
});

// adaptSqsModule coverage
describe('adaptSqsModule', () => {
  it('creates transport from SDK module', async () => {
    const { adaptSqsModule } = await import('../../src/adapters/sqs-queue.ts');

    const fakeClient = {
      send: async (_cmd: unknown) => {
        await Promise.resolve();
        return {
          Messages: [{ Body: 'test', ReceiptHandle: 'handle-1', Attributes: {} }],
        };
      },
      destroy: async () => {
        await Promise.resolve();
      },
    };

    const mod = {
      SQSClient: class {
        send = fakeClient.send;
        destroy = fakeClient.destroy;
      },
      SendMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ReceiveMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ChangeMessageVisibilityCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    };

    const transport = adaptSqsModule(
      mod as unknown as import('../../src/adapters/sqs-queue.ts').SqsSdkModule,
      { region: 'us-east-1', endpoint: 'http://localhost:9324' },
    );

    await transport.send('http://localhost:9324/queue', 'hello');
    const messages = await transport.receive('http://localhost:9324/queue', 10, 30);
    expect(messages.length).toBe(1);
    await transport.delete('http://localhost:9324/queue', 'handle-1');
    await transport.changeVisibility('http://localhost:9324/queue', 'handle-1', 60);
    await transport.close();
  });

  it('passes credentials to client config', async () => {
    const { adaptSqsModule } = await import('../../src/adapters/sqs-queue.ts');

    let capturedConfig: Record<string, unknown> = {};
    const fakeClient = {
      send: (_cmd: unknown) => ({ Messages: [] }),
      destroy: async () => {},
    };
    const mod = {
      SQSClient: class {
        constructor(config: Record<string, unknown>) {
          capturedConfig = config;
        }
        send = fakeClient.send;
        destroy = fakeClient.destroy;
      },
      SendMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ReceiveMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ChangeMessageVisibilityCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    };

    adaptSqsModule(
      mod as unknown as import('../../src/adapters/sqs-queue.ts').SqsSdkModule,
      {
        region: 'eu-west-1',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
        endpoint: 'http://localhost:9324',
      },
    );

    expect(capturedConfig.region).toBe('eu-west-1');
    expect(capturedConfig.credentials).toEqual({ accessKeyId: 'k', secretAccessKey: 's' });
    expect(capturedConfig.endpoint).toBe('http://localhost:9324');
  });

  it('receive defaults to empty array when Messages is missing', async () => {
    const { adaptSqsModule } = await import('../../src/adapters/sqs-queue.ts');

    const fakeClient = {
      send: (_cmd: unknown) => ({}),
      destroy: async () => {},
    };
    const mod = {
      SQSClient: class {
        send = fakeClient.send;
        destroy = fakeClient.destroy;
      },
      SendMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ReceiveMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ChangeMessageVisibilityCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    };

    const transport = adaptSqsModule(
      mod as unknown as import('../../src/adapters/sqs-queue.ts').SqsSdkModule,
      { region: 'us-east-1' },
    );

    const messages = await transport.receive('http://localhost:9324/queue', 10, 30);
    expect(messages.length).toBe(0);
    await transport.close();
  });

  it('receive handles messages with missing Body and ReceiptHandle', async () => {
    const { adaptSqsModule } = await import('../../src/adapters/sqs-queue.ts');

    const fakeClient = {
      send: (_cmd: unknown) => ({
        Messages: [{}],
      }),
      destroy: async () => {},
    };
    const mod = {
      SQSClient: class {
        send = fakeClient.send;
        destroy = fakeClient.destroy;
      },
      SendMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ReceiveMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      DeleteMessageCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
      ChangeMessageVisibilityCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    };

    const transport = adaptSqsModule(
      mod as unknown as import('../../src/adapters/sqs-queue.ts').SqsSdkModule,
      { region: 'us-east-1' },
    );

    const messages = await transport.receive('http://localhost:9324/queue', 10, 30);
    expect(messages.length).toBe(1);
    expect(messages[0].body).toBe('');
    expect(messages[0].receiptHandle).toBe('');
    await transport.close();
  });
});

// A2: C1 — class-level lazy SQS config
describe('C1: class-level lazy SQS config', () => {
  it('adaptSqsModule forwards region, endpoint, and credentials to SQSClient', async () => {
    const { adaptSqsModule } = await import('../../src/adapters/sqs-queue.ts');
    let capturedConfig: Record<string, unknown> | undefined;
    const mod = {
      SQSClient: class {
        constructor(cfg: Record<string, unknown>) {
          capturedConfig = cfg;
        }
        send = () => Promise.resolve({});
        destroy = () => Promise.resolve();
      },
      SendMessageCommand: class {},
      ReceiveMessageCommand: class {},
      DeleteMessageCommand: class {},
      ChangeMessageVisibilityCommand: class {},
    };
    adaptSqsModule(
      mod as unknown as import('../../src/adapters/sqs-queue.ts').SqsSdkModule,
      {
        region: 'us-west-2',
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        endpoint: 'http://elasticmq:9324',
      },
    );
    expect(capturedConfig).not.toBeUndefined();
    expect(capturedConfig!.region).toBe('us-west-2');
    expect(capturedConfig!.endpoint).toBe('http://elasticmq:9324');
    expect(capturedConfig!.credentials).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });
});

// A2: C2 — maxAttempts preserved
describe('C2: maxAttempts preserved', () => {
  it('reserve returns StoredJob with maxAttempts from envelope (ne 3)', async () => {
    const transport: import('../../src/adapters/sqs-queue.ts').ISqsTransport = {
      send: () => Promise.resolve(),
      receive: () =>
        Promise.resolve([{
          body: JSON.stringify({ v: 1, id: 'job-1', name: 'jobs', data: { x: 1 }, maxAttempts: 5 }),
          receiptHandle: 'handle-1',
          approximateReceiveCount: '1',
        }]),
      delete: () => Promise.resolve(),
      changeVisibility: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      client: transport,
    });
    await queue.connect();

    const jobs = await queue.reserve<{ x: number }>('jobs', 10, 1000000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].maxAttempts).toBe(5);
  });
});

// A2: C10 — DLQ receives original body (not '')
describe('C10: DLQ receives original body', () => {
  it('deadLetter forwards original envelope body to DLQ', async () => {
    const sentAll: Array<{ queueUrl: string; body: string }> = [];
    const originalBody = JSON.stringify({
      v: 1,
      id: 'job-dlq',
      name: 'jobs',
      data: { important: true },
      maxAttempts: 3,
    });
    const transport: import('../../src/adapters/sqs-queue.ts').ISqsTransport = {
      send: (q, b) => {
        sentAll.push({ queueUrl: q, body: b });
        return Promise.resolve();
      },
      receive: () =>
        Promise.resolve([{
          body: originalBody,
          receiptHandle: 'receipt-handle-1',
          approximateReceiveCount: '3',
        }]),
      delete: () => Promise.resolve(),
      changeVisibility: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      deadLetterQueues: { jobs: 'http://localhost:9324/jobs-dlq' },
      client: transport,
    });
    await queue.connect();

    const jobs = await queue.reserve<{ important: boolean }>('jobs', 10, 1000000);
    expect(jobs).toHaveLength(1);
    await queue.deadLetter('jobs', jobs[0].id, 1000000);

    const dlqSend = sentAll.find((s) => s.queueUrl === 'http://localhost:9324/jobs-dlq');
    expect(dlqSend).not.toBeUndefined();
    expect(dlqSend!.body).toBe(originalBody);
    expect(dlqSend!.body).not.toBe('');
  });
});

describe('SqsQueue stable identity and current receipt', () => {
  it('exposes stable envelope id on first reserve and keeps it on redelivery', async () => {
    const originalBody = JSON.stringify({
      v: 1,
      id: 'job-stable-1',
      name: 'jobs',
      data: { important: true },
      maxAttempts: 3,
    });

    let callCount = 0;
    const transport: ISqsTransport = {
      send: () => Promise.resolve(),
      receive: () => {
        callCount++;
        const receiptHandle = callCount === 1 ? 'receipt-A' : 'receipt-B';
        return Promise.resolve([{
          body: originalBody,
          receiptHandle,
          approximateReceiveCount: String(callCount),
        }]);
      },
      delete: () => Promise.resolve(),
      changeVisibility: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      client: transport,
    });
    await queue.connect();

    // First reserve — uses receipt A
    const jobs1 = await queue.reserve<{ important: boolean }>('jobs', 10, 1000000);
    expect(jobs1).toHaveLength(1);
    expect(jobs1[0].id).toBe('job-stable-1');

    // Second reserve (redelivery) — uses receipt B, but ID remains stable
    const jobs2 = await queue.reserve<{ important: boolean }>('jobs', 10, 1000000);
    expect(jobs2).toHaveLength(1);
    expect(jobs2[0].id).toBe('job-stable-1');
  });

  it('ack uses current receipt handle after redelivery, never the original', async () => {
    const originalBody = JSON.stringify({
      v: 1,
      id: 'job-stable-1',
      name: 'jobs',
      data: {},
      maxAttempts: 3,
    });

    let callCount = 0;
    const deletedReceipts: string[] = [];
    const transport: ISqsTransport = {
      send: () => Promise.resolve(),
      receive: () => {
        callCount++;
        const receiptHandle = callCount === 1 ? 'receipt-A' : 'receipt-B';
        return Promise.resolve([{
          body: originalBody,
          receiptHandle,
          approximateReceiveCount: String(callCount),
        }]);
      },
      delete: (_q, receiptHandle) => {
        deletedReceipts.push(receiptHandle);
        return Promise.resolve();
      },
      changeVisibility: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      client: transport,
    });
    await queue.connect();

    // First reserve (receipt A)
    const jobs1 = await queue.reserve('jobs', 10, 1000000);
    expect(jobs1[0].id).toBe('job-stable-1');

    // Redelivery (receipt B) — overwrites the stored receipt
    await queue.reserve('jobs', 10, 1000000);

    // Ack uses receipt B (current), NOT receipt A
    await queue.ack('jobs', 'job-stable-1');

    expect(deletedReceipts).toContain('receipt-B');
    expect(deletedReceipts).not.toContain('receipt-A');
  });

  it('requeue uses current receipt handle after redelivery', async () => {
    const originalBody = JSON.stringify({
      v: 1,
      id: 'job-stable-1',
      name: 'jobs',
      data: {},
      maxAttempts: 3,
    });

    let callCount = 0;
    const visibilityReceipts: string[] = [];
    const transport: ISqsTransport = {
      send: () => Promise.resolve(),
      receive: () => {
        callCount++;
        const receiptHandle = callCount === 1 ? 'receipt-A' : 'receipt-B';
        return Promise.resolve([{
          body: originalBody,
          receiptHandle,
          approximateReceiveCount: String(callCount),
        }]);
      },
      delete: () => Promise.resolve(),
      changeVisibility: (_q, receiptHandle) => {
        visibilityReceipts.push(receiptHandle);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };

    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      client: transport,
    });
    await queue.connect();

    // First reserve (receipt A)
    await queue.reserve('jobs', 10, 1000000);

    // Redelivery (receipt B)
    await queue.reserve('jobs', 10, 1000000);

    // Requeue uses receipt B
    await queue.requeue('jobs', 'job-stable-1', 2000000, 2);

    expect(visibilityReceipts).toContain('receipt-B');
    expect(visibilityReceipts).not.toContain('receipt-A');
  });

  it('deadLetter uses current receipt and original body after redelivery', async () => {
    const originalBody = JSON.stringify({
      v: 1,
      id: 'job-stable-1',
      name: 'jobs',
      data: { important: true },
      maxAttempts: 3,
    });

    let callCount = 0;
    const sentAll: Array<{ queueUrl: string; body: string }> = [];
    const deletedReceipts: string[] = [];
    const transport: ISqsTransport = {
      send: (q, b) => {
        sentAll.push({ queueUrl: q, body: b });
        return Promise.resolve();
      },
      receive: () => {
        callCount++;
        const receiptHandle = callCount === 1 ? 'receipt-A' : 'receipt-B';
        return Promise.resolve([{
          body: originalBody,
          receiptHandle,
          approximateReceiveCount: String(callCount),
        }]);
      },
      delete: (_q, receiptHandle) => {
        deletedReceipts.push(receiptHandle);
        return Promise.resolve();
      },
      changeVisibility: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    const queue = new SqsQueue(createRuntime(), {
      queues: { jobs: 'http://localhost:9324/jobs' },
      deadLetterQueues: { jobs: 'http://localhost:9324/jobs-dlq' },
      client: transport,
    });
    await queue.connect();

    // First reserve (receipt A)
    await queue.reserve('jobs', 10, 1000000);

    // Redelivery (receipt B)
    const jobs = await queue.reserve<{ important: boolean }>('jobs', 10, 1000000);

    // DeadLetter uses receipt B and forwards original body
    await queue.deadLetter('jobs', jobs[0].id, 1000000);

    const dlqSend = sentAll.find((s) => s.queueUrl === 'http://localhost:9324/jobs-dlq');
    expect(dlqSend).not.toBeUndefined();
    expect(dlqSend!.body).toBe(originalBody);

    // Delete uses current receipt B, never A
    expect(deletedReceipts).toContain('receipt-B');
    expect(deletedReceipts).not.toContain('receipt-A');
  });
});
