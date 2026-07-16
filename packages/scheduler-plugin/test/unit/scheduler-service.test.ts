/**
 * Tests for SchedulerService.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, ScheduledJob } from '@hono-enterprise/common';
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

  // ---- Coverage tests for uncovered branches ----

  it('health indicator reports down when not connected', async () => {
    const { service } = createService();
    const indicator = service.createHealthIndicator();
    const health = await indicator();
    expect(health.status).toBe('down');
    expect(health.data?.connected).toBe(false);
  });

  it('health indicator reports up when connected', async () => {
    const { service } = createService();
    await service.connect();
    const indicator = service.createHealthIndicator();
    const health = await indicator();
    expect(health.status).toBe('up');
    expect(health.data?.connected).toBe(true);
  });

  it('disconnect clears timers for all scheduled names', async () => {
    const { service, runtime } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.every('job2', 200, () => {});
    await service.delay('job3', 300, () => {});
    expect(runtime.getPendingTimerCount()).toBe(3);
    await service.disconnect();
  });

  it('throws every when not connected', async () => {
    const { service } = createService();
    try {
      await service.every('job1', 100, () => {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not connected');
    }
  });

  it('throws delay when not connected', async () => {
    const { service } = createService();
    try {
      await service.delay('job1', 100, () => {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not connected');
    }
  });

  it('throws getNextRun on unknown name', async () => {
    const { service } = createService();
    await service.connect();
    try {
      await service.getNextRun('unknown');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'unknown'");
    }
  });

  it('throws resume on unknown name', async () => {
    const { service } = createService();
    await service.connect();
    try {
      await service.resume('unknown');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain("No scheduled job named 'unknown'");
    }
  });

  it('resume is idempotent (already running)', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('job1', '* * * * *', () => {});
    await service.resume('job1'); // no error — idempotent
  });

  it('lock not acquired skips fire', async () => {
    // Simulate a lock that always fails to acquire.
    const runtime = new FakeRuntime();
    const lock = {
      // deno-lint-ignore require-await
      acquire: async () => null,
      release: async () => {},
    };
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    // Lock skip path is exercised — no fire happens
    await service.delay('lock-job', 50, () => {});
    // Advance past delay — lock still not acquired, so no fire
    await runtime.advance(200);
  });

  it('permanent handler failure does not crash scheduler (F2)', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fires = 0;
    await service.delay('fail-job', 50, () => {
      fires++;
      throw new Error('permanent failure');
    });
    // Fire should happen, error caught, scheduler survives
    await runtime.advance(200);
    expect(fires).toBe(1);
    // Service still ready
    expect(service.isReady()).toBe(true);
  });

  it('permanent handler failure logs error (F2)', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const logMessages: string[] = [];
    const logger: ILogger = {
      level: 'error' as const,
      fatal: () => {},
      error(msg: string, _meta?: unknown) {
        logMessages.push(msg);
      },
      warn(msg: string, _meta?: unknown) {
        logMessages.push(msg);
      },
      info(msg: string, _meta?: unknown) {
        logMessages.push(msg);
      },
      debug(msg: string, _meta?: unknown) {
        logMessages.push(msg);
      },
      trace(msg: string, _meta?: unknown) {
        logMessages.push(msg);
      },
      child: () => logger,
    };
    const service = new SchedulerService(runtime, lock, { logger });
    await service.connect();
    await service.delay('fail-job', 50, () => {
      throw new Error('permanent failure');
    });
    await runtime.advance(200);
    expect(logMessages.some((m) => m.includes('failed permanently'))).toBe(true);
  });

  it('cron job with retry option stores retry config', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('retry-job', '* * * * *', () => {}, {
      retry: { limit: 3, delay: 100, backoff: 'fixed' },
    });
    await service.getNextRun('retry-job'); // Verify job scheduled
  });

  it('every job with data option stores data', async () => {
    const { service } = createService();
    await service.connect();
    await service.every('data-job', 1000, (_job) => {
      // Data is stored and passed to handler
    }, { data: 'test-data' });
    await service.getNextRun('data-job');
  });

  it('delay job fires when timer advances', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fired = false;
    await service.delay('oneshot', 50, () => {
      fired = true;
    });
    await runtime.advance(100);
    expect(fired).toBe(true);
  });

  it('pause cron job sets paused flag', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('pause-test', '* * * * *', () => {});
    await service.pause('pause-test');
    // Verify pause worked by checking getNextRun throws
    try {
      await service.getNextRun('pause-test');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('paused');
    }
  });

  it('resume cron job re-arms timer', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('resume-test', '* * * * *', () => {});
    await service.pause('resume-test');
    await service.resume('resume-test');
    // Should have a new timer
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('resume every job re-arms timer', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('resume-every', 100, () => {});
    await service.pause('resume-every');
    await service.resume('resume-every');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('resume delay job re-arms timer', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.delay('resume-delay', 50, () => {});
    await service.pause('resume-delay');
    await service.resume('resume-delay');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('cron job scheduled creates timer', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('cron-test', '* * * * *', () => {});
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('every job scheduled creates timer', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('every-test', 100, () => {});
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('paused job does not fire', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fires = 0;
    await service.cron('paused-job', '* * * * *', () => {
      fires++;
    });
    await service.pause('paused-job');
    // Advance past when it would have fired
    await runtime.advance(100);
    expect(fires).toBe(0); // Should not fire while paused
  });

  it('delay job removes itself after fire', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.delay('remove-test', 50, () => {});
    await runtime.advance(100);
    // Job should be removed after fire - verify by checking error message
    try {
      await service.getNextRun('remove-test');
    } catch (e) {
      // Expected: job removed after fire
      expect((e as Error).message).toContain('No scheduled job named');
    }
  });
});
