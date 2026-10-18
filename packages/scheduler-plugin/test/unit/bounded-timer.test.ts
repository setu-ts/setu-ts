import { describe, expect, it, vi } from 'vitest';
import type { TimerHandle } from '@setu-ts/common';
import { armAt, sleepUntil } from '../../src/timers/bounded-timer.ts';
import * as scheduler from '../../src/index.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

const MAX_TIMER_MS = 2_147_483_647;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

describe('bounded timers', () => {
  it('arms bounded chunks, reports every handle and fires once at the deadline', async () => {
    const runtime = new FakeRuntime();
    const start = runtime.now();
    const timers = vi.spyOn(runtime, 'setTimeout');
    const handles: TimerHandle[] = [];
    const fired: number[] = [];
    const initial = armAt(
      runtime,
      start + MONTH_MS,
      () => {
        fired.push(runtime.now());
      },
      (handle) => handles.push(handle),
    );
    expect(handles).toEqual([initial]);
    expect(timers.mock.calls.map((call) => call[1])).toEqual([MAX_TIMER_MS]);
    await runtime.advanceTo(start + MAX_TIMER_MS);
    expect(fired).toEqual([]);
    expect(timers.mock.calls.map((call) => call[1])).toEqual([
      MAX_TIMER_MS,
      MONTH_MS - MAX_TIMER_MS,
    ]);
    expect(handles).toEqual(timers.mock.results.map((result) => result.value));
    await runtime.advanceTo(start + MONTH_MS - 1);
    expect(fired).toEqual([]);
    await runtime.advanceTo(start + MONTH_MS);
    await runtime.advanceTo(start + MONTH_MS + 100);
    expect(fired).toEqual([start + MONTH_MS]);
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('re-arms after an early wake without calling onDue', async () => {
    const runtime = new FakeRuntime();
    const start = runtime.now();
    const timers = vi.spyOn(runtime, 'setTimeout');
    const onDue = vi.fn();
    const handles: TimerHandle[] = [];
    const initial = armAt(runtime, start + 100, onDue, (handle) => handles.push(handle));
    // Deliver the callback early, as a host timer can do; remove its old handle.
    runtime.clearTimeout(initial);
    runtime.setTime(start + 40);
    timers.mock.calls[0][0]();
    expect(onDue).not.toHaveBeenCalled();
    expect(runtime.getNextTimerDelay()).toBe(60);
    expect(handles).toHaveLength(2);
    await runtime.advanceTo(start + 100);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('rechecks a clock stepped backwards and honours the new remaining time', async () => {
    const runtime = new FakeRuntime();
    const start = runtime.now();
    const onDue = vi.fn();
    armAt(runtime, start + 100, onDue, () => {});
    runtime.setTime(start - 200);
    await runtime.advance(100);
    expect(onDue).not.toHaveBeenCalled();
    expect(runtime.getNextTimerDelay()).toBe(200);
    await runtime.advanceTo(start + 99);
    expect(onDue).not.toHaveBeenCalled();
    await runtime.advanceTo(start + 100);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('uses a positive re-arm even when the remaining time is below 1 ms', () => {
    const runtime = new FakeRuntime();
    runtime.setTime(0);
    const timers = vi.spyOn(runtime, 'setTimeout');
    const onDue = vi.fn();
    const handle = armAt(runtime, 0.5, onDue, () => {});
    runtime.clearTimeout(handle);
    timers.mock.calls[0][0]();
    expect(onDue).not.toHaveBeenCalled();
    expect(runtime.getNextTimerDelay()).toBe(1);
    runtime.clearAllTimers();
  });

  it('sleepUntil resolves only when its long deadline is due', async () => {
    const runtime = new FakeRuntime();
    const due = runtime.now() + MONTH_MS;
    let settled = false;
    const pending = sleepUntil(runtime, due).then(() => {
      settled = true;
    });
    await runtime.advanceTo(due - 1);
    expect(settled).toBe(false);
    await runtime.advanceTo(due);
    await pending;
    expect(settled).toBe(true);
  });

  it('a past deadline fires on the next tick, never synchronously', async () => {
    const runtime = new FakeRuntime();
    const onDue = vi.fn();
    armAt(runtime, runtime.now() - 1, onDue, () => {});
    expect(onDue).not.toHaveBeenCalled();
    expect(runtime.getNextTimerDelay()).toBe(0);
    await runtime.advanceTo(runtime.now());
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('keeps timer helpers internal to the package', () => {
    expect(scheduler).not.toHaveProperty('armAt');
    expect(scheduler).not.toHaveProperty('sleepUntil');
  });
});

describe('platform-faithful fake timers', () => {
  for (const [input, expected] of [
    [MAX_TIMER_MS, MAX_TIMER_MS],
    [MAX_TIMER_MS + 1, 1],
    [NaN, 1],
    [Infinity, 1],
  ]) {
    for (const method of ['setTimeout', 'setInterval'] as const) {
      it(`${method} records ${input} as ${expected}`, () => {
        const runtime = new FakeRuntime();
        runtime[method](() => {}, input);
        expect(runtime.getNextTimerDelay()).toBe(expected);
      });
    }
  }

  it('advanceTo orders callbacks and includes newly armed timers and intervals', async () => {
    const runtime = new FakeRuntime();
    runtime.setTime(0);
    const times: number[] = [];
    runtime.setTimeout(() => {
      times.push(runtime.now());
      runtime.setTimeout(() => {
        times.push(runtime.now());
      }, 2);
    }, 3);
    const interval = runtime.setInterval(() => {
      times.push(runtime.now());
    }, 4);
    await runtime.advanceTo(9);
    expect(times).toEqual([3, 4, 5, 8]);
    expect(runtime.now()).toBe(9);
    runtime.clearInterval(interval);
  });

  it('retains advance semantics: one call compares original delays, without same-call re-arms', async () => {
    const runtime = new FakeRuntime();
    const onDue = vi.fn();
    runtime.setTimeout(() => {
      runtime.setTimeout(onDue, 1);
    }, 5);
    await runtime.advance(5);
    expect(onDue).not.toHaveBeenCalled();
    await runtime.advance(1);
    expect(onDue).toHaveBeenCalledTimes(1);
    runtime.setTimeout(onDue, 10);
    await runtime.advance(5);
    await runtime.advance(5);
    expect(onDue).toHaveBeenCalledTimes(1);
  });
});
