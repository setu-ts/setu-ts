/**
 * X34-1 — the header map is carried END TO END, and the three-state contract is
 * preserved at every hop.
 *
 * `AddJobOptions.headers` → `StoredJob.headers` → `IJob.headers` →
 * `IngressContext.headers`. Without every hop the channel exists on the
 * contract and is always `undefined` in practice, which is the shape a
 * contract-only change ships in.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIngressBehavior, IJob, IngressContext } from '@setu-ts/common';

import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { withIngressBehaviors } from '../../src/processors/job-processor.ts';
import { runJob } from '../../src/processors/job-processor.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';

/** A no-op adapter for `runJob`'s settle calls. */
const SETTLE = {
  ack: () => Promise.resolve(),
  requeue: () => Promise.resolve(),
  deadLetter: () => Promise.resolve(),
};

describe('queue header channel — end to end', () => {
  describe('QueueService.add', () => {
    it('copies AddJobOptions.headers onto the stored job', async () => {
      const adapter = new MemoryQueue();
      const runtime = new FakeRuntimeServices();
      const service = new QueueService(adapter, runtime);
      await service.connect();
      await service.add('orders', { id: 1 }, { headers: { traceparent: 'tp' } });

      const [stored] = await adapter.reserve<{ id: number }>('orders', 1, runtime.now());
      expect(stored?.headers).toEqual({ traceparent: 'tp' });
    });

    it('leaves the member ABSENT when the caller supplied none', async () => {
      // Not `headers: undefined`: a present-but-undefined own property would
      // report "the channel was read and was empty" to anything testing
      // presence, which is the inverse of the contract.
      const adapter = new MemoryQueue();
      const runtime = new FakeRuntimeServices();
      const service = new QueueService(adapter, runtime);
      await service.connect();
      await service.add('orders', { id: 1 });

      const [stored] = await adapter.reserve<{ id: number }>('orders', 1, runtime.now());
      expect(stored).toBeDefined();
      expect('headers' in (stored as object)).toBe(false);
    });

    it('carries headers alongside the other options', async () => {
      const adapter = new MemoryQueue();
      const runtime = new FakeRuntimeServices();
      const service = new QueueService(adapter, runtime);
      await service.connect();
      await service.add('orders', { id: 1 }, { headers: { a: 'b' }, maxAttempts: 9 });

      const [stored] = await adapter.reserve<{ id: number }>('orders', 1, runtime.now());
      expect(stored?.headers).toEqual({ a: 'b' });
      expect(stored?.maxAttempts).toBe(9);
    });
  });

  describe('runJob → IJob', () => {
    it('delivers the stored headers to the processor', async () => {
      let seen: IJob<unknown> | undefined;
      const stored: StoredJob<{ id: number }> = {
        id: 'j-1',
        name: 'orders',
        data: { id: 1 },
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: 0,
        headers: { traceparent: 'tp' },
      };
      await runJob(new FakeRuntimeServices(), SETTLE, stored, (job) => {
        seen = job;
      });
      expect(seen?.headers).toEqual({ traceparent: 'tp' });
    });

    it('leaves the member absent when the stored job carried none', async () => {
      let seen: IJob<unknown> | undefined;
      const stored: StoredJob<{ id: number }> = {
        id: 'j-1',
        name: 'orders',
        data: { id: 1 },
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: 0,
      };
      await runJob(new FakeRuntimeServices(), SETTLE, stored, (job) => {
        seen = job;
      });
      expect(seen).toBeDefined();
      expect('headers' in (seen as object)).toBe(false);
    });
  });

  describe('the M86 ingress envelope', () => {
    it('exposes the headers to a queue behaviour, on the same member the messaging arm uses', async () => {
      let observed: IngressContext | undefined;
      const behavior: IIngressBehavior = {
        handle: (ctx, next) => {
          observed = ctx;
          return next();
        },
      };
      const wrapped = withIngressBehaviors<{ id: number }>(() => {}, [behavior]);
      await wrapped({
        id: 'j-1',
        name: 'orders',
        data: { id: 1 },
        attempts: 2,
        headers: { traceparent: 'tp' },
      });

      expect(observed?.kind).toBe('queue');
      expect(observed?.headers).toEqual({ traceparent: 'tp' });
    });

    it('leaves headers ABSENT on the envelope when the job carried none', async () => {
      // `'headers' in ctx` is the only check that separates "no channel" from
      // "channel present and empty" — `ctx.headers === undefined` is satisfied
      // by both.
      let observed: IngressContext | undefined;
      const behavior: IIngressBehavior = {
        handle: (ctx, next) => {
          observed = ctx;
          return next();
        },
      };
      const wrapped = withIngressBehaviors<{ id: number }>(() => {}, [behavior]);
      await wrapped({ id: 'j-1', name: 'orders', data: { id: 1 }, attempts: 1 });

      expect(observed).toBeDefined();
      expect('headers' in (observed as object)).toBe(false);
    });

    it('carries an empty map as an empty map', async () => {
      let observed: IngressContext | undefined;
      const behavior: IIngressBehavior = {
        handle: (ctx, next) => {
          observed = ctx;
          return next();
        },
      };
      const wrapped = withIngressBehaviors<{ id: number }>(() => {}, [behavior]);
      await wrapped({ id: 'j-1', name: 'orders', data: { id: 1 }, attempts: 1, headers: {} });

      expect(observed?.headers).toEqual({});
      expect('headers' in (observed as object)).toBe(true);
    });
  });
});
