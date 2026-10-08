/**
 * Shared fixtures for the outbox unit tests (M107): a REAL
 * `createDatabaseOutboxStore` bridge over a memory `DatabaseService`, a
 * runtime with separate manual wall and monotonic clocks, a broker that
 * records (and can fail or hang) publishes, a store wrapper that injects
 * faults at a named call and otherwise delegates to the real bridge, and a
 * recording telemetry service.
 *
 * @module
 */
import type {
  EntityKey,
  IMessageBroker,
  IOutboxStore,
  IOutboxWriteScope,
  IRuntimeServices,
  ISpan,
  ISubscription,
  ITelemetryService,
  OutboxKey,
  OutboxRecord,
  OutboxStoreStats,
  OutboxTransition,
  PublishOptions,
  SpanContext,
  SpanOptions,
  TimerHandle,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import {
  createDatabaseOutboxStore,
  DatabaseService,
  type IDatabaseService,
  MemoryAdapter,
} from '@setu-ts/database-plugin';
import { MockServiceRegistry } from '@setu-ts/testing';

import { defineIntegrationEvent } from '../../src/integration/definition.ts';
import type { IntegrationEventDefinition } from '../../src/integration/definition.ts';
import type {
  OutboxOptions,
  OutboxSweepResult,
  OutboxWriteInput,
} from '../../src/interfaces/index.ts';
import { resolveOutboxOptions } from '../../src/outbox/options.ts';
import type { OutboxCommonOptions } from '../../src/interfaces/index.ts';
import { OutboxService } from '../../src/outbox/outbox-service.ts';
import type { OutboxRelayObserver } from '../../src/outbox/relay.ts';
import { createFakeRuntime } from './fake-runtime.ts';

/** The entity the bridge reads and writes. */
export const ENTITY = 'Outbox';

/** A wall-clock epoch the tests start at. */
export const WALL_START = 1_700_000_000_000;

/** An order event keyed by its aggregate. */
export interface OrderEvent {
  readonly key?: string;
  readonly n: number;
}

/** The order definition: its selector keys by `data.key` when present. */
export const orderPlaced: IntegrationEventDefinition<OrderEvent> = defineIntegrationEvent<
  OrderEvent
>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as OrderEvent,
  orderingKey: (envelope) => envelope.data.key,
});

/** A runtime with separately driven wall (`now`) and monotonic (`hrtime`) clocks. */
export interface OutboxClock {
  readonly runtime: IRuntimeServices;
  /** Sets the wall clock. */
  setWall(ms: number): void;
  /** Moves the wall clock. */
  advanceWall(ms: number): void;
  /** Moves the monotonic clock, firing due timers. */
  advance(ms: number): Promise<void>;
  /** Moves the monotonic clock WITHOUT firing timers (time spent inside a call). */
  step(ms: number): void;
  /** Timers armed and not yet fired or cleared. */
  timerCount(): number;
}

/**
 * Builds the manual-clock runtime; uuids are deterministic valid UUIDs
 * counting from `uuidBase` (give a second relay over one table its own base).
 */
export function outboxClock(uuidBase = 0): OutboxClock {
  let wall = WALL_START;
  let mono = 0;
  let uuid = uuidBase;
  const timers = new Map<TimerHandle, { fn: () => void; due: number }>();
  const runtime: IRuntimeServices = {
    ...createFakeRuntime(),
    now: () => wall,
    hrtime: () => mono,
    uuid: () => `00000000-0000-4000-8000-${(uuid++).toString(16).padStart(12, '0')}`,
    setTimeout: (fn, ms) => {
      const handle = Object.freeze({ token: Symbol('timer') });
      timers.set(handle, { fn, due: mono + ms });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
  };
  return {
    runtime,
    setWall: (ms) => {
      wall = ms;
    },
    advanceWall: (ms) => {
      wall += ms;
    },
    timerCount: () => timers.size,
    step: (ms) => {
      mono += ms;
    },
    advance: async (ms) => {
      mono += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.due > mono) continue;
        timers.delete(handle);
        timer.fn();
      }
      await flush();
    },
  };
}

/** Lets pending promise chains settle. */
export async function flush(): Promise<void> {
  for (let n = 0; n < 200; n++) await Promise.resolve();
}

/** One recorded publish. */
export interface RecordedPublish {
  readonly topic: string;
  readonly message: Record<string, unknown>;
  readonly options: PublishOptions | undefined;
}

/**
 * A broker recording every `publish`. `behaviour` may reject or hang a
 * publish; a publish that resolves is recorded.
 */
export class FakeOutboxBroker implements IMessageBroker {
  readonly published: RecordedPublish[] = [];
  /** Every publish call, settled or not. */
  readonly calls: RecordedPublish[] = [];
  behaviour: ((call: RecordedPublish) => Promise<void> | undefined) | undefined;

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    const call = { topic, message: message as Record<string, unknown>, options };
    this.calls.push(call);
    const pending = this.behaviour?.(call);
    if (pending !== undefined) await pending;
    this.published.push(call);
  }

  /** The `data.n` of every published envelope, in publish order. */
  sequence(): number[] {
    return this.published.map((p) => (p.message.data as OrderEvent).n);
  }

  subscribe(): Promise<ISubscription> {
    return Promise.reject(new Error('not used'));
  }

  request<TRes>(): Promise<TRes> {
    return Promise.reject(new Error('not used'));
  }

  respond(): Promise<ISubscription> {
    return Promise.reject(new Error('not used'));
  }
}

/** The store methods a fault can be injected at. */
export type StoreMethod = keyof IOutboxStore;

/**
 * An `IOutboxStore` delegating to the real bridge, with an optional fault per
 * method: a hook runs BEFORE the delegate and may throw (the call rejects) or
 * return a promise the call awaits (to hang it).
 */
export class FaultStore implements IOutboxStore {
  readonly inner: IOutboxStore;
  readonly faults: Partial<Record<StoreMethod, () => Promise<void> | void>> = {};
  readonly calls: { method: StoreMethod; args: unknown[] }[] = [];

  constructor(inner: IOutboxStore) {
    this.inner = inner;
  }

  async #run<T>(method: StoreMethod, args: unknown[], call: () => Promise<T>): Promise<T> {
    this.calls.push({ method, args });
    await this.faults[method]?.();
    return call();
  }

  append(scope: IOutboxWriteScope, record: OutboxRecord): Promise<void> {
    return this.#run('append', [record], () => this.inner.append(scope, record));
  }
  scanPending(after: string | undefined, limit: number): Promise<readonly OutboxRecord[]> {
    return this.#run('scanPending', [after, limit], () => this.inner.scanPending(after, limit));
  }
  failedKeys(limit: number): Promise<readonly OutboxKey[]> {
    return this.#run('failedKeys', [limit], () => this.inner.failedKeys(limit));
  }
  markSent(
    id: string,
    update: { readonly settledAt: number; readonly sentBy: string; readonly deleteNow: boolean },
  ): Promise<OutboxTransition> {
    return this.#run('markSent', [id, update], () => this.inner.markSent(id, update));
  }
  markFailure(
    id: string,
    update: {
      readonly attempts: number;
      readonly lastError: string;
      readonly availableAt: number;
      readonly status: 'pending' | 'failed';
    },
  ): Promise<OutboxTransition> {
    return this.#run('markFailure', [id, update], () => this.inner.markFailure(id, update));
  }
  release(id: string, action: 'retry' | 'discard', now: number): Promise<OutboxTransition> {
    return this.#run('release', [id, action, now], () => this.inner.release(id, action, now));
  }
  stats(): Promise<OutboxStoreStats> {
    return this.#run('stats', [], () => this.inner.stats());
  }
  purge(before: number, limit: number): Promise<number> {
    return this.#run('purge', [before, limit], () => this.inner.purge(before, limit));
  }
  verify(): Promise<void> {
    return this.#run('verify', [], () => this.inner.verify());
  }

  /** How many calls a method received. */
  count(method: StoreMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** A connected memory database and the real bridge over it. */
export async function memoryOutbox(): Promise<{ db: IDatabaseService; store: FaultStore }> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const db = new DatabaseService(adapter, (entity) => adapter.createDataSource(entity), 'memory');
  const registry = new MockServiceRegistry();
  registry.register(CAPABILITIES.DATABASE, db);
  return { db, store: new FaultStore(createDatabaseOutboxStore()(registry)) };
}

/** Every stored outbox row, read without the bridge. */
export function rows(db: IDatabaseService): Promise<Record<string, unknown>[]> {
  return db.getRepository<Record<string, unknown>, EntityKey>(ENTITY).findAll({
    orderBy: { position: 'asc' },
  });
}

/** One stored row by id, read without the bridge. */
export function row(db: IDatabaseService, id: string): Promise<Record<string, unknown> | null> {
  return db.getRepository<Record<string, unknown>, EntityKey>(ENTITY).findById(id);
}

/** Edits a stored row directly — the way anyone with table write access could. */
export async function edit(
  db: IDatabaseService,
  id: string,
  change: Record<string, unknown>,
): Promise<void> {
  await db.getRepository<Record<string, unknown>, EntityKey>(ENTITY).update(id, change);
}

/** A recorded span. */
export interface RecordedSpan {
  readonly name: string;
  readonly options: SpanOptions | undefined;
}

/** A telemetry service recording each `withSpan` call and its options. */
export function recordingTelemetry(active?: SpanContext): ITelemetryService & {
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const span = {
    setAttribute() {
      return span;
    },
    setAttributes() {
      return span;
    },
    setStatus() {},
    recordException() {},
    end() {},
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '00' }),
  } as unknown as ISpan;
  return {
    spans,
    withSpan<T>(name: string, fn: (s: ISpan) => Promise<T>, options?: SpanOptions): Promise<T> {
      spans.push({ name, options });
      return fn(span);
    },
    activeSpanContext: () => active,
  };
}

/** Everything one outbox test drives. */
export interface OutboxHarness {
  readonly service: OutboxService;
  readonly db: IDatabaseService;
  readonly store: FaultStore;
  readonly broker: FakeOutboxBroker;
  readonly clock: OutboxClock;
  /** Writes one order event in its own transaction; resolves the envelope id. */
  write(event: OrderEvent, input?: OutboxWriteInput): Promise<string>;
  /** Runs one sweep. */
  sweep(): Promise<OutboxSweepResult>;
}

/** Options for {@linkcode outboxHarness}. */
export interface HarnessOptions {
  readonly options?: OutboxCommonOptions;
  readonly telemetry?: ITelemetryService;
  readonly observer?: OutboxRelayObserver;
  /** Reuse an existing database and store (a second relay over one table). */
  readonly shared?: { readonly db: IDatabaseService; readonly store: FaultStore };
  readonly clock?: OutboxClock;
  readonly broker?: FakeOutboxBroker;
}

/** Builds an active outbox service over the real memory-backed bridge. */
export async function outboxHarness(opts: HarnessOptions = {}): Promise<OutboxHarness> {
  const { db, store } = opts.shared ?? await memoryOutbox();
  const clock = opts.clock ?? outboxClock();
  const broker = opts.broker ?? new FakeOutboxBroker();
  const options: OutboxOptions = { ...opts.options, store };
  const service = new OutboxService({
    runtime: clock.runtime,
    broker,
    options: resolveOutboxOptions(options),
    ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
    ...(opts.observer !== undefined ? { observer: opts.observer } : {}),
  });
  service.activate({ kind: 'single', store });
  return {
    service,
    db,
    store,
    broker,
    clock,
    write: (event, input) => db.transaction((uow) => service.write(uow, orderPlaced, event, input)),
    sweep: () => service.sweep(),
  };
}

/** An observer counting every hook. */
export function countingObserver(): OutboxRelayObserver & {
  readonly counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const bump = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  return {
    counts,
    published: () => bump('published'),
    publishFailed: () => bump('publishFailed'),
    poisoned: (topic) => bump(topic === undefined ? 'poisoned-invalid' : 'poisoned'),
    overlap: (kind) => bump(`overlap-${kind}`),
  };
}
