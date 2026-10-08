/**
 * `IOutbox.dispatch` and closing (M107 §3.8, §3.12): coalesced to one running
 * sweep plus one follow-up, the promise handed to the `background` hook,
 * never a throw, a no-op once closing; `close()` awaits the in-flight sweep,
 * and a publish failure after closing writes nothing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger } from '@setu-ts/common';

import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import {
  FakeOutboxBroker,
  flush,
  orderPlaced,
  outboxClock,
  outboxHarness,
  row,
} from '../../fixtures/outbox.ts';

/** A promise whose resolution the test controls. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('IOutbox.dispatch', () => {
  it('coalesces a request flood to one running sweep and one follow-up', async () => {
    const handed: Promise<unknown>[] = [];
    const h = await outboxHarness({ options: { background: (p) => handed.push(p) } });
    await h.write({ n: 1 });
    const hold = gate();
    h.store.faults.failedKeys = () => hold.promise;
    for (let n = 0; n < 50; n++) h.service.dispatch();
    await flush();
    expect(h.store.count('failedKeys')).toBe(1);
    expect(handed).toHaveLength(50);
    await h.write({ n: 2 });
    hold.open();
    await Promise.all(handed);
    // The running sweep plus exactly one follow-up.
    expect(h.store.count('scanPending')).toBe(2);
    expect(h.broker.sequence()).toEqual([1, 2]);
    const results = await Promise.all(handed);
    expect(results.every((r) => r === undefined)).toBe(true); // guarded: never rejects
  });

  it('a follow-up joins a sweep that started meanwhile instead of starting another', async () => {
    const handed: Promise<unknown>[] = [];
    const h = await outboxHarness({ options: { background: (p) => handed.push(p) } });
    await h.write({ n: 1 });
    const hold = gate();
    h.store.faults.failedKeys = () => hold.promise;
    const first = h.sweep();
    h.service.dispatch(); // queues the follow-up behind the running sweep
    let second: Promise<unknown> | undefined;
    // Runs after the running sweep clears itself and before the follow-up
    // decides: a scheduled sweep starts in that window.
    first.then(() => (second = h.sweep()));
    hold.open();
    await Promise.all(handed);
    await second;
    expect(h.store.count('failedKeys')).toBe(2); // the follow-up joined, it did not start a third
    expect(h.broker.sequence()).toEqual([1]);
  });

  it('works with no background hook, and logs a sweep that rejects', async () => {
    const errors: string[] = [];
    const logger = { error: (message: string) => errors.push(message) } as unknown as ILogger;
    const clock = outboxClock();
    const broker = new FakeOutboxBroker();
    const throwingObserver = {
      published: () => {
        throw new Error('observer broke');
      },
      publishFailed: () => {},
      poisoned: () => {},
      overlap: () => {},
    };
    const base = await outboxHarness({ clock, broker });
    const service = new OutboxService({
      runtime: clock.runtime,
      broker,
      options: resolveOutboxOptions({ store: base.store }),
      logger: () => logger,
      observer: throwingObserver,
    });
    service.activate({ kind: 'single', store: base.store });
    await base.db.transaction((uow) => service.write(uow, orderPlaced, { n: 1 }));
    service.dispatch();
    await flush();
    expect(errors).toEqual(['outbox: a dispatched sweep failed']);
  });

  it('never throws, even when the background hook does', async () => {
    const errors: string[] = [];
    const logger = { error: (message: string) => errors.push(message) } as unknown as ILogger;
    const base = await outboxHarness();
    const service = new OutboxService({
      runtime: base.clock.runtime,
      broker: base.broker,
      options: resolveOutboxOptions({
        store: base.store,
        background: () => {
          throw new Error('hook broke');
        },
      }),
      logger: () => logger,
    });
    service.activate({ kind: 'single', store: base.store });
    expect(() => service.dispatch()).not.toThrow();
    expect(errors).toEqual(['outbox: a dispatched sweep failed']);
    await flush();
  });

  it('is a no-op once closing', async () => {
    const handed: Promise<unknown>[] = [];
    const h = await outboxHarness({ options: { background: (p) => handed.push(p) } });
    await h.write({ n: 1 });
    await h.service.close();
    h.service.dispatch();
    expect(handed).toEqual([]);
    expect(h.store.calls.filter((c) => c.method !== 'append')).toEqual([]);
    expect(await h.service.sweep()).toEqual({
      origin: 'scheduled',
      scanned: 0,
      published: 0,
      failures: 0,
      poisoned: 0,
      endedBy: 'closing',
    });
  });
});

describe('closing', () => {
  it('awaits the in-flight sweep and its follow-up; a publish failure after closing writes nothing', async () => {
    const h = await outboxHarness();
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ n: 2 });
    const hold = gate();
    h.broker.behaviour = () => hold.promise.then(() => Promise.reject(new Error('stopping')));
    const sweep = h.sweep();
    h.service.dispatch(); // a follow-up queued behind it never starts
    await flush();
    let closed = false;
    const closing = h.service.close().then(() => (closed = true));
    await flush();
    expect(closed).toBe(false);
    expect(h.service.closing).toBe(true);
    hold.open();
    await closing;
    expect((await sweep).endedBy).toBe('closing');
    const stored = await row(h.db, id);
    expect(stored!.attempts).toBe(0);
    expect(stored!.lastError).toBeNull();
    expect(h.store.count('markFailure')).toBe(0);
    expect(h.store.count('failedKeys')).toBe(1); // the follow-up did not run
    await h.service.close(); // idempotent
  });

  it('a sweep running when closing begins starts no further row', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    await h.write({ n: 2 });
    const hold = gate();
    h.broker.behaviour = () => hold.promise;
    const sweep = h.sweep();
    await flush();
    const closing = h.service.close();
    hold.open();
    await closing;
    const result = await sweep;
    expect(result.endedBy).toBe('closing');
    expect(h.broker.sequence()).toEqual([1]);
    expect((await row(h.db, h.broker.published[0]!.message.id as string))!.status).toBe('sent');
  });
});
