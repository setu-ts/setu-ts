/**
 * Timers are driven through an inert fake, never real time: a test that waited
 * out a real 5-second budget would be slow enough that nobody would keep it,
 * and one that shortened the budget to keep it fast would stop testing the
 * default.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { TimerHandle } from '@setu-ts/common';

import {
  CloudflareRemoteHandlerError,
  CloudflareRequestTimeoutError,
} from '../../../src/errors.ts';
import { encodeReplyEnvelope } from '../../../src/messaging/message-envelope.ts';
import {
  type CorrelationTimers,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestCorrelation,
} from '../../../src/messaging/request-correlation.ts';

/**
 * Timers that never fire on their own.
 *
 * The handle is an OBJECT, not a number, because `TimerHandle` is deliberately
 * opaque in `common` — the M53 defect where a broker coerced a handle with
 * `Number(...)` and silently produced `NaN` was invisible to every fake that
 * handed out numbers.
 */
class InertTimers implements CorrelationTimers {
  readonly scheduled: { readonly handle: object; readonly fn: () => void; readonly ms: number }[] =
    [];
  readonly cleared: TimerHandle[] = [];

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = { id: this.scheduled.length };
    this.scheduled.push({ handle, fn, ms });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.cleared.push(handle);
  }

  /** Fires the timer scheduled at `index`, as the runtime would. */
  fire(index: number): void {
    this.scheduled[index]?.fn();
  }

  /** How many scheduled timers have not been cleared. */
  get outstanding(): number {
    return this.scheduled.length - this.cleared.length;
  }
}

describe('RequestCorrelation', () => {
  it('resolves a registered request when its reply arrives', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const reply = correlation.register<number>('corr-1', 'sum', 1000);
    expect(correlation.size).toBe(1);

    correlation.settle(encodeReplyEnvelope('corr-1', { ok: true, payload: 3 }));

    expect(await reply).toBe(3);
    expect(correlation.size).toBe(0);
    // The timer must be cleared, or a settled request keeps a handle alive.
    expect(timers.outstanding).toBe(0);
  });

  it('rejects with a remote-handler error when the responder threw', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const reply = correlation.register('corr-1', 'sum', 1000);
    correlation.settle(encodeReplyEnvelope('corr-1', { ok: false, error: 'bad input' }));

    await expect(reply).rejects.toThrow(CloudflareRemoteHandlerError);
    await expect(reply).rejects.toThrow('bad input');
    expect(timers.outstanding).toBe(0);
  });

  it('rejects a failed reply carrying no message', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const reply = correlation.register('corr-1', 'sum', 1000);
    correlation.settle({ v: 1, kind: 'rpc-reply', correlationId: 'corr-1', ok: false });

    await expect(reply).rejects.toThrow('unknown error');
  });

  it('rejects with a timeout error when the budget elapses, naming the topic', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const reply = correlation.register('corr-1', 'sum', 250);
    expect(timers.scheduled[0]?.ms).toBe(250);

    timers.fire(0);

    await expect(reply).rejects.toThrow(CloudflareRequestTimeoutError);
    await expect(reply).rejects.toThrow("'sum'");
    // The entry is gone, so a late reply cannot resolve an already-rejected
    // promise (which would be a silent no-op) or leak the map entry.
    expect(correlation.size).toBe(0);
  });

  it('names max_batch_timeout in the timeout message, the usual cause', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);
    const reply = correlation.register('corr-1', 'sum', DEFAULT_REQUEST_TIMEOUT_MS);
    timers.fire(0);
    await expect(reply).rejects.toThrow('max_batch_timeout');
  });

  it('drops a reply that arrives after its timeout', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const reply = correlation.register('corr-1', 'sum', 250);
    timers.fire(0);
    await expect(reply).rejects.toThrow(CloudflareRequestTimeoutError);

    expect(correlation.settle(encodeReplyEnvelope('corr-1', { ok: true, payload: 3 }))).toBe(false);
  });

  it('drops a reply nothing is waiting for, as at-least-once delivery produces', () => {
    const correlation = new RequestCorrelation(new InertTimers());
    expect(correlation.settle(encodeReplyEnvelope('never-sent', { ok: true, payload: 1 })))
      .toBe(false);
  });

  it('settles only the request a reply correlates to', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const first = correlation.register<string>('corr-1', 'sum', 1000);
    const second = correlation.register<string>('corr-2', 'sum', 1000);

    correlation.settle(encodeReplyEnvelope('corr-2', { ok: true, payload: 'second' }));
    expect(await second).toBe('second');
    expect(correlation.size).toBe(1);

    correlation.settle(encodeReplyEnvelope('corr-1', { ok: true, payload: 'first' }));
    expect(await first).toBe('first');
  });

  it('abandon() clears the timer without settling the caller', () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    // Deliberately not awaited: abandoning leaves the promise pending forever,
    // which is correct — the caller is receiving the publish failure directly.
    void correlation.register('corr-1', 'sum', 1000).catch(() => undefined);
    correlation.abandon('corr-1');

    expect(correlation.size).toBe(0);
    expect(timers.outstanding).toBe(0);
  });

  it('abandon() of an unknown id does nothing', () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);
    correlation.abandon('never-registered');
    expect(timers.cleared).toEqual([]);
  });

  it('rejectAll() fails every in-flight request and clears every timer', async () => {
    const timers = new InertTimers();
    const correlation = new RequestCorrelation(timers);

    const first = correlation.register('corr-1', 'sum', 1000);
    const second = correlation.register('corr-2', 'sum', 1000);

    correlation.rejectAll(new Error('disconnected'));

    await expect(first).rejects.toThrow('disconnected');
    await expect(second).rejects.toThrow('disconnected');
    expect(correlation.size).toBe(0);
    expect(timers.outstanding).toBe(0);
  });
});
