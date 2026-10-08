import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { WorkerBudget } from '../../src/pool/worker-budget.ts';
import type { IWorkerBudgetPool } from '../../src/pool/worker-budget.ts';

function waiter(starved = true): IWorkerBudgetPool & { wakes: number; needed: boolean } {
  const pool = {
    wakes: 0,
    needed: true,
    isStarved: () => starved,
    needsWorker: () => pool.needed,
    retireIdle: () => false,
    resume: () => {
      pool.wakes++;
    },
  };
  return pool;
}

describe('WorkerBudget', () => {
  it('reserves a release for its waiter and wakes only after the stack returns', async () => {
    const budget = new WorkerBudget(1);
    const a = waiter();
    const b = waiter();
    budget.register(a);
    budget.register(b);
    expect(budget.tryAcquire(a)).toBe(true);
    budget.acquired(a);
    expect(budget.tryAcquire(b)).toBe(false);
    expect(budget.tryAcquire(b)).toBe(false);
    budget.release();
    expect(b.wakes).toBe(0);
    expect(budget.tryAcquire(a)).toBe(false);
    await Promise.resolve();
    expect(b.wakes).toBe(1);
    expect(budget.tryAcquire(b)).toBe(true);
    budget.acquired(b);
    budget.release();
    await Promise.resolve();
    expect(a.wakes).toBe(1);
  });
  it('serves starved first, FIFO among equals, then ordinary waiters', async () => {
    const budget = new WorkerBudget(1);
    const owner = waiter();
    const ordinary = waiter(false);
    const first = waiter();
    const second = waiter();
    budget.acquired(owner);
    for (const pool of [ordinary, first, second]) budget.tryAcquire(pool);
    expect(budget.hasStarvedWaiter()).toBe(true);
    budget.release();
    await Promise.resolve();
    expect(first.wakes).toBe(1);
    budget.cancel(first);
    await Promise.resolve();
    expect(second.wakes).toBe(1);
    budget.cancel(second);
    await Promise.resolve();
    expect(ordinary.wakes).toBe(1);
    expect(budget.hasWaiters()).toBe(false);
  });
  it('returns unused reservations and skips stale waiters', async () => {
    const budget = new WorkerBudget(1);
    const owner = waiter();
    const stale = waiter();
    const next = waiter();
    budget.acquired(owner);
    budget.tryAcquire(stale);
    budget.tryAcquire(next);
    stale.needed = false;
    budget.release();
    await Promise.resolve();
    expect(stale.wakes).toBe(0);
    expect(next.wakes).toBe(1);
    budget.cancel(next);
    expect(budget.tryAcquire(owner)).toBe(true);
  });
  it('cancels a pending grant before its continuation and closes without waking', async () => {
    const budget = new WorkerBudget(1);
    const a = waiter();
    const b = waiter();
    budget.acquired(a);
    budget.tryAcquire(b);
    budget.release();
    budget.cancel(b);
    await Promise.resolve();
    expect(b.wakes).toBe(0);
    budget.acquired(a);
    budget.tryAcquire(b);
    budget.release();
    budget.close();
    await Promise.resolve();
    expect(b.wakes).toBe(0);
    expect(budget.tryAcquire(a)).toBe(false);
    expect(budget.hasWaiters()).toBe(false);
    expect(budget.hasStarvedWaiter()).toBe(false);
  });
  it('allows unlimited acquisition under Infinity and removes a queued waiter', () => {
    const budget = new WorkerBudget(Infinity);
    const a = waiter();
    for (let i = 0; i < 10; i++) {
      expect(budget.tryAcquire(a)).toBe(true);
      budget.acquired(a);
    }
    const bounded = new WorkerBudget(0);
    bounded.tryAcquire(a);
    bounded.cancel(a);
    expect(bounded.hasWaiters()).toBe(false);
  });
});
