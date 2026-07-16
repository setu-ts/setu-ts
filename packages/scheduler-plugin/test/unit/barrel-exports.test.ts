/**
 * Tests for barrel exports (src/index.ts).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as scheduler from '../../src/index.ts';
import type {
  DistributedLockOptions,
  IDistributedLock,
  IRedisLockClient,
  IScheduler,
  RetryOptions,
  ScheduledJob,
  ScheduleOptions,
  SchedulerBackoff,
  SchedulerJobHandler,
  SchedulerPluginOptions,
} from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports SchedulerPlugin', () => {
    expect(typeof scheduler.SchedulerPlugin).toBe('function');
  });

  it('exports the plugin-owned types, each usable to type a real value', () => {
    const lock: IDistributedLock = {
      acquire: () => Promise.resolve('token'),
      release: () => Promise.resolve(),
    };
    const client: IRedisLockClient = {
      set: () => Promise.resolve('OK'),
      quit: () => Promise.resolve(),
      eval: () => Promise.resolve(1),
    };
    const lockOptions: DistributedLockOptions = {
      enabled: true,
      storage: 'redis',
      url: 'redis://localhost:6379',
      ttlMs: 30000,
      client,
      lock,
    };
    const options: SchedulerPluginOptions = { timezone: 'UTC', distributedLock: lockOptions };

    expect(options.distributedLock?.storage).toBe('redis');
    expect(options.distributedLock?.ttlMs).toBe(30000);
  });

  it('re-exports the common scheduler contract types', () => {
    const job: ScheduledJob<{ userId: string }> = {
      id: 'job-1',
      name: 'send-followup',
      data: { userId: '123' },
      attempts: 1,
    };
    const handler: SchedulerJobHandler<{ userId: string }> = (j) => {
      expect(j.data.userId).toBe('123');
    };
    const backoff: SchedulerBackoff = 'exponential';
    const retry: RetryOptions = { limit: 3, delay: 1000, backoff };
    const scheduleOptions: ScheduleOptions<{ userId: string }> = { data: { userId: '123' }, retry };

    // IScheduler is the token's documented interface — a structural stand-in
    // must satisfy it for the re-export to be usable by consumers.
    const noop = () => Promise.resolve();
    const svc: IScheduler = {
      cron: noop,
      every: noop,
      delay: noop,
      pause: noop,
      resume: noop,
      remove: noop,
      getNextRun: () => Promise.resolve(0),
    };

    handler(job);
    expect(scheduleOptions.retry?.backoff).toBe('exponential');
    expect(typeof svc.cron).toBe('function');
  });

  it('does not export internal symbols', () => {
    // These should NOT be exported from the barrel
    expect((scheduler as Record<string, unknown>)['SchedulerService']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['JobRegistry']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['RedisLock']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['MemoryLock']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['cronNextMs']).toBeUndefined();
    expect((scheduler as Record<string, unknown>)['computeBackoffMs']).toBeUndefined();
  });
});
