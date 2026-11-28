import { describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@setu-ts/common';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { outboxHarness } from '../../fixtures/outbox.ts';

describe('Outbox relay saturation', () => {
  async function harness(schedule: boolean) {
    const h = await outboxHarness();
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = new OutboxService({
      runtime: h.clock.runtime,
      broker: h.broker,
      options: resolveOutboxOptions({ store: h.store, relay: { schedule, publishLimit: 100 } }),
      logger: () => logger as unknown as ILogger,
    });
    service.activate({ kind: 'single', store: h.store });
    for (let n = 0; n < 150; n++) await h.write({ n });
    return { ...h, service, logger };
  }
  it.each([true, false])('drains 150 rows without a second tick, schedule=%s', async (schedule) => {
    const h = await harness(schedule);
    if (schedule) expect((await h.service.sweep()).endedBy).toBe('publish-limit');
    else h.service.dispatch();
    // Serial rows each perform several awaited store operations.
    for (let i = 0; i < 20000 && h.broker.published.length < 100; i++) await Promise.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.broker.published).toHaveLength(100);
    for (let i = 0; i < 50; i++) h.service.dispatch();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.broker.published).toHaveLength(100);
    await h.clock.advance(0);
    for (let i = 0; i < 20000 && h.broker.published.length < 150; i++) await Promise.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.broker.published).toHaveLength(150);
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith('outbox relay is at its sweep budget', {
      publishLimit: 100,
      intervalMs: 1000,
    });
    expect(h.logger.info).toHaveBeenCalledExactlyOnceWith('outbox relay caught up');
    expect((await h.store.stats()).pending).toBe(0);
    await h.service.close();
  });
  it('does not spin or warn on a full failed sweep', async () => {
    const h = await harness(true);
    h.broker.behaviour = () => Promise.reject(new Error('offline'));
    const result = await h.service.sweep();
    expect(result).toMatchObject({ endedBy: 'publish-limit', failures: 100 });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.broker.calls).toHaveLength(100);
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.info).not.toHaveBeenCalled();
    await h.service.close();
  });
  it('keeps the saturation episode through a failed follow-up until a successful lap', async () => {
    const h = await harness(false);
    h.broker.behaviour = () =>
      h.broker.calls.length > 100 ? Promise.reject(new Error('offline')) : undefined;
    await h.service.sweep();
    await h.clock.advance(0);
    for (let i = 0; i < 20000 && h.broker.calls.length < 150; i++) await Promise.resolve();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.info).not.toHaveBeenCalled();
    h.broker.behaviour = undefined;
    h.clock.advanceWall(1001);
    await h.service.sweep();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledExactlyOnceWith('outbox relay caught up');
    await h.service.close();
  });
  it('closing stops the full-sweep chain', async () => {
    const h = await harness(false);
    const gate = Promise.withResolvers<void>();
    h.broker.behaviour = () => gate.promise;
    h.service.dispatch();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    const stopped = h.service.close();
    gate.resolve();
    await stopped;
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(h.broker.calls).toHaveLength(1);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
  it('runs a timer callback between full follow-up sweeps and cancels a queued follow-up on close', async () => {
    const h = await harness(false);
    for (let n = 150; n < 350; n++) await h.write({ n });
    await h.service.sweep();
    const between: number[] = [];
    h.broker.behaviour = () => {
      if (h.broker.calls.length === 101)
        h.clock.runtime.setTimeout(() => between.push(h.broker.published.length), 0);
      return undefined;
    };
    for (let n = 0; n < 100; n++) await Promise.resolve();
    expect(h.clock.timerCount()).toBe(1);
    // Fire the first follow-up; its first row schedules an independent timer.
    // The next follow-up cannot begin until a later macrotask.
    await h.clock.advance(0);
    expect(between).toEqual([]);
    for (let n = 0; n < 20000 && h.broker.published.length < 200; n++) await Promise.resolve();
    for (let n = 0; n < 100; n++) await Promise.resolve();
    expect(h.broker.published).toHaveLength(200);
    expect(h.clock.timerCount()).toBe(2);
    await h.clock.advance(0);
    expect(between).toEqual([200]);
    for (let n = 0; n < 20000 && h.broker.published.length < 300; n++) await Promise.resolve();
    for (let n = 0; n < 100; n++) await Promise.resolve();
    expect(h.broker.published).toHaveLength(300);
    expect(h.clock.timerCount()).toBe(1);
    await h.service.close();
    expect(h.clock.timerCount()).toBe(0);
    await h.clock.advance(0);
    expect(h.broker.published).toHaveLength(300);
  });
});
