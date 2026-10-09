/**
 * Shared fixtures for the inbox tests (M108): a scriptable in-memory
 * `IInboxStore` that honours the port contract (a duplicate marker rejects, a
 * rejected run leaves nothing), a runtime with real `SubtleCrypto` and real
 * timers, and an integration-event definition.
 *
 * @module
 */
import type {
  IInboxStore,
  InboxFailureUpdate,
  InboxIds,
  InboxRecord,
  InboxReleaseOutcome,
  InboxStoreStats,
  IRuntimeServices,
  TimerHandle,
} from '@setu-ts/common';
import { DuplicateKeyError, INBOX_RECORD_KIND } from '@setu-ts/common';

import { defineIntegrationEvent } from '../../src/index.ts';
import type { IntegrationEventDefinition } from '../../src/index.ts';
import type { ResolvedInboxOptions } from '../../src/inbox/options.ts';
import { resolveInboxOptions } from '../../src/inbox/options.ts';

/** The payload every inbox test publishes. */
export interface Hired {
  readonly personId: string;
}

/** A definition whose parser refuses a payload without a string `personId`. */
export const hired: IntegrationEventDefinition<Hired> = defineIntegrationEvent<Hired>({
  type: 'people.hired',
  version: 1,
  topic: 'people.hired.v1',
  parse: (value) => {
    const candidate = value as { personId?: unknown };
    if (typeof candidate?.personId !== 'string') throw new Error('personId must be a string');
    return { personId: candidate.personId };
  },
});

/** A delivered envelope for `hired`. */
export function envelope(id: string, data: unknown = { personId: 'p-1' }): Record<string, unknown> {
  return {
    id,
    type: 'people.hired',
    version: 1,
    occurredAt: '2026-10-09T00:00:00Z',
    data,
  };
}

/** A runtime with real `SubtleCrypto`, real timers and a settable wall clock. */
export function inboxRuntime(): IRuntimeServices & { clock: { now: number } } {
  const clock = { now: 1_000_000 };
  let ids = 0;
  return {
    clock,
    platform: () => 'deno' as const,
    version: () => 'test',
    now: () => clock.now,
    hrtime: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TimerHandle,
    clearTimeout: (handle: TimerHandle) => clearTimeout(handle as number),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as TimerHandle,
    clearInterval: (handle: TimerHandle) => clearInterval(handle as number),
    uuid: () => `uuid-${++ids}`,
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: crypto.subtle,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    hostname: () => 'localhost',
  };
}

/** Resolved options with test overrides. */
export function options(
  overrides: Partial<Parameters<typeof resolveInboxOptions>[0]> = {},
): ResolvedInboxOptions {
  return resolveInboxOptions({ store: new FakeInboxStore(), ...overrides });
}

/** A promise that never settles. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * A scriptable in-memory store. Each `fail*` hook, when set, replaces the
 * method's result; `beforeCommit` runs inside `run` after the work, before the
 * marker is committed — the window a concurrent delivery races into.
 */
export class FakeInboxStore implements IInboxStore {
  readonly rows = new Map<string, InboxRecord>();
  readonly calls: string[] = [];
  /** The scope `run` hands the work. */
  readonly scope = { kind: 'fake-scope' };
  find$?: () => Promise<InboxRecord | undefined>;
  run$?: () => Promise<never>;
  recordFailure$?: () => Promise<number>;
  park$?: () => Promise<'applied' | 'exists'>;
  release$?: () => Promise<InboxReleaseOutcome>;
  stats$?: () => Promise<InboxStoreStats>;
  beforeCommit?: () => Promise<void> | void;
  verified = 0;

  find(markerId: string): Promise<InboxRecord | undefined> {
    this.calls.push('find');
    if (this.find$ !== undefined) return this.find$();
    return Promise.resolve(this.rows.get(markerId));
  }

  async run<R>(marker: InboxRecord, work: (scope: unknown) => Promise<R>): Promise<R> {
    this.calls.push('run');
    if (this.run$ !== undefined) return this.run$();
    if (this.rows.has(marker.id)) throw new DuplicateKeyError('duplicate marker');
    const result = await work(this.scope);
    await this.beforeCommit?.();
    if (this.rows.has(marker.id)) throw new DuplicateKeyError('duplicate at commit');
    this.rows.set(marker.id, marker);
    return result;
  }

  recordFailure(ids: InboxIds, update: InboxFailureUpdate): Promise<number> {
    this.calls.push('recordFailure');
    if (this.recordFailure$ !== undefined) return this.recordFailure$();
    const current = this.rows.get(ids.attempts);
    const attempts = (current?.attempts ?? 0) + 1;
    this.rows.set(ids.attempts, {
      id: ids.attempts,
      kind: INBOX_RECORD_KIND,
      consumer: update.consumer,
      topic: update.topic,
      status: 'attempting',
      attempts,
      updatedAt: update.now,
      lastError: update.lastError,
      ...(update.envelopeId !== undefined ? { envelopeId: update.envelopeId } : {}),
    });
    return Promise.resolve(attempts);
  }

  park(marker: InboxRecord): Promise<'applied' | 'exists'> {
    this.calls.push('park');
    if (this.park$ !== undefined) return this.park$();
    if (this.rows.has(marker.id)) return Promise.resolve('exists');
    this.rows.set(marker.id, marker);
    return Promise.resolve('applied');
  }

  parked(limit: number): Promise<readonly InboxRecord[]> {
    this.calls.push('parked');
    const rows = [...this.rows.values()]
      .filter((row) => row.status === 'parked')
      .slice(0, limit)
      .map(({ envelope: _dropped, ...rest }) => rest);
    return Promise.resolve(rows);
  }

  release(ids: InboxIds, action: 'retry' | 'discard', now: number): Promise<InboxReleaseOutcome> {
    this.calls.push('release');
    if (this.release$ !== undefined) return this.release$();
    const record = this.rows.get(ids.marker);
    if (record === undefined) return Promise.resolve({ outcome: 'missing' });
    if (record.status !== 'parked') {
      return Promise.resolve({ outcome: 'not-parked', status: record.status });
    }
    if (action === 'retry') {
      this.rows.delete(ids.marker);
    } else {
      const { envelope: _cleared, ...rest } = record;
      this.rows.set(ids.marker, { ...rest, status: 'discarded', updatedAt: now });
    }
    this.rows.delete(ids.attempts);
    return Promise.resolve({ outcome: 'applied', record });
  }

  stats(): Promise<InboxStoreStats> {
    this.calls.push('stats');
    if (this.stats$ !== undefined) return this.stats$();
    const parked = [...this.rows.values()].filter((row) => row.status === 'parked').length;
    return Promise.resolve({ parked });
  }

  purge(before: number, limit: number): Promise<number> {
    this.calls.push(`purge:${before}:${limit}`);
    let deleted = 0;
    for (const [id, row] of this.rows) {
      if (row.status !== 'parked' && row.updatedAt < before && deleted < limit) {
        this.rows.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  verify(): Promise<void> {
    this.verified += 1;
    return Promise.resolve();
  }
}
