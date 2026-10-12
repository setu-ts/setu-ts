/** Internal service-owned slot budget, with deferred reserved hand-overs. @module */

/** Pool callbacks keep the budget independent of the task-pool implementation. */
export interface IWorkerBudgetPool {
  isStarved(): boolean;
  needsWorker(): boolean;
  retireIdle(): boolean;
  resume(): void;
}

/** Counts live slots and protects freed capacity until its waiter consumes it. */
export class WorkerBudget {
  private readonly pools: IWorkerBudgetPool[] = [];
  private readonly waiters: IWorkerBudgetPool[] = [];
  private readonly reservations = new Set<IWorkerBudgetPool>();
  private workers = 0;
  private closed = false;

  constructor(private readonly limit: number) {}

  register(pool: IWorkerBudgetPool): void {
    this.pools.push(pool);
  }

  /** Checks capacity without charging a slot before spawn succeeds. */
  tryAcquire(pool: IWorkerBudgetPool): boolean {
    if (this.closed) return false;
    if (this.reservations.has(pool) || this.workers + this.reservations.size < this.limit) {
      return true;
    }
    if (!this.waiters.includes(pool)) this.waiters.push(pool);
    // Enqueue before retiring: the released slot is reserved, never stolen by
    // the retiring pool's next pump. Creation order makes eviction predictable.
    for (const other of this.pools) {
      if (other !== pool && other.retireIdle()) break;
    }
    return false;
  }

  /** Called only after host.spawn returned a handle. */
  acquired(pool: IWorkerBudgetPool): void {
    this.reservations.delete(pool);
    this.workers++;
  }

  release(): void {
    this.workers--;
    this.reserve();
  }

  /** Returns an unnecessary reservation and removes a stale waiter. */
  cancel(pool: IWorkerBudgetPool): void {
    const index = this.waiters.indexOf(pool);
    if (index !== -1) this.waiters.splice(index, 1);
    this.reservations.delete(pool);
    this.reserve();
  }

  hasWaiters(): boolean {
    return this.waiters.length > 0;
  }

  hasStarvedWaiter(): boolean {
    return this.waiters.some((pool) => pool.isStarved());
  }

  /** Service shutdown calls this before any pool can release a slot. */
  close(): void {
    this.closed = true;
    this.waiters.length = 0;
    this.reservations.clear();
  }

  private reserve(): void {
    while (
      !this.closed && this.workers + this.reservations.size < this.limit &&
      this.waiters.length > 0
    ) {
      const starved = this.waiters.findIndex((pool) => pool.isStarved());
      const [pool] = this.waiters.splice(starved === -1 ? 0 : starved, 1);
      if (!pool.needsWorker()) continue;
      this.reservations.add(pool);
      void Promise.resolve().then(() => {
        // A timeout, cancellation or close may have returned this reservation
        // before the continuation ran. Never wake on an obsolete grant.
        if (!this.closed && this.reservations.has(pool)) pool.resume();
      });
    }
  }
}
