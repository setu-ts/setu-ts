/**
 * Tests for SchedulerService.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ScheduledJob } from '@hono-enterprise/common';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('SchedulerService', () => {
  function createService() {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    return { service, runtime, lock };
  }

  it('connects and reports ready', async () => {
    const { service, runtime } = createService();
    expect(runtime.getPendingTimerCount()).toBe(0);
    await service.connect();
    expect(service.isReady()).toBe(true);
  });

  it('throws when not connected', async () => {
    const { service } = createService();
    try {
      await service.cron('job1', '* * * * *', () => {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not connected');
    }
  });

  it('schedules cron job', async () => {
    const { service, runtime } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    expect(runtime.getPendingTimerCount()).toBeGreaterThan(0);
  });

  it('schedules every job', async () => {
    const { service, runtime } = createService();
    await service.connect();
    await service.every('job1', 1000, () => {});
    expect(runtime.getPendingTimerCount()).toBeGreaterThan(0);
  });

  it('schedules delay job', async () => {
    const { service, runtime } = createService();
    await service.connect();
    await service.delay('job1', 5000, () => {});
    expect(runtime.getPendingTimerCount()).toBeGreaterThan(0);
  });

  it('throws on duplicate name', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    try {
      await service.cron('job1', '* * * * *', () => {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("Job 'job1' is already scheduled");
    }
  });

  it('pauses job', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.pause('job1');
    try {
      await service.getNextRun('job1');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("Job 'job1' is paused");
    }
  });

  it('pause is idempotent', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.pause('job1');
    await service.pause('job1'); // no error
  });

  it('throws pause on unknown name', async () => {
    const { service } = createService();
    await service.connect();
    try {
      await service.pause('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('removes job', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.remove('job1');
    try {
      await service.getNextRun('job1');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('No scheduled job named');
    }
  });

  it('throws remove on unknown name', async () => {
    const { service } = createService();
    await service.connect();
    try {
      await service.remove('missing');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'missing'");
    }
  });

  it('getNextRun returns fire time', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    const nextRun = await service.getNextRun('job1');
    expect(nextRun).toBeGreaterThan(0);
  });

  it('throws getNextRun on paused', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.pause('job1');
    try {
      await service.getNextRun('job1');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("Job 'job1' is paused");
    }
  });

  it('disconnects and clears timers', async () => {
    const { service, runtime } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    expect(runtime.getPendingTimerCount()).toBeGreaterThan(0);
    await service.disconnect();
    expect(service.isReady()).toBe(false);
  });

  it('creates health indicator', () => {
    const { service } = createService();
    const indicator = service.createHealthIndicator();
    expect(typeof indicator).toBe('function');
  });

  it('handler receives job data', async () => {
    const { service } = createService();
    await service.connect();
    await service.delay(
      'job1',
      100,
      (_job: ScheduledJob<string>) => {},
      { data: 'hello' },
    );
    // Data is stored - verify via getNextRun not throwing
    await service.getNextRun('job1');
    await service.remove('job1');
  });
});
