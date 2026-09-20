/**
 * Diagnostics event buffer — a bounded, non-destructive ring of frozen
 * execution records with dense per-instance sequence numbers.
 *
 * Two bounds are enforced here, both fixed v1 constants and deliberately not
 * options: the ring holds 1,024 events, and one event may encode to at most
 * 1,024 UTF-8 bytes. An oversized event is dropped WHOLE — truncating one
 * would mint a record whose shape the contract never defined. Eviction is
 * oldest-first and is reported to readers as `lost` sequence numbers rather
 * than hidden.
 *
 * Readers never mutate the ring: `read` is a pure window over the retained
 * range, so two readers polling at different cursors never steal from each
 * other and a slow consumer cannot backpressure the application.
 *
 * @module
 */
import type { DiagnosticsEvent } from '@setu-ts/common';

import { saturatingNext } from './projection.ts';

/** Fixed v1 limit: events retained by the ring. */
export const EVENT_CAPACITY = 1024;

/** Fixed v1 limit: maximum UTF-8 byte length of one compact-encoded event. */
export const MAX_EVENT_BYTES = 1024;

/** Fixed v1 limit: maximum events returned by one read. */
export const MAX_READ_LIMIT = 128;

const encoder = new TextEncoder();

/**
 * Bounded length of every string field an event may carry. Ids, stages, and
 * outcomes are collector-owned fixed-vocabulary or bounded-identifier strings;
 * the collector refuses any field over this bound at capture, dropping the
 * event WHOLE.
 */
const MAX_FIELD_LENGTH = 64;

/**
 * Compact-JSON skeleton overhead of an event with empty variable fields:
 * braces, keys, commas, the fixed kind/stage/outcome vocabulary, and maximal
 * numeric fields. Every string field is collector-owned ASCII (ids, fixed
 * vocabulary, validated hex identifiers), so the UTF-8 length equals the
 * character count and the skeleton constant is an upper bound, not an
 * estimate.
 */
const EVENT_SKELETON_BYTES = 220;

/**
 * The pre-serialization byte bound for one event — the M98a §3.6 rule that
 * strings and counts are bounded BEFORE serialization, not measured after.
 * With every field bounded at capture, the 1,024-byte cap holds
 * structurally, so the request path never pays for a `JSON.stringify` it
 * does not need.
 *
 * @param fieldLengths - Character lengths of the variable string fields
 * @returns `true` when the encoded event is within {@linkcode MAX_EVENT_BYTES}
 * @since 0.8.0
 */
export function eventWithinByteCap(
  fieldLengths: {
    readonly operationId: number;
    readonly parentOperationId: number;
    readonly nodeId: number;
    readonly traceId: number;
    readonly spanId: number;
    readonly statusCode: boolean;
  },
): boolean {
  const bounded = EVENT_SKELETON_BYTES +
    fieldLengths.operationId + fieldLengths.parentOperationId + fieldLengths.nodeId +
    fieldLengths.traceId + fieldLengths.spanId +
    (fieldLengths.statusCode ? 21 : 0);
  return bounded <= MAX_EVENT_BYTES;
}

/** The capture-time bound for one string field of an event. */
export const MAX_EVENT_FIELD_LENGTH = MAX_FIELD_LENGTH;

/**
 * The exact UTF-8 byte length of the event's compact JSON encoding — used by
 * tests to prove the structural bound above is sound against a real
 * encoding, never on the request path.
 *
 * @param event - The event to measure
 * @returns Encoded byte length
 * @since 0.8.0
 */
export function encodedEventByteLength(event: DiagnosticsEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}

/**
 * Cursor validation for {@linkcode IDiagnosticsSource.read}-shaped reads.
 * Exported pure so the exact refusal behavior is unit-testable without a
 * collector.
 *
 * @param after - The requested sequence cursor
 * @param limit - The requested page size (`undefined` for the 128 default)
 * @param lastSequence - The ring's most recently assigned sequence
 * @returns The normalized `{ after, limit }`
 * @throws {RangeError} With a fixed, VALUE-FREE message when `after` is not a
 * non-negative safe integer, when `limit` is not an integer from 1 to 128, or
 * when `after` is beyond the current sequence
 * @since 0.8.0
 */
export function validateReadCursor(
  after: number,
  limit: number | undefined,
  lastSequence: number,
): { after: number; limit: number } {
  if (
    typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0
  ) {
    throw new RangeError('Invalid diagnostics cursor: expected a non-negative safe integer.');
  }
  const effectiveLimit = limit ?? MAX_READ_LIMIT;
  if (
    typeof effectiveLimit !== 'number' || !Number.isSafeInteger(effectiveLimit) ||
    effectiveLimit < 1 || effectiveLimit > MAX_READ_LIMIT
  ) {
    throw new RangeError(
      `Invalid diagnostics read limit: expected an integer from 1 to ${MAX_READ_LIMIT}.`,
    );
  }
  if (after > lastSequence) {
    throw new RangeError('Invalid diagnostics cursor: beyond the current sequence.');
  }
  return { after, limit: effectiveLimit };
}

/**
 * Bounded event ring. Sequences are allocated ONLY on a successful store, so
 * the numbering is dense and a reader's `lost` count means exactly one thing:
 * records evicted between its cursor and the oldest retained record.
 *
 * @since 0.8.0
 */
export class DiagnosticsEventRing {
  #firstSequence = 1;
  #lastSequence = 0;
  readonly #slots: (DiagnosticsEvent | undefined)[] = new Array(EVENT_CAPACITY);
  #closed = false;

  /** Most recently assigned sequence number. */
  get lastSequence(): number {
    return this.#lastSequence;
  }

  /** Oldest retained sequence number (1 when nothing has been evicted). */
  get firstSequence(): number {
    return this.#firstSequence;
  }

  /** Whether the ring is closed to further writes (application stopped). */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Allocates the next sequence number, or `null` at saturation — the caller
   * then stops event collection rather than letting identifiers wrap.
   *
   * @returns The next sequence number, or `null` when saturated
   */
  allocateSequence(): number | null {
    const next = saturatingNext(this.#lastSequence);
    if (next === null) {
      return null;
    }
    return next;
  }

  /**
   * Stores a pre-built, pre-measured frozen event under the given sequence.
   * Evicts the oldest retained event when the ring is full.
   *
   * @param sequence - The sequence allocated by {@linkcode allocateSequence}
   * @param event - The frozen event to retain
   */
  store(sequence: number, event: DiagnosticsEvent): void {
    this.#slots[(sequence - 1) % EVENT_CAPACITY] = event;
    this.#lastSequence = sequence;
    if (sequence - this.#firstSequence >= EVENT_CAPACITY) {
      this.#firstSequence = sequence - EVENT_CAPACITY + 1;
    }
  }

  /**
   * Returns the event stored under a sequence number, or `undefined` when that
   * sequence was evicted or never allocated.
   *
   * @param sequence - The sequence number to read
   * @returns The frozen event, or `undefined`
   */
  at(sequence: number): DiagnosticsEvent | undefined {
    if (sequence < this.#firstSequence || sequence > this.#lastSequence) {
      return undefined;
    }
    return this.#slots[(sequence - 1) % EVENT_CAPACITY];
  }

  /**
   * Closes the ring to further writes.
   *
   * Retained events are NOT discarded here — {@linkcode clear} does that —
   * but the collector's terminal shutdown path calls both, and its `read()`
   * short-circuits on a closed ring, so a consumer never drains a tail after
   * shutdown: it gets an empty `closed` batch. Closing and clearing are kept
   * separate so the ring has one reason to change at a time.
   */
  close(): void {
    this.#closed = true;
  }

  /**
   * Discards every retained event and resets the sequence bookkeeping. Used
   * only by the teardown path: a failed startup or a final shutdown must not
   * leave collected metadata recoverable through a read.
   */
  clear(): void {
    this.#slots.fill(undefined);
    this.#firstSequence = 1;
    this.#lastSequence = 0;
  }
}
