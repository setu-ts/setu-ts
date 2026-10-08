/**
 * The `IOutbox` service (M107 §3.5–§3.12): the atomic write, the coalesced
 * single-flight relay, the per-store lap state, purge, operator release, and
 * the closing drain.
 *
 * The plugin constructs it at `register()` and activates it at `onInit` with
 * the resolved, verified stores; every call before activation rejects
 * {@linkcode OutboxNotReadyError}.
 *
 * @module
 */
import type {
  ILogger,
  IMessageBroker,
  IOutboxStore,
  IOutboxWriteScope,
  IRuntimeServices,
  ITelemetryService,
} from '@setu-ts/common';
import { contextToTraceparent, publishIdProblem } from '@setu-ts/common';

import { describeError } from '../brokers/describe-error.ts';
import type { IntegrationEventDefinition } from '../integration/definition.ts';
import { prepareIntegrationPublish } from '../integration/prepare.ts';
import type { IOutbox, OutboxSweepResult, OutboxWriteInput } from '../interfaces/index.ts';
import { OutboxNotReadyError, OutboxRowStateError, OutboxUnknownTenantError } from './errors.ts';
import type { ResolvedOutboxOptions } from './options.ts';
import { PositionClock } from './position.ts';
import { encodeOutboxRecord } from './record-codec.ts';
import type { LapHolder, OutboxRelayObserver } from './relay.ts';
import { boundedCall, SweepBudget, sweepStore } from './relay.ts';

/**
 * The stores the plugin resolved and verified at `onInit`.
 *
 * @internal
 */
export type ActiveOutboxStores =
  | { readonly kind: 'single'; readonly store: IOutboxStore }
  | { readonly kind: 'per-tenant'; readonly stores: ReadonlyMap<string, IOutboxStore> };

/**
 * What the outbox service is built from.
 *
 * @internal
 */
export interface OutboxServiceDeps {
  readonly runtime: IRuntimeServices;
  /** The composed broker the relay publishes through. */
  readonly broker: IMessageBroker;
  readonly options: ResolvedOutboxOptions;
  /** Telemetry, when registered: captures the write's trace and spans each relay publish. */
  readonly telemetry?: ITelemetryService;
  /** The logger, read at call time. */
  readonly logger?: () => ILogger | undefined;
  /** Optional metrics hooks. */
  readonly observer?: OutboxRelayObserver;
}

/**
 * This instance's own health signals (M107 §3.11 per-instance reasons).
 *
 * @internal
 */
export interface OutboxInstanceSignals {
  /** The current lap of some store overflowed the blocked-set cap. */
  readonly blockedKeyCap: boolean;
  /** The most recent sweep ended on a rejected or expired store call. */
  readonly storeWriteFailing: boolean;
  /** A scheduled-sweep overlap was observed inside `overlapWindowMs`. */
  readonly scheduledOverlap: boolean;
  /** The most recent finished sweep, when any. */
  readonly lastSweep?: OutboxSweepResult;
}

/** A sweep answer that did no work. */
function emptyResult(
  origin: OutboxSweepResult['origin'],
  endedBy: OutboxSweepResult['endedBy'],
): OutboxSweepResult {
  return { origin, scanned: 0, published: 0, failures: 0, poisoned: 0, endedBy };
}

/** Refuses a malformed tenant id without quoting it. */
function validateTenantId(tenantId: unknown): string | undefined {
  if (tenantId === undefined) return undefined;
  if (publishIdProblem(tenantId) !== null) {
    throw new RangeError(
      'outbox: tenantId must be a valid id (1-128 bytes, no control characters)',
    );
  }
  return tenantId as string;
}

/**
 * The transactional outbox.
 *
 * @internal
 */
export class OutboxService implements IOutbox {
  readonly #deps: OutboxServiceDeps;
  readonly #instanceId: string;
  readonly #clock = new PositionClock();
  readonly #laps = new Map<IOutboxStore, LapHolder>();
  readonly #observer: OutboxRelayObserver;
  #stores: ActiveOutboxStores | undefined;
  #rotation = 0;
  #closing = false;
  #inflight: Promise<OutboxSweepResult> | undefined;
  #followUp: Promise<OutboxSweepResult | undefined> | undefined;
  #lastSweep: OutboxSweepResult | undefined;
  #lastScheduledOverlapAt: number | undefined;

  /**
   * @param deps - Runtime, broker, resolved options and optional hooks
   */
  constructor(deps: OutboxServiceDeps) {
    this.#deps = deps;
    this.#instanceId = deps.runtime.uuid();
    const forward = deps.observer;
    this.#observer = {
      published: (topic) => forward?.published(topic),
      publishFailed: (topic) => forward?.publishFailed(topic),
      poisoned: (topic) => forward?.poisoned(topic),
      overlap: (kind) => {
        if (kind === 'scheduled') this.#lastScheduledOverlapAt = deps.runtime.hrtime();
        forward?.overlap(kind);
      },
    };
  }

  /** This relay instance's id — the first half of every `sentBy` it writes. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /** Whether the outbox is closing: dispatch is a no-op and failures write nothing. */
  get closing(): boolean {
    return this.#closing;
  }

  /**
   * Activates the outbox with the stores the plugin resolved and verified.
   *
   * @param stores - The active stores
   */
  activate(stores: ActiveOutboxStores): void {
    this.#stores = stores;
  }

  /**
   * Every active store, in a stable order, or `undefined` before
   * {@linkcode activate} — what the health indicator reads.
   *
   * @returns The stores, or `undefined`
   */
  activeStores(): readonly IOutboxStore[] | undefined {
    const stores = this.#stores;
    return stores === undefined ? undefined : this.#list(stores);
  }

  /**
   * This instance's per-instance health signals.
   *
   * @returns The signals
   */
  instanceSignals(): OutboxInstanceSignals {
    const at = this.#lastScheduledOverlapAt;
    let blockedKeyCap = false;
    for (const holder of this.#laps.values()) {
      if (holder.lap?.blockedOverflow === true) blockedKeyCap = true;
    }
    return {
      blockedKeyCap,
      storeWriteFailing: this.#lastSweep?.endedBy === 'store-failure',
      scheduledOverlap: at !== undefined &&
        this.#deps.runtime.hrtime() - at <= this.#deps.options.overlapWindowMs,
      ...(this.#lastSweep !== undefined ? { lastSweep: this.#lastSweep } : {}),
    };
  }

  /** @inheritdoc */
  async write<T>(
    scope: IOutboxWriteScope,
    definition: IntegrationEventDefinition<T>,
    payload: T,
    input?: OutboxWriteInput,
  ): Promise<string> {
    const stores = this.#stores;
    if (stores === undefined) throw new OutboxNotReadyError();
    // Each input member is read exactly once.
    const metadata = input?.metadata;
    const options = input?.options;
    const rawTenantId = input?.tenantId;
    const { runtime, telemetry } = this.#deps;
    const prepared = await prepareIntegrationPublish(
      runtime,
      definition,
      payload,
      metadata,
      options,
    );
    const active = telemetry?.activeSpanContext?.();
    const traceparent = active === undefined ? null : contextToTraceparent(active);
    const tenantId = validateTenantId(rawTenantId);
    const store = this.#select(stores, tenantId);
    const now = runtime.now();
    const record = encodeOutboxRecord({
      topic: definition.topic,
      envelope: prepared.envelope,
      options: prepared.options,
      position: this.#clock.next(now, prepared.envelope.id),
      createdAt: now,
      maxEnvelopeBytes: this.#deps.options.maxEnvelopeBytes,
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(traceparent !== null ? { traceparent } : {}),
    });
    await store.append(scope, record);
    return record.id;
  }

  /** @inheritdoc */
  dispatch(): void {
    try {
      if (this.#closing || this.#stores === undefined) return;
      let promise: Promise<unknown>;
      const running = this.#inflight;
      if (running === undefined) {
        promise = this.#start('dispatch');
      } else {
        // One follow-up waits behind the running sweep; further requests join it.
        promise = this.#followUp ??= running.then(noop, noop).then(() => {
          this.#followUp = undefined;
          if (this.#closing) return undefined;
          return this.#inflight ?? this.#start('dispatch');
        });
      }
      const guarded = promise.then(noop, (error: unknown) => this.#logFailure(error));
      const background = this.#deps.options.background;
      if (background !== undefined) background(guarded);
    } catch (error) {
      this.#logFailure(error);
    }
  }

  /** @inheritdoc */
  sweep(): Promise<OutboxSweepResult> {
    if (this.#stores === undefined) return Promise.reject(new OutboxNotReadyError());
    if (this.#closing) return Promise.resolve(emptyResult('scheduled', 'closing'));
    return this.#inflight ?? this.#start('scheduled');
  }

  /**
   * Deletes settled rows older than `retainSentMs` from every store.
   *
   * One deadline, `sweepDeadlineMs` on the monotonic clock, bounds the whole
   * run — every store's queries and deletes together — because the scheduled
   * purge job holds the scheduler's handler mutex exactly as a sweep does, and
   * an unbounded purge against a hung store could outlive the mutex's `ttlMs`.
   * A store call still running at the deadline rejects the purge; rows already
   * deleted stay deleted and the rest are purged at the next interval.
   *
   * @returns The number of rows deleted
   */
  async purge(): Promise<number> {
    const stores = this.#stores;
    if (stores === undefined) throw new OutboxNotReadyError();
    const { runtime, options } = this.#deps;
    const before = runtime.now() - options.retainSentMs;
    const budget = new SweepBudget(runtime, options.sweepDeadlineMs);
    let deleted = 0;
    for (const store of this.#list(stores)) {
      deleted += await boundedCall(
        runtime,
        budget,
        options.sweepDeadlineMs,
        'purge',
        () => store.purge(before, options.purgeBatch),
      );
    }
    return deleted;
  }

  /** @inheritdoc */
  async release(
    id: string,
    action: 'retry' | 'discard',
    options?: { readonly tenantId?: string },
  ): Promise<void> {
    const stores = this.#stores;
    if (stores === undefined) throw new OutboxNotReadyError();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('outbox: release needs the row id');
    }
    if (action !== 'retry' && action !== 'discard') {
      throw new TypeError("outbox: release action must be 'retry' or 'discard'");
    }
    const store = this.#select(stores, validateTenantId(options?.tenantId));
    const transition = await store.release(id, action, this.#deps.runtime.now());
    if (transition.outcome === 'missing') throw new OutboxRowStateError('missing');
    if (transition.outcome === 'not-failed') {
      throw new OutboxRowStateError('not-failed', transition.status);
    }
  }

  /**
   * Starts closing: dispatch becomes a no-op, failures write nothing, and the
   * in-flight sweep (and any queued follow-up) is awaited. Idempotent.
   *
   * @returns A promise settling when no sweep is running
   */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#followUp?.then(noop, noop);
    await this.#inflight?.then(noop, noop);
  }

  /** Selects the store for a tenant. */
  #select(stores: ActiveOutboxStores, tenantId: string | undefined): IOutboxStore {
    if (stores.kind === 'single') return stores.store;
    const store = tenantId === undefined ? undefined : stores.stores.get(tenantId);
    if (store === undefined) throw new OutboxUnknownTenantError();
    return store;
  }

  /** Every active store, in a stable order. */
  #list(stores: ActiveOutboxStores): readonly IOutboxStore[] {
    return stores.kind === 'single' ? [stores.store] : [...stores.stores.values()];
  }

  /** Starts a sweep and makes it the in-flight one until it settles. */
  #start(origin: OutboxSweepResult['origin']): Promise<OutboxSweepResult> {
    const sweep = this.#sweepOnce(origin);
    this.#inflight = sweep;
    const clear = (): void => {
      if (this.#inflight === sweep) this.#inflight = undefined;
    };
    sweep.then(clear, clear);
    return sweep;
  }

  /** One sweep over every store, in rotating order, within one budget. */
  async #sweepOnce(origin: OutboxSweepResult['origin']): Promise<OutboxSweepResult> {
    const { runtime, broker, telemetry, options } = this.#deps;
    const stores = this.#list(this.#stores!);
    const budget = new SweepBudget(runtime, options.sweepDeadlineMs);
    const ctx = {
      runtime,
      broker,
      telemetry,
      options,
      instanceId: this.#instanceId,
      origin,
      isClosing: () => this.#closing,
      observer: this.#observer,
      budget,
    };
    const start = this.#rotation % stores.length;
    this.#rotation = (start + 1) % stores.length;
    let endedBy: OutboxSweepResult['endedBy'] = 'complete';
    for (let index = 0; index < stores.length; index++) {
      const store = stores[(start + index) % stores.length]!;
      let holder = this.#laps.get(store);
      if (holder === undefined) {
        holder = { lap: undefined };
        this.#laps.set(store, holder);
      }
      const end = await sweepStore(ctx, store, holder);
      if (end !== 'lap-complete') {
        endedBy = end;
        break;
      }
    }
    const result: OutboxSweepResult = {
      origin,
      scanned: budget.scanned,
      published: budget.published,
      failures: budget.failures,
      poisoned: budget.poisoned,
      endedBy,
    };
    this.#lastSweep = result;
    return result;
  }

  /** Logs a dispatched sweep's failure; the logger is read at call time. */
  #logFailure(error: unknown): void {
    this.#deps.logger?.()?.error('outbox: a dispatched sweep failed', {
      error: describeError(error),
    });
  }
}

/** Discards a value. */
function noop(): void {}
