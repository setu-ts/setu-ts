import { AgentRunLeaseLostError } from '@setu-ts/common';
import type { AgentRunRow, IAgentRunStore, IRuntimeServices, TimerHandle } from '@setu-ts/common';

/** Shared holder state; serializes counter and renewal writes. @internal */
export class Lease {
  row: AgentRunRow;
  readonly controller: AbortController = new AbortController();
  readonly store: IAgentRunStore;
  readonly runtime: IRuntimeServices;
  readonly ms: number;
  #tail: Promise<unknown> = Promise.resolve();
  #timer: TimerHandle;
  lost = false;
  constructor(row: AgentRunRow, store: IAgentRunStore, runtime: IRuntimeServices, ms: number) {
    this.row = row;
    this.store = store;
    this.runtime = runtime;
    this.ms = ms;
    this.#timer = runtime.setInterval(
      () => {
        void this.renew().catch(() => this.stop(!this.row.cancelRequested));
      },
      Math.floor(ms / 3),
    );
  }
  async serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => {
      if (this.lost) throw new AgentRunLeaseLostError();
      return await work();
    });
    this.#tail = next.catch(() => {});
    return await next;
  }
  async write(data: Partial<AgentRunRow>): Promise<void> {
    await this.serial(async () => {
      const row = await this.store.update(
        this.row.id,
        { leaseVersion: this.row.leaseVersion },
        { ...data, updatedAt: this.runtime.now() },
      );
      if (!row) {
        this.stop(true);
        throw new AgentRunLeaseLostError();
      }
      this.row = row;
    });
  }
  async renew(): Promise<void> {
    await this.write({ leaseUntil: this.runtime.now() + this.ms });
    if (this.row.cancelRequested) this.controller.abort();
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  stop(lost = false): void {
    this.lost ||= lost;
    this.runtime.clearInterval(this.#timer);
    if (lost) this.controller.abort();
  }
}
/** Atomically acquire an unheld, ready, or expired run. @internal */
export async function claim(
  store: IAgentRunStore,
  runtime: IRuntimeServices,
  row: AgentRunRow,
  owner: string,
  leaseMs: number,
  skew: number,
): Promise<Lease | undefined> {
  if (
    row.status !== 'ready' &&
    (row.status !== 'running' || (row.leaseOwner !== '' && runtime.now() <= row.leaseUntil + skew))
  )
    return undefined;
  const held = await store.update(
    row.id,
    { status: row.status, leaseVersion: row.leaseVersion, leaseUntil: row.leaseUntil },
    {
      status: 'running',
      leaseVersion: row.leaseVersion + 1,
      leaseOwner: owner,
      leaseUntil: runtime.now() + leaseMs,
      updatedAt: runtime.now(),
    },
  );
  return held ? new Lease(held, store, runtime, leaseMs) : undefined;
}
