import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

describe('scheduler honours long waits', () => {
  let runtime: FakeRuntime;
  let service: SchedulerService;
  beforeEach(async () => {
    runtime = new FakeRuntime();
    service = new SchedulerService(runtime, new MemoryLock(runtime));
    await service.connect();
  });
  afterEach(async () => {
    await service.disconnect();
  });

  it('delay(30 days) fires once at its deadline, never earlier', async () => {
    const start = runtime.now();
    const times: number[] = [];
    await service.delay('long-delay', MONTH_MS, () => {
      times.push(runtime.now());
    });
    expect(await service.getNextRun('long-delay')).toBe(start + MONTH_MS);
    await runtime.advanceTo(start + 1);
    expect(times).toEqual([]);
    await runtime.advanceTo(start + MONTH_MS - 1);
    expect(times).toEqual([]);
    await runtime.advanceTo(start + MONTH_MS);
    await runtime.advanceTo(start + 2 * MONTH_MS);
    expect(times).toEqual([start + MONTH_MS]);
  });

  it('a monthly cron fires once per month across three months', async () => {
    runtime.setTime(Date.UTC(2027, 0, 1));
    const times: number[] = [];
    await service.cron('monthly', '0 0 1 * *', () => {
      times.push(runtime.now());
    });
    await runtime.advanceTo(runtime.now() + 1);
    expect(times).toEqual([]);
    const expected: number[] = [];
    for (const month of [1, 2, 3]) {
      const due = Date.UTC(2027, month, 1);
      await runtime.advanceTo(due - 1);
      expect(times).toEqual(expected);
      await runtime.advanceTo(due);
      expected.push(due);
      expect(times).toEqual(expected);
      await runtime.advanceTo(due + 1);
      expect(times).toEqual(expected);
    }
  });

  it('a leap-day cron waits until the next 29 February', async () => {
    const start = Date.UTC(2025, 2, 1);
    const due = Date.UTC(2028, 1, 29);
    runtime.setTime(start);
    const times: number[] = [];
    await service.cron('leap-day', '0 0 29 2 *', () => {
      times.push(runtime.now());
    });
    expect(await service.getNextRun('leap-day')).toBe(due);
    await runtime.advanceTo(start + 1);
    expect(times).toEqual([]);
    await runtime.advanceTo(due - 1);
    expect(times).toEqual([]);
    await runtime.advanceTo(due);
    await runtime.advanceTo(due + DAY_MS);
    expect(times).toEqual([due]);
  });

  it('honours an every interval above the timer limit on its epoch grid', async () => {
    runtime.setTime(0);
    const times: number[] = [];
    await service.every('long-interval', MONTH_MS, () => {
      times.push(runtime.now());
    });
    await runtime.advanceTo(1);
    expect(times).toEqual([]);
    await runtime.advanceTo(MONTH_MS - 1);
    expect(times).toEqual([]);
    await runtime.advanceTo(MONTH_MS);
    await runtime.advanceTo(2 * MONTH_MS);
    expect(times).toEqual([MONTH_MS, 2 * MONTH_MS]);
  });

  for (const action of ['pause', 'remove', 'disconnect'] as const) {
    it(`${action} cancels the live timer after a chunk boundary`, async () => {
      const start = runtime.now();
      const times: number[] = [];
      await service.delay('cancel-long', MONTH_MS, () => {
        times.push(runtime.now());
      });
      await runtime.advanceTo(start + 25 * DAY_MS);
      if (action === 'disconnect') await service.disconnect();
      else await service[action]('cancel-long');
      expect(runtime.getPendingTimerCount()).toBe(0);
      await runtime.advanceTo(start + MONTH_MS);
      expect(times).toEqual([]);
      if (action === 'pause') {
        await service.resume('cancel-long');
        await runtime.advanceTo(start + 2 * MONTH_MS - 1);
        expect(times).toEqual([]);
        await runtime.advanceTo(start + 2 * MONTH_MS);
        expect(times).toEqual([start + 2 * MONTH_MS]);
      }
    });
  }

  it('an exponential retry exceeding the timer limit waits its full backoff', async () => {
    runtime.setTime(0);
    const times: number[] = [];
    await service.delay(
      'long-retry',
      0,
      (job) => {
        times.push(runtime.now());
        if (job.attempts < 3) throw new Error('retry me');
      },
      { retry: { limit: 3, delay: 15 * DAY_MS, backoff: 'exponential' } },
    );
    await runtime.advanceTo(0);
    expect(times).toEqual([0]);
    await runtime.advanceTo(15 * DAY_MS - 1);
    expect(times).toEqual([0]);
    await runtime.advanceTo(15 * DAY_MS);
    expect(times).toEqual([0, 15 * DAY_MS]);
    await runtime.advanceTo(15 * DAY_MS + 1);
    expect(times).toEqual([0, 15 * DAY_MS]);
    await runtime.advanceTo(45 * DAY_MS - 1);
    expect(times).toEqual([0, 15 * DAY_MS]);
    await runtime.advanceTo(45 * DAY_MS);
    expect(times).toEqual([0, 15 * DAY_MS, 45 * DAY_MS]);
    expect(runtime.getPendingTimerCount()).toBe(0);
  });
});
