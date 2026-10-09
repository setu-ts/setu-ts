/**
 * The consumer inbox service (M108 §3.2–§3.9): the delivery path every inbox
 * subscription runs, the `(consumer, topic)` registry, and the operator
 * methods of {@linkcode IInbox}.
 *
 * The delivery path is internal. An `onIntegrationEvent(..., { inbox })`
 * subscription reaches it through {@linkcode inboxServiceOf}, which looks the
 * service resolved from the registry up in a module-private `WeakMap` filled
 * by the constructor — so a replacement provider of `CAPABILITIES.INBOX`
 * cannot be driven, and `IInbox` exposes only the operator methods.
 *
 * @module
 */
import type {
  IInboxStore,
  ILogger,
  InboxIds,
  InboxRecord,
  IRuntimeServices,
  MessageMetadata,
} from '@setu-ts/common';
import {
  INBOX_RECORD_KIND,
  publishIdProblem,
  resolveProbeTiming,
  withDeadline,
} from '@setu-ts/common';

import { describeError } from '../brokers/describe-error.ts';
import type { IntegrationEventDefinition } from '../integration/definition.ts';
import type { IntegrationEventEnvelope } from '../integration/envelope.ts';
import { parseEnvelopeData, validateEnvelope } from '../integration/envelope.ts';
import type { IInbox, InboxReleaseResult, ParkedInboxEntry } from '../interfaces/index.ts';
import { InboxConsumerConflictError, InboxNotReadyError, InboxRowStateError } from './errors.ts';
import { deriveInboxIds, idsFromMarker, isMarkerId } from './inbox-key.ts';
import type { ResolvedInboxOptions } from './options.ts';

/** The longest `lastError` line stored. */
const MAX_ERROR_LENGTH = 1024;

/** The default and largest `parked()` listing. */
const DEFAULT_PARKED_LIMIT = 100;
const MAX_PARKED_LIMIT = 1000;

/** Every constructed service, keyed by itself as the registry hands it out. */
const SERVICES = new WeakMap<object, InboxService>();

/**
 * The inbox service behind a value resolved from the registry.
 *
 * @internal
 * @param value - What `services.get(token)` returned
 * @returns The service, or `undefined` for a provider this package did not build
 */
export function inboxServiceOf(value: unknown): InboxService | undefined {
  return typeof value === 'object' && value !== null ? SERVICES.get(value) : undefined;
}

/**
 * One inbox subscription's handler, as the service calls it.
 *
 * @internal
 */
export type InboxHandler<T> = (
  payload: T,
  envelope: IntegrationEventEnvelope<T>,
  metadata: MessageMetadata,
  scope: unknown,
) => void | Promise<void>;

/**
 * One inbox subscription: its consumer, its contract and its handler.
 *
 * @internal
 */
export interface InboxSubscription<T> {
  readonly consumer: string;
  readonly definition: IntegrationEventDefinition<T>;
  readonly handler: InboxHandler<T>;
}

/**
 * What the service needs from the plugin.
 *
 * @internal
 */
export interface InboxServiceDeps {
  readonly runtime: IRuntimeServices;
  readonly options: ResolvedInboxOptions;
  /** Read at CALL time (the M52b lesson): a logger registered later is still seen. */
  readonly logger: () => ILogger | undefined;
}

/**
 * The inbox service. Registered under `CAPABILITIES.INBOX`; internal, so the
 * delivery path has one implementation.
 *
 * @internal
 */
export class InboxService implements IInbox {
  readonly #deps: InboxServiceDeps;
  readonly #registered = new Set<string>();
  #store: IInboxStore | undefined;
  #closed = false;

  /**
   * @param deps - Runtime, resolved options and the logger thunk
   */
  constructor(deps: InboxServiceDeps) {
    this.#deps = deps;
    SERVICES.set(this, this);
  }

  /**
   * Activates the inbox with the store the plugin resolved and verified.
   *
   * @param store - The verified store
   */
  activate(store: IInboxStore): void {
    this.#store = store;
  }

  /** Closes the inbox: every later delivery and operator call is refused. */
  close(): void {
    this.#closed = true;
  }

  /** Whether the inbox has closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The active store, or `undefined` before activation and after close — what
   * the health indicator reads.
   *
   * @returns The store, or `undefined`
   */
  activeStore(): IInboxStore | undefined {
    return this.#closed ? undefined : this.#store;
  }

  /** The active store, or the refusal naming why there is none. */
  #active(): IInboxStore {
    if (this.#closed) throw new InboxNotReadyError('closed');
    const store = this.#store;
    if (store === undefined) throw new InboxNotReadyError('not-started');
    return store;
  }

  /**
   * Registers one subscription's `(consumer, topic)` pair at resolution time.
   *
   * @param consumer - The consumer name
   * @param topic - The subscription topic
   * @throws {InboxNotReadyError} Before the store is verified, or after close
   * @throws {InboxConsumerConflictError} When the pair is already registered
   */
  attach(consumer: string, topic: string): void {
    this.#active();
    const key = JSON.stringify([consumer, topic]);
    if (this.#registered.has(key)) throw new InboxConsumerConflictError(consumer, topic);
    this.#registered.add(key);
  }

  /** Runs one store call under `storeTimeoutMs`. */
  #bounded<R>(call: () => Promise<R>): Promise<R> {
    const timeoutMs = this.#deps.options.storeTimeoutMs;
    return withDeadline(call, {
      timeoutMs,
      onTimeout: () =>
        new Error(
          `inbox: a store call did not settle within ${timeoutMs} ms (inbox.storeTimeoutMs)`,
        ),
      timing: resolveProbeTiming(this.#deps.runtime),
    });
  }

  /** Logs at `warn`, never letting a broken logger change an outcome. */
  #warn(message: string, metadata: Record<string, unknown>): void {
    try {
      this.#deps.logger()?.warn(message, metadata);
    } catch {
      // A logger failure must never turn into the delivery's outcome.
    }
  }

  /**
   * Runs one delivery through the inbox (§3.6): validate, look the marker up,
   * parse, then create the marker and run the handler in one transaction.
   * Resolving means "acknowledge"; rejecting hands the failure to the broker.
   *
   * @param subscription - The subscription the broker delivered to
   * @param raw - The delivered message
   * @param metadata - Transport metadata
   */
  async deliver<T>(
    subscription: InboxSubscription<T>,
    raw: unknown,
    metadata: MessageMetadata,
  ): Promise<void> {
    const { consumer, definition, handler } = subscription;
    const envelope = validateEnvelope(raw, definition);
    const store = this.#active();
    const ids = await deriveInboxIds(this.#deps.runtime.subtle, consumer, envelope.id);
    if ((await this.#bounded(() => store.find(ids.marker))) !== undefined) return;

    const base = this.#baseRecord(consumer, definition.topic, envelope.id);
    let payload: T;
    try {
      payload = parseEnvelopeData(envelope, definition);
    } catch (rejection) {
      // A deterministic rejection: redelivery cannot resolve it, so with
      // parking enabled it parks at once (and can be retried once the schema
      // is fixed); without, the broker's own path takes it, as today.
      if (this.#deps.options.maxAttempts === undefined) throw rejection;
      await this.#park(store, ids, base, raw, rejection, 1, 'rejected');
      return;
    }

    const delivered: IntegrationEventEnvelope<T> = { ...envelope, data: payload };
    const marker: InboxRecord = {
      ...base,
      id: ids.marker,
      status: 'processed',
      attempts: 0,
      updatedAt: this.#deps.runtime.now(),
    };
    try {
      await store.run(marker, async (scope) => {
        await handler(payload, delivered, metadata, scope);
      });
    } catch (error) {
      // Re-read after ANY rejection: a commit-time duplicate carries no
      // entity, a MongoDB loser is a write conflict and a DynamoDB
      // transaction conflict is unclassified, so the error alone cannot say
      // whether another delivery handled this event. A present marker can:
      // a committed marker means the work committed (or was parked).
      if (await this.#markerPresent(store, ids.marker)) return;
      await this.#fail(store, ids, base, raw, error);
    }
  }

  /** The fields every row of this delivery carries. */
  #baseRecord(
    consumer: string,
    topic: string,
    envelopeId: string,
  ): Pick<InboxRecord, 'kind' | 'consumer' | 'topic' | 'envelopeId'> {
    return {
      kind: INBOX_RECORD_KIND,
      consumer,
      topic,
      // Stored only when it is a valid publish id, so a hostile id never
      // reaches a row, a listing or a log in raw form.
      ...(publishIdProblem(envelopeId) === null ? { envelopeId } : {}),
    };
  }

  /** Whether a marker exists; a failing read counts as "no", and the original error stands. */
  async #markerPresent(store: IInboxStore, markerId: string): Promise<boolean> {
    try {
      return (await this.#bounded(() => store.find(markerId))) !== undefined;
    } catch (error) {
      this.#warn('inbox: re-reading a marker after a failed delivery failed', {
        error: describeError(error),
      });
      return false;
    }
  }

  /**
   * The failure path (§3.8): without `maxAttempts`, rethrow; with it, count
   * the failure outside the rolled-back transaction and park at the limit.
   */
  async #fail(
    store: IInboxStore,
    ids: InboxIds,
    base: Pick<InboxRecord, 'consumer' | 'topic' | 'envelopeId'>,
    raw: unknown,
    error: unknown,
  ): Promise<void> {
    const maxAttempts = this.#deps.options.maxAttempts;
    if (maxAttempts === undefined) throw error;
    let count: number;
    try {
      count = await this.#bounded(() =>
        store.recordFailure(ids, {
          consumer: base.consumer,
          topic: base.topic,
          ...(base.envelopeId !== undefined ? { envelopeId: base.envelopeId } : {}),
          lastError: errorLine(error),
          now: this.#deps.runtime.now(),
        })
      );
    } catch (recordError) {
      this.#warn('inbox: recording a delivery failure failed', {
        consumer: base.consumer,
        topic: base.topic,
        error: describeError(recordError),
      });
      throw error;
    }
    if (count < maxAttempts) throw error;
    await this.#park(store, ids, base, raw, error, count, 'exhausted');
  }

  /** Parks a delivery and resolves (acknowledging it), or rethrows `error` when parking fails. */
  async #park(
    store: IInboxStore,
    ids: InboxIds,
    base: Pick<InboxRecord, 'consumer' | 'topic' | 'envelopeId'>,
    raw: unknown,
    error: unknown,
    attempts: number,
    cause: 'exhausted' | 'rejected',
  ): Promise<void> {
    const envelope = this.#storableEnvelope(raw);
    const marker: InboxRecord = {
      kind: INBOX_RECORD_KIND,
      ...base,
      id: ids.marker,
      status: 'parked',
      attempts,
      updatedAt: this.#deps.runtime.now(),
      lastError: errorLine(error),
      ...(envelope !== undefined ? { envelope } : {}),
    };
    let outcome: 'applied' | 'exists';
    try {
      outcome = await this.#bounded(() => store.park(marker));
    } catch (parkError) {
      this.#warn('inbox: parking a delivery failed', {
        consumer: base.consumer,
        topic: base.topic,
        error: describeError(parkError),
      });
      throw error;
    }
    // `exists`: another delivery's marker was already there, so nothing was
    // parked and there is nothing for an operator to act on.
    if (outcome === 'exists') return;
    this.#warn(
      cause === 'exhausted'
        ? 'inbox: parked a delivery after repeated failures'
        : 'inbox: parked a delivery whose payload the definition rejected',
      { consumer: base.consumer, topic: base.topic, attempts },
    );
  }

  /** The envelope as stored on a parked marker, or `undefined` when over the cap or unserializable. */
  #storableEnvelope(raw: unknown): string | undefined {
    const cap = this.#deps.options.maxParkedEnvelopeBytes;
    if (cap === 0) return undefined;
    let text: string;
    try {
      text = JSON.stringify(raw);
    } catch {
      return undefined;
    }
    return new TextEncoder().encode(text).byteLength <= cap ? text : undefined;
  }

  /** @inheritdoc */
  async parked(limit: number = DEFAULT_PARKED_LIMIT): Promise<readonly ParkedInboxEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PARKED_LIMIT) {
      throw new RangeError(
        `inbox: parked() limit must be an integer between 1 and ${MAX_PARKED_LIMIT}`,
      );
    }
    const store = this.#active();
    const rows = await this.#bounded(() => store.parked(limit));
    return rows.map((row) => ({
      rowId: row.id,
      consumer: row.consumer,
      topic: row.topic,
      attempts: row.attempts,
      updatedAt: row.updatedAt,
      ...(row.envelopeId !== undefined ? { envelopeId: row.envelopeId } : {}),
      ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    }));
  }

  /** @inheritdoc */
  async release(rowId: string, action: 'retry' | 'discard'): Promise<InboxReleaseResult> {
    if (!isMarkerId(rowId)) throw new InboxRowStateError('invalid-id');
    if (action !== 'retry' && action !== 'discard') {
      throw new TypeError("inbox: release() action must be 'retry' or 'discard'");
    }
    const store = this.#active();
    const now = this.#deps.runtime.now();
    const outcome = await this.#bounded(() => store.release(idsFromMarker(rowId), action, now));
    if (outcome.outcome === 'missing') throw new InboxRowStateError('missing');
    if (outcome.outcome === 'not-parked') {
      throw new InboxRowStateError('not-parked', outcome.status);
    }
    const { record } = outcome;
    if (action === 'discard' || record.envelope === undefined) return { topic: record.topic };
    try {
      return { topic: record.topic, envelope: JSON.parse(record.envelope) as unknown };
    } catch {
      // An edited row: the marker is gone, so report the topic and no envelope.
      return { topic: record.topic };
    }
  }

  /** @inheritdoc */
  async purge(): Promise<number> {
    const store = this.#active();
    const { retainMs, purgeBatch } = this.#deps.options;
    const before = this.#deps.runtime.now() - retainMs;
    return await this.#bounded(() => store.purge(before, purgeBatch));
  }
}

/** One bounded error line for a row. */
function errorLine(error: unknown): string {
  const line = describeError(error);
  return line.length > MAX_ERROR_LENGTH ? line.slice(0, MAX_ERROR_LENGTH) : line;
}
