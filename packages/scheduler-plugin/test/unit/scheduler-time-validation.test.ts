import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduleOptions } from '@setu-ts/common';
import { SchedulerService } from '../../src/services/scheduler-service.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('scheduler time validation', () => {
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

  function register(
    kind: 'delay' | 'every' | 'cron',
    value: number,
    options?: ScheduleOptions,
  ): Promise<void> {
    return kind === 'cron'
      ? service.cron('time-validation', '* * * * *', () => {}, options)
      : service[kind]('time-validation', value, () => {}, options);
  }

  const unsafeValues: readonly [string, unknown][] = [
    ['Symbol', Symbol('invalid time')],
    [
      'throwing toString',
      {
        toString: () => {
          throw new Error('must not stringify');
        },
      },
    ],
  ];
  for (const [label, value] of unsafeValues) {
    for (const kind of ['delay', 'every', 'cron'] as const) {
      if (kind !== 'cron') {
        it(`${kind} rejects ${label} with RangeError without rendering the value`, async () => {
          await expect(register(kind, value as never)).rejects.toBeInstanceOf(RangeError);
          expect(runtime.getPendingTimerCount()).toBe(0);
          await register(kind, 1);
        });
      }
      it(`${kind} rejects retry.delay ${label} with RangeError without rendering the value`, async () => {
        await expect(
          register(kind, 1, { retry: { limit: 2, delay: value as never, backoff: 'fixed' } }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(runtime.getPendingTimerCount()).toBe(0);
        await register(kind, 1);
      });
    }
  }

  for (const kind of ['delay', 'every'] as const) {
    const option = kind === 'delay' ? 'delayMs' : 'intervalMs';
    for (const value of [-1, NaN, Infinity, -Infinity, ...(kind === 'every' ? [0] : [])]) {
      it(`${kind} rejects ${String(value)} asynchronously, naming the job and ${option}`, async () => {
        let pending: Promise<void> | undefined;
        expect(() => {
          pending = register(kind, value);
        }).not.toThrow();
        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).rejects.toBeInstanceOf(RangeError);
        await expect(pending).rejects.toThrow(
          `Job 'time-validation': ${option} must be a finite number`,
        );
        expect(runtime.getPendingTimerCount()).toBe(0);
        // A refused registration must not reserve its name or claim a slot.
        await register(kind, 1);
      });
    }
  }

  for (const kind of ['cron', 'delay', 'every'] as const) {
    for (const delay of [-1, NaN, Infinity, -Infinity]) {
      it(`${kind} rejects retry.delay ${String(delay)} asynchronously`, async () => {
        let pending: Promise<void> | undefined;
        expect(() => {
          pending = register(kind, 1, { retry: { limit: 2, delay, backoff: 'fixed' } });
        }).not.toThrow();
        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).rejects.toBeInstanceOf(RangeError);
        await expect(pending).rejects.toThrow(
          "Job 'time-validation': retry.delay must be a finite number",
        );
        expect(runtime.getPendingTimerCount()).toBe(0);
        await register(kind, 1);
      });
    }
    for (const delay of [0, 2_147_483_648, Number.MAX_VALUE]) {
      it(`${kind} accepts retry.delay ${delay} without an upper cap`, async () => {
        await expect(
          register(kind, 1, { retry: { limit: 2, delay, backoff: 'fixed' } }),
        ).resolves.toBeUndefined();
      });
    }
  }

  for (const value of [0, 2_147_483_648, Number.MAX_VALUE]) {
    it(`accepts delayMs ${value} without an upper cap`, async () => {
      await expect(register('delay', value)).resolves.toBeUndefined();
    });
  }
  for (const value of [0.5, 2_147_483_648, Number.MAX_VALUE]) {
    it(`accepts intervalMs ${value} without an upper cap`, async () => {
      await expect(register('every', value)).resolves.toBeUndefined();
    });
  }

  it('dispatches a zero-delay job on the next tick', async () => {
    let calls = 0;
    await service.delay('zero', 0, () => {
      calls++;
    });
    expect(calls).toBe(0);
    await runtime.advanceTo(runtime.now());
    expect(calls).toBe(1);
  });
});
