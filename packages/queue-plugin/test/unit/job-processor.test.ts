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
      ack: async (_name: string, _id: string) => {
        await Promise.resolve();
        adapter.ackCalled = true;
      },
      requeue: async (
        name: string,
        id: string,
        availableAtMs: number,
        attempts: number,
      ) => {
        await Promise.resolve();
        adapter.requeueCalls.push({ name, id, availableAtMs, attempts });
      },
      deadLetter: async (_name: string, _id: string, _nowMs: number) => {
        await Promise.resolve();
        adapter.deadLetterCalled = true;
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
});
