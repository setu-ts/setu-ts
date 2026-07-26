import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { runJob } from '../../src/processors/job-processor.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Fake runtime for testing.
 */
class FakeRuntime implements IRuntimeServices {
  #now: number = Date.now();

  platform(): 'deno' | 'node' | 'bun' | 'cloudflare-workers' {
    return 'deno';
  }

  version(): string {
    return '1.0.0';
  }

  hostname(): string {
    return 'localhost';
  }

  now(): number {
    return this.#now;
  }

  uuid(): string {
    return 'test-uuid';
  }

  randomBytes(_length: number): Uint8Array {
    return new Uint8Array(0);
  }

  get subtle(): SubtleCrypto {
    throw new Error('Not implemented');
  }

  hrtime(): number {
    return this.#now;
  }

  setInterval(_fn: () => void, _ms: number): number {
    return 1;
  }

  clearInterval(_handle: number): void {}

  setTimeout(_fn: () => void, _ms: number): number {
    return 1;
  }

  clearTimeout(_handle: number): void {}

  get env(): Readonly<Record<string, string | undefined>> {
    return {};
  }

  exit(_code?: number): never {
    throw new Error('Exit called');
  }
}

describe('runJob', () => {
  let runtime: FakeRuntime;
  let adapter: {
    ack: (name: string, id: string) => Promise<void>;
    requeue: (name: string, id: string, availableAtMs: number, attempts: number) => Promise<void>;
    deadLetter: (name: string, id: string, nowMs: number) => Promise<void>;
    ackCalled: boolean;
    requeueCalls: Array<{ name: string; id: string; availableAtMs: number; attempts: number }>;
    deadLetterCalled: boolean;
  };

  beforeEach(() => {
    runtime = new FakeRuntime();
    adapter = {
      ackCalled: false,
      requeueCalls: [],
      deadLetterCalled: false,
      ack: (_name: string, _id: string) => {
        adapter.ackCalled = true;
        return Promise.resolve();
      },
      requeue: (
        name: string,
        id: string,
        availableAtMs: number,
        attempts: number,
      ) => {
        adapter.requeueCalls.push({ name, id, availableAtMs, attempts });
        return Promise.resolve();
      },
      deadLetter: (_name: string, _id: string, _nowMs: number) => {
        adapter.deadLetterCalled = true;
        return Promise.resolve();
      },
    };
  });

  describe('on success', () => {
    it('calls ack', async () => {
      const job: StoredJob = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await runJob(runtime, adapter, job, async (_job) => {
        // Success
      });

      expect(adapter.ackCalled).toBe(true);
      expect(adapter.requeueCalls.length).toBe(0);
      expect(adapter.deadLetterCalled).toBe(false);
    });
  });

  describe('on failure', () => {
    it('calls requeue when attempts < maxAttempts', async () => {
      const job: StoredJob = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await runJob(runtime, adapter, job, () => {
        throw new Error('Test error');
      });

      expect(adapter.ackCalled).toBe(false);
      expect(adapter.requeueCalls.length).toBe(1);
      expect(adapter.requeueCalls[0].attempts).toBe(2); // attempts + 1
      expect(adapter.deadLetterCalled).toBe(false);
    });

    it('calls deadLetter when attempts === maxAttempts', async () => {
      const job: StoredJob = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 3,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await runJob(runtime, adapter, job, () => {
        throw new Error('Test error');
      });

      expect(adapter.ackCalled).toBe(false);
      expect(adapter.requeueCalls.length).toBe(0);
      expect(adapter.deadLetterCalled).toBe(true);
    });
  });

  describe('IJob shape', () => {
    it('passes IJob with id, name, data, attempts to processor', async () => {
      const job: StoredJob = {
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      let receivedJob: unknown = null;
      await runJob(runtime, adapter, job, (j) => {
        receivedJob = j;
      });

      expect(receivedJob).toEqual({
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 1,
      });
    });
  });

  // Retro review (Part 5): the processor's error was caught to drive
  // requeue/dead-letter and then DISCARDED, so a failing job was silent —
  // nothing logged the reason anywhere.
  describe('failure reporting', () => {
    it('reports the retry with the job context and the error', async () => {
      const reported: Array<{
        message: string;
        error: unknown;
        meta: Record<string, unknown> | undefined;
      }> = [];
      const job: StoredJob<{ x: number }> = {
        id: 'j1',
        name: 'send-email',
        data: { x: 1 },
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: 0,
      };

      await runJob(
        runtime,
        adapter,
        job,
        () => {
          throw new Error('smtp refused');
        },
        (message, error, meta) => reported.push({ message, error, meta }),
      );

      expect(reported).toHaveLength(1);
      expect(reported[0].message).toContain('retrying');
      expect((reported[0].error as Error).message).toBe('smtp refused');
      expect(reported[0].meta).toEqual({
        job: 'j1',
        name: 'send-email',
        attempts: 1,
        maxAttempts: 3,
        retryInMs: 2000,
      });
    });

    it('reports the dead-letter at the final attempt', async () => {
      const reported: string[] = [];
      const job: StoredJob<{ x: number }> = {
        id: 'j2',
        name: 'send-email',
        data: { x: 1 },
        attempts: 3,
        maxAttempts: 3,
        availableAtMs: 0,
      };

      await runJob(
        runtime,
        adapter,
        job,
        () => {
          throw new Error('still failing');
        },
        (message) => reported.push(message),
      );

      expect(reported).toEqual(['queue job failed — dead-lettered']);
    });

    it('works without a report sink (the parameter is optional)', async () => {
      const job: StoredJob<{ x: number }> = {
        id: 'j3',
        name: 'send-email',
        data: { x: 1 },
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: 0,
      };
      await runJob(runtime, adapter, job, () => {
        throw new Error('boom');
      });
      expect(adapter.requeueCalls).toHaveLength(1);
    });
  });
});
