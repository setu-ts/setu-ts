import { describe, expect, it, vi } from 'vitest';
import type { IJob } from '@setu-ts/common';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import type { QueueAdapter } from '../../src/adapters/queue-adapter.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { StaleClaimError } from '../../src/errors.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

async function setup(
  options: {
    token?: string;
    renewal?: boolean;
    attempts?: number;
    stale?: boolean;
    onFailed?: (job: IJob, error: unknown) => void | Promise<void>;
  } = {},
) {
  const runtime = new FakeRuntimeServices(0);
  const adapter = new MemoryQueue() as MemoryQueue & {
    claimRenewal?: NonNullable<QueueAdapter['claimRenewal']>;
  };
  const extend = vi
    .fn<NonNullable<QueueAdapter['claimRenewal']>['extend']>()
    .mockResolvedValue(true);
  if (options.renewal !== false) adapter.claimRenewal = { intervalMs: 100, extend };
  const ack = vi.spyOn(adapter, 'ack');
  const dead = vi.spyOn(adapter, 'deadLetter');
  if (options.stale) {
    ack.mockRejectedValue(new StaleClaimError());
    dead.mockRejectedValue(new StaleClaimError());
  }
  const log = vi.fn();
  const settled = vi.fn();
  const abandon = vi.fn();
  const processor = vi.fn();
  const service = new QueueService(adapter, runtime, {
    pollIntervalMs: 100,
    logger: { error: log },
    observer: { begin: () => ({ settled, abandon }) },
  });
  await service.connect();
  service.process(
    'email',
    processor,
    options.onFailed === undefined ? undefined : { onFailed: options.onFailed },
  );
  await adapter.enqueue({
    id: 'j',
    name: 'email',
    data: {},
    attempts: options.attempts ?? 1,
    maxAttempts: 3,
    availableAtMs: 0,
    ...(options.token === undefined ? {} : { claimToken: options.token }),
  });
  return { runtime, adapter, extend, ack, dead, log, settled, abandon, processor, service };
}

describe('QueueService lease renewal', () => {
  it('clears renewal timers on disconnect even while a processor remains pending', async () => {
    const s = await setup({ token: 'delivery' });
    const work = Promise.withResolvers<void>();
    s.processor.mockImplementation(() => work.promise);
    await s.runtime.advanceMs(300);
    expect(s.extend).toHaveBeenCalledTimes(2);
    await s.service.disconnect();
    await s.runtime.advanceMs(500);
    expect(s.extend).toHaveBeenCalledTimes(2);
    work.resolve();
    await s.runtime.advanceMs(100);
  });
  it('does not arm a renewal when a pending reserve returns after disconnect', async () => {
    const s = await setup({ token: 'delivery' });
    const reserved = Promise.withResolvers<readonly StoredJob[]>();
    const work = Promise.withResolvers<void>();
    vi.spyOn(s.adapter, 'reserve').mockImplementationOnce(() => reserved.promise);
    s.processor.mockImplementation(() => work.promise);
    await s.runtime.advanceMs(100);
    await s.service.disconnect();
    reserved.resolve([
      {
        id: 'late',
        name: 'email',
        data: {},
        attempts: 1,
        maxAttempts: 3,
        availableAtMs: 0,
        claimToken: 'delivery',
      },
    ]);
    await s.runtime.advanceMs(500);
    expect(s.processor).toHaveBeenCalledTimes(1);
    expect(s.extend).not.toHaveBeenCalled();
    work.resolve();
    await s.runtime.advanceMs(100);
  });
  for (const failure of [false, true]) {
    it(`renews only while the processor runs and clears the interval on ${failure ? 'throw' : 'success'}`, async () => {
      const s = await setup({ token: 'delivery' });
      const work = Promise.withResolvers<void>();
      s.processor.mockImplementation(() => work.promise);
      try {
        await s.runtime.advanceMs(100);
        await s.runtime.advanceMs(300);
        expect(s.extend).toHaveBeenCalledTimes(3);
        expect(s.extend).toHaveBeenCalledWith('email', 'j', 'delivery');
        if (failure) work.reject(new Error('processor failed'));
        else work.resolve();
        await s.runtime.advanceMs(100);
        const count = s.extend.mock.calls.length;
        await s.runtime.advanceMs(300);
        expect(s.extend).toHaveBeenCalledTimes(count);
        expect(s.settled).toHaveBeenCalledWith(
          failure ? 'retryable-error' : 'completed',
          failure ? 'requeued' : 'acknowledged',
        );
      } finally {
        await s.service.disconnect();
      }
    });
  }
  for (const options of [{}, { token: 'delivery', renewal: false }]) {
    it(`does not arm renewal without both capability and token: ${JSON.stringify(options)}`, async () => {
      const s = await setup(options);
      const work = Promise.withResolvers<void>();
      s.processor.mockImplementation(() => work.promise);
      try {
        await s.runtime.advanceMs(500);
        expect(s.extend).not.toHaveBeenCalled();
        work.resolve();
        await s.runtime.advanceMs(100);
      } finally {
        await s.service.disconnect();
      }
    });
  }
  for (const failure of ['false', 'reject', 'throw'] as const) {
    it(`skips overlapping renewals and reports ${failure} only once`, async () => {
      const s = await setup({ token: 'delivery' });
      const work = Promise.withResolvers<void>();
      const renewing = Promise.withResolvers<boolean>();
      s.processor.mockImplementation(() => work.promise);
      s.extend.mockImplementationOnce(() => renewing.promise);
      try {
        await s.runtime.advanceMs(500);
        expect(s.extend).toHaveBeenCalledTimes(1);
        if (failure === 'false') {
          s.extend.mockResolvedValue(false);
          renewing.resolve(false);
        } else if (failure === 'reject') {
          s.extend.mockRejectedValue(new Error('offline'));
          renewing.reject(new Error('offline'));
        } else {
          s.extend.mockImplementation(() => {
            throw new Error('sync');
          });
          renewing.reject(new Error('sync'));
        }
        await s.runtime.advanceMs(500);
        expect(s.extend.mock.calls.length).toBeGreaterThan(2);
        expect(
          s.log.mock.calls.filter(([message]) => message === 'queue job claim renewal failed'),
        ).toHaveLength(1);
        work.resolve();
        await s.runtime.advanceMs(100);
        expect(s.ack).toHaveBeenCalledTimes(1);
      } finally {
        await s.service.disconnect();
      }
    });
  }
  for (const stale of [false, true]) {
    it(`dead-letters an over-budget claim without running the processor (stale=${stale})`, async () => {
      const s = await setup({ token: 'delivery', attempts: 4, stale });
      try {
        await s.runtime.advanceMs(200);
        expect(s.processor).not.toHaveBeenCalled();
        expect(s.extend).not.toHaveBeenCalled();
        expect(s.dead).toHaveBeenCalledWith('email', 'j', 100, 'delivery');
        expect(s.log.mock.calls.map(([message]) => message)).toContain(
          'queue job abandoned by a dead worker — dead-lettered',
        );
        expect(s.settled).toHaveBeenCalledWith(
          'terminal-error',
          stale ? 'failed' : 'dead-lettered',
        );
      } finally {
        await s.service.disconnect();
      }
    });
  }
  it('calls onFailed with the abandoned job before dead-lettering it', async () => {
    const order: string[] = [];
    const onFailed = vi.fn((job: IJob, error: unknown) => {
      order.push(`onFailed:${job.id}:${job.attempts}:${(error as Error).message}`);
    });
    const s = await setup({ token: 'delivery', attempts: 4, onFailed });
    s.dead.mockImplementation(() => {
      order.push('deadLetter');
      return Promise.resolve();
    });
    try {
      await s.runtime.advanceMs(200);
      expect(s.processor).not.toHaveBeenCalled();
      expect(order).toEqual(['onFailed:j:4:attempt budget exhausted', 'deadLetter']);
    } finally {
      await s.service.disconnect();
    }
  });
  it('still dead-letters an abandoned job when onFailed throws', async () => {
    const s = await setup({
      token: 'delivery',
      attempts: 4,
      onFailed: () => {
        throw new Error('callback');
      },
    });
    try {
      await s.runtime.advanceMs(200);
      expect(s.dead).toHaveBeenCalledTimes(1);
      expect(s.log.mock.calls.map(([message]) => message)).toContain(
        'queue onFailed callback threw',
      );
    } finally {
      await s.service.disconnect();
    }
  });
  it('reports stale settlement as failed and releases concurrency for later jobs', async () => {
    const s = await setup({ token: 'delivery', stale: true });
    try {
      await s.runtime.advanceMs(200);
      expect(s.settled).toHaveBeenCalledWith('completed', 'failed');
      expect(s.log.mock.calls.map(([message]) => message)).toContain('queue job settlement failed');
      await s.service.add('email', {});
      await s.runtime.advanceMs(200);
      expect(s.processor).toHaveBeenCalledTimes(2);
    } finally {
      await s.service.disconnect();
    }
  });
  it('can abandon an over-budget job without a claim token or diagnostics', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const dead = vi.spyOn(adapter, 'deadLetter');
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
    await service.connect();
    try {
      service.process('email', () => {
        throw new Error('must not run');
      });
      await adapter.enqueue({
        id: 'j',
        name: 'email',
        data: {},
        attempts: 4,
        maxAttempts: 3,
        availableAtMs: 0,
      });
      await runtime.advanceMs(100);
      expect(dead).toHaveBeenCalledWith('email', 'j', 100, 'j');
    } finally {
      await service.disconnect();
    }
  });
});
