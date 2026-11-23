import type { TimerHandle } from '@setu-ts/common';

/** Manual timer queue: fired callbacks can also be replayed to check stale-callback races. */
export class DnsTimers {
  next = 0;
  pending = new Map<number, { callback: () => void; ms: number }>();
  history: { callback: () => void; ms: number }[] = [];
  setTimeout = (callback: () => void, ms: number): TimerHandle => {
    const task = { callback, ms };
    this.history.push(task);
    const id = ++this.next;
    this.pending.set(id, task);
    return id;
  };
  clearTimeout = (handle: TimerHandle): void => {
    this.pending.delete(handle as number);
  };
  fire(ms: number): void {
    const entry = [...this.pending].find(([, task]) => task.ms === ms);
    if (!entry) throw new Error(`no pending ${ms} ms timer`);
    this.pending.delete(entry[0]);
    entry[1].callback();
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function flushDns(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
