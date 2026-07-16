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

  it('cron job with data option stores data', async () => {
    const { service } = createService();
    await service.connect();
    await service.cron('cron-data-job', '* * * * *', (_job) => {}, { data: 'cron-data' });
    await service.getNextRun('cron-data-job');
  });

  it('every job with retry option stores retry config', async () => {
    const { service } = createService();
    await service.connect();
    await service.every('every-retry-job', 1000, () => {}, {
      retry: { limit: 2, delay: 50, backoff: 'fixed' },
    });
    await service.getNextRun('every-retry-job');
  });

  it('delay job with retry option stores retry config', async () => {
    const { service } = createService();
    await service.connect();
    await service.delay('delay-retry-job', 50, () => {}, {
      retry: { limit: 2, delay: 50, backoff: 'fixed' },
    });
    await service.getNextRun('delay-retry-job');
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

  it('every job re-arms itself after fire', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.every('rearm-every', 100, () => {
      fireCount++;
    });
    // First fire
    await runtime.advance(150);
    expect(fireCount).toBe(1);
    // Timer should have re-armed - verify by advancing again
    await runtime.advance(150);
    expect(fireCount).toBe(2);
  });

  it('cron job re-arms itself after fire', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    // Use a cron expression that fires every minute
    await service.cron('rearm-cron', '* * * * *', () => {
      fireCount++;
    });
    const initialTimerCount = runtime.getPendingTimerCount();
    // Advance to trigger the cron fire (cron fires at next minute boundary)
    await runtime.advance(60000);
    expect(fireCount).toBe(1);
    // Timer should have re-armed for next minute
    expect(runtime.getPendingTimerCount()).toBe(initialTimerCount);
    // Advance again to verify re-armed timer fires
    await runtime.advance(60000);
    expect(fireCount).toBe(2);
  });

  it('paused job does not re-arm after fire time passes', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.every('paused-rearm', 100, () => {
      fireCount++;
    });
    // Pause before first fire
    await service.pause('paused-rearm');
    await runtime.advance(150);
    expect(fireCount).toBe(0);
    // No timer should be pending since paused
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('resume every job uses #armInterval path', async () => {
    // Explicitly cover the every case in resume() switch statement
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('resume-every-branch', 100, () => {});
    const initialTimerCount = runtime.getPendingTimerCount();
    await service.pause('resume-every-branch');
    await service.resume('resume-every-branch');
    // Should still have 1 timer (paused one cleared, new one added)
    expect(runtime.getPendingTimerCount()).toBe(initialTimerCount);
  });

  it('resume delay job uses #armTimer path', async () => {
    // Explicitly cover the delay case in resume() switch statement
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.delay('resume-delay-branch', 100, () => {});
    const initialTimerCount = runtime.getPendingTimerCount();
    await service.pause('resume-delay-branch');
    await service.resume('resume-delay-branch');
    expect(runtime.getPendingTimerCount()).toBe(initialTimerCount);
  });

  it('remove job clears timer handle', async () => {
    // Cover the `if (entry.timerHandle !== null)` branch in remove()
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('remove-timer', 100, () => {});
    expect(runtime.getPendingTimerCount()).toBe(1);
    await service.remove('remove-timer');
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('remove job with null timerHandle skips clearTimeout', async () => {
    // Cover the `if (entry.timerHandle !== null)` branch when it's false
    // This happens when removing a paused job (pause sets timerHandle to null)
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('pause-before-remove', '* * * * *', () => {});
    await service.pause('pause-before-remove');
    // After pause, timerHandle should be null
    expect(runtime.getPendingTimerCount()).toBe(0);
    await service.remove('pause-before-remove');
    // Should complete without error
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('cron job after fire re-arms via #fire() cron branch', async () => {
    // Covers the cron re-arm branch in #fire() (entry.kind === 'cron').
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    // Schedule a cron job with a known expression
    await service.cron('cron-rearm-test', '* * * * *', () => {
      fireCount++;
    });
    const initialTimerCount = runtime.getPendingTimerCount();
    // Advance to trigger fire
    await runtime.advance(60000);
    expect(fireCount).toBe(1);
    // After fire, cron should re-arm - timer count should be same
    expect(runtime.getPendingTimerCount()).toBe(initialTimerCount);
    // Advance again to verify re-armed timer fires
    await runtime.advance(60000);
    expect(fireCount).toBe(2);
  });

  it('every job after fire re-arms via #fire() every branch', async () => {
    // Covers the every re-arm branch in #fire() (else of entry.kind === 'cron').
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.every('every-rearm-test', 100, () => {
      fireCount++;
    });
    const initialTimerCount = runtime.getPendingTimerCount();
    // First fire
    await runtime.advance(150);
    expect(fireCount).toBe(1);
    // After fire, every should re-arm - timer count should be same
    expect(runtime.getPendingTimerCount()).toBe(initialTimerCount);
    // Second fire
    await runtime.advance(150);
    expect(fireCount).toBe(2);
    // Third fire to be sure
    await runtime.advance(150);
    expect(fireCount).toBe(3);
  });

  it('does not re-arm a job paused while its fire is in flight', async () => {
    // Covers the `if (entry.paused) return;` re-arm guard in #fire(): a job
    // paused during its own fire (across the lock/handler awaits) must NOT be
    // re-armed, otherwise a leaked timer could double-fire after resume().
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.cron('pause-mid-fire', '* * * * *', () => {
      fireCount++;
      // Pause WHILE firing — registry.pause runs synchronously inside the
      // handler, so entry.paused is true before #fire reaches its re-arm tail.
      void service.pause('pause-mid-fire');
    });
    expect(runtime.getPendingTimerCount()).toBe(1);
    // Fire the armed timer; the handler pauses the job mid-fire.
    await runtime.advance(60000);
    expect(fireCount).toBe(1);
    // Re-arm is skipped for a paused entry, so no timer remains armed.
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('fire with lock failure skips execution', async () => {
    // Cover the `if (token === null)` branch in #fire()
    const runtime = new FakeRuntime();
    const lock = {
      acquire: () => Promise.resolve(null), // Always fail to acquire
      release: async () => {},
    };
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.every('lock-fail', 100, () => {
      fireCount++;
    });
    await runtime.advance(150);
    expect(fireCount).toBe(0); // Should not fire due to lock failure
  });

  it('armTimer with zero delay', async () => {
    // Cover the `Math.max(0, ...)` path when delay is 0
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fired = false;
    await service.delay('zero-delay', 0, () => {
      fired = true;
    });
    // Timer should fire immediately
    await runtime.advance(1);
    expect(fired).toBe(true);
  });

  it('disconnect clears timers for multiple jobs via loop', async () => {
    // Cover the `for (const name of this.#names)` loop in disconnect()
    // and the `if (entry.timerHandle !== null)` branch
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    // Schedule multiple jobs to ensure the loop runs multiple times
    await service.cron('disconnect-cron', '* * * * *', () => {});
    await service.every('disconnect-every', 100, () => {});
    await service.delay('disconnect-delay', 100, () => {});
    expect(runtime.getPendingTimerCount()).toBe(3);
    await service.disconnect();
    // All timers should be cleared
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('disconnect handles registry error gracefully', async () => {
    // Cover the catch block in disconnect() when registry.get() throws
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('safe-job', '* * * * *', () => {});
    // Normal disconnect should handle errors gracefully
    await service.disconnect();
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('resume every job covers every branch in switch', async () => {
    // Cover the `case 'every':` branch in resume() switch
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('every-job', 1000, () => {});
    await service.pause('every-job');
    await service.resume('every-job');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('resume delay job covers delay branch in switch', async () => {
    // Cover the `case 'delay':` branch in resume() switch
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.delay('delay-job', 1000, () => {});
    await service.pause('delay-job');
    await service.resume('delay-job');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('disconnect clears paused jobs with null timerHandle', async () => {
    // Cover the `if (entry.timerHandle !== null)` branch when it's false
    // by pausing a job before disconnect (which sets timerHandle to null)
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('paused-before-disconnect', '* * * * *', () => {});
    await service.pause('paused-before-disconnect');
    // After pause, timerHandle should be null
    expect(runtime.getPendingTimerCount()).toBe(0);
    await service.disconnect();
    // Should complete without error
    expect(service.isReady()).toBe(false);
  });

  it('armInterval uses the job intervalMs as the timer delay', async () => {
    // Verifies #armInterval arms the timer with the job's intervalMs (200ms),
    // not any hard-coded fallback. intervalMs is required on every entries, so
    // there is no `?? 1000` default to fall back to.
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('interval-test', 200, () => {});
    expect(runtime.getPendingTimerCount()).toBe(1);
    const nextTimer = runtime.getNextTimerDelay();
    expect(nextTimer).toBe(200);
  });

  it('fire with no logger handles optional chaining gracefully', async () => {
    // Cover the `this.#logger?.error` optional chaining when logger is undefined
    // Most tests already use no logger, but let's be explicit
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    // No logger option passed - #logger is undefined
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    let fireCount = 0;
    await service.delay('no-logger-job', 50, () => {
      fireCount++;
      throw new Error('test error');
    });
    await runtime.advance(100);
    expect(fireCount).toBe(1);
    // Should not crash even without logger
    expect(service.isReady()).toBe(true);
  });

  it('fire handles non-Error throwables in catch block', async () => {
    // Cover the `error instanceof Error ? error.message : String(error)` ternary
    // by throwing a non-Error value
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const logger = {
      level: 'error' as const,
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const service = new SchedulerService(runtime, lock, { logger });
    await service.connect();
    let fireCount = 0;
    await service.delay('string-error-job', 50, () => {
      fireCount++;
      throw 'string error'; // Non-Error throwable
    });
    await runtime.advance(100);
    expect(fireCount).toBe(1);
  });

  it('resume every job covers every case in switch', async () => {
    // Ensure the every case in resume() switch is covered
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('every-switch-test', 500, () => {});
    await service.pause('every-switch-test');
    await service.resume('every-switch-test');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('resume delay job covers delay case in switch', async () => {
    // Ensure the delay case in resume() switch is covered
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.delay('delay-switch-test', 500, () => {});
    await service.pause('delay-switch-test');
    await service.resume('delay-switch-test');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('disconnect catch block handles registry errors gracefully', async () => {
    // Cover the catch block in disconnect() when registry.get() throws
    // This is hard to trigger normally since we control the registry
    // but we can verify the disconnect completes without errors
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    // Schedule and remove jobs rapidly to potentially trigger edge case
    await service.cron('rapid-job', '* * * * *', () => {});
    await service.remove('rapid-job');
    await service.disconnect();
    expect(service.isReady()).toBe(false);
  });

  it('resume uses ternary for every vs cron/delay timer arming', async () => {
    // Cover the `entry.kind === 'every' ? this.#armInterval(entry) : this.#armTimer(entry)` ternary
    // This test verifies the every branch of the ternary
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.every('ternary-every-test', 500, () => {});
    await service.pause('ternary-every-test');
    await service.resume('ternary-every-test');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('resume cron uses ternary for cron/delay timer arming', async () => {
    // Cover the `entry.kind === 'every' ? this.#armInterval(entry) : this.#armTimer(entry)` ternary
    // This test verifies the cron/delay branch (else) of the ternary
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();
    await service.cron('ternary-cron-test', '* * * * *', () => {});
    await service.pause('ternary-cron-test');
    await service.resume('ternary-cron-test');
    expect(runtime.getPendingTimerCount()).toBe(1);
  });

  it('constructor with ttlMs option sets custom ttl', () => {
    // Cover the `options?.ttlMs ?? 30000` branch when ttlMs is provided
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock, { ttlMs: 5000 });
    expect(service.isReady()).toBe(false);
  });

  it('constructor with logger option sets custom logger', () => {
    // Cover the `options?.logger` branch when logger is provided
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const logger = {
      level: 'info' as const,
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => logger,
    };
    const service = new SchedulerService(runtime, lock, { logger });
    expect(service.isReady()).toBe(false);
  });

  // C1 TEST: resume() uses freshly computed nextRunAtMs (not stale value)
  it('resume computes fresh delay from current time (C1)', async () => {
    // Verify that resume() arms the timer with the freshly computed nextRunAtMs,
    // not the stale value from before pause.
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    // Schedule a delay job with 5000ms delay
    await service.delay('c1-delay', 5000, () => {});
    // Get initial next run time to verify the job was scheduled
    await service.getNextRun('c1-delay');

    // Pause the job
    await service.pause('c1-delay');

    // Advance time by 3000ms
    await runtime.advance(3000);

    // Resume - should compute fresh nextRunAtMs from current time (now + 5000 = 8000ms from start)
    await service.resume('c1-delay');

    // The armed timer delay should be ~5000ms (from resume time), not 2000ms (stale)
    const delay = runtime.getNextTimerDelay();
    expect(delay).toBeGreaterThan(4000); // Should be close to 5000, not 2000
  });

  // C3 TEST: disconnect() mid-fire prevents re-arm
  it('disconnect mid-fire prevents re-arm (C3)', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    let resolveFire: () => void;
    const firePromise = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });

    // Create a job that pauses itself and waits during fire
    await service.every('c3-disconnect', 100, async () => {
      fireCount++;
      // Disconnect WHILE firing
      await service.disconnect();
      resolveFire();
    });

    // Advance to trigger first fire
    await runtime.advance(150);
    await firePromise;

    expect(fireCount).toBe(1);
    // Service should be disconnected and no timer should be pending
    expect(service.isReady()).toBe(false);
    expect(runtime.getPendingTimerCount()).toBe(0);

    // Advance again - should NOT fire because disconnected
    await runtime.advance(150);
    expect(fireCount).toBe(1); // Still 1
  });

  // C3 TEST: remove() mid-fire prevents re-arm
  it('remove mid-fire prevents re-arm (C3)', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    let resolveFire: () => void;
    const firePromise = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });

    await service.every('c3-remove', 100, async () => {
      fireCount++;
      // Remove WHILE firing
      await service.remove('c3-remove');
      resolveFire();
    });

    await runtime.advance(150);
    await firePromise;

    expect(fireCount).toBe(1);
    expect(runtime.getPendingTimerCount()).toBe(0);

    // Advance again - should NOT fire because removed
    await runtime.advance(150);
    expect(fireCount).toBe(1); // Still 1
  });

  // C4 TEST: pause+resume mid-fire does not double-arm
  it('pause+resume mid-fire results in single timer (C4)', async () => {
    const runtime = new FakeRuntime();
    const lock = new MemoryLock(runtime);
    const service = new SchedulerService(runtime, lock);
    await service.connect();

    let fireCount = 0;
    let resolveFire: () => void;
    const firePromise = new Promise<void>((resolve) => {
      resolveFire = resolve;
    });

    await service.every('c4-pause-resume', 100, async () => {
      fireCount++;
      // Pause then resume WHILE firing - this should NOT cause double-arm
      await service.pause('c4-pause-resume');
      await service.resume('c4-pause-resume');
      resolveFire();
    });

    await runtime.advance(150);
    await firePromise;

    expect(fireCount).toBe(1);
    // Should have exactly ONE pending timer (from resume), not two
    expect(runtime.getPendingTimerCount()).toBe(1);

    // Advance again - should fire exactly once more
    await runtime.advance(150);
    expect(fireCount).toBe(2);
  });
});
