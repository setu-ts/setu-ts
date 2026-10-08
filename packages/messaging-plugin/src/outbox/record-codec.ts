/**
 * Encodes an outbox record at write time and decodes it at relay time
 * (M107 §3.2, §3.7).
 *
 * The decode re-validates EVERY field the relay acts on, because a row may
 * have been edited by anyone with write access to the table (§10 A3). A row
 * that fails is `invalid-row`: the relay marks it `failed` and never publishes
 * it, poisoning its key rather than ordering by one key and placing by another.
 *
 * @module
 */
import type { OutboxRecord, ParsedPublishOptions } from '@setu-ts/common';
import {
  hasForbiddenAliasCharacter,
  MAX_PUBLISH_HEADER_NAME_BYTES,
  MAX_PUBLISH_HEADER_VALUE_BYTES,
  MAX_PUBLISH_HEADERS,
  MAX_PUBLISH_ID_BYTES,
  OUTBOX_RECORD_KIND,
  parsePublishOptions,
} from '@setu-ts/common';

import type { IntegrationEventEnvelope } from '../integration/envelope.ts';
import { OutboxEnvelopeTooLargeError } from './errors.ts';

/** The most UTF-8 bytes a stored topic may carry. */
const MAX_TOPIC_BYTES = 255;

const UTF8 = new TextEncoder();

/**
 * The longest `options` text (in UTF-16 code units, so the check is O(1)) a
 * row written by {@linkcode encodeOutboxRecord} can carry. Derived from the
 * M106 bounds rather than chosen: every stored byte escapes to at most six
 * code units (`\u00XX`), plus the quotes, colons and commas around the
 * ordering key, the de-duplication id and each header, and the fixed keys.
 * Anything longer was not written by the outbox, so it is refused before the
 * parse it would otherwise cost.
 *
 * @internal
 */
export const MAX_STORED_OPTIONS_LENGTH = 6 *
    (2 * MAX_PUBLISH_ID_BYTES +
      MAX_PUBLISH_HEADERS * (MAX_PUBLISH_HEADER_NAME_BYTES + MAX_PUBLISH_HEADER_VALUE_BYTES)) +
  MAX_PUBLISH_HEADERS * 6 +
  64;

/**
 * Everything the writer knows about one row before it is appended.
 *
 * @internal
 */
export interface OutboxRecordInput {
  readonly topic: string;
  readonly envelope: IntegrationEventEnvelope<unknown>;
  readonly options: ParsedPublishOptions;
  readonly position: string;
  readonly createdAt: number;
  readonly maxEnvelopeBytes: number;
  readonly tenantId?: string;
  readonly traceparent?: string;
}

/**
 * Serializes the envelope and builds the pending record.
 *
 * The stored options are exactly the EFFECTIVE options: the ordering key when
 * present, the de-duplication id, and the headers when any were supplied.
 *
 * @internal
 * @param input - The row's parts
 * @returns The record to append
 * @throws {OutboxEnvelopeTooLargeError} When the serialized envelope exceeds
 *   `maxEnvelopeBytes`
 */
export function encodeOutboxRecord(input: OutboxRecordInput): OutboxRecord {
  const envelope = JSON.stringify(input.envelope);
  const bytes = UTF8.encode(envelope).length;
  if (bytes > input.maxEnvelopeBytes) {
    throw new OutboxEnvelopeTooLargeError(bytes, input.maxEnvelopeBytes);
  }
  const { orderingKey, deduplicationId, headers } = input.options;
  const options = JSON.stringify({
    ...(orderingKey !== undefined ? { orderingKey } : {}),
    deduplicationId,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  return {
    id: input.envelope.id,
    kind: OUTBOX_RECORD_KIND,
    topic: input.topic,
    envelope,
    options,
    ...(orderingKey !== undefined ? { orderingKey } : {}),
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
    position: input.position,
    createdAt: input.createdAt,
    status: 'pending',
    attempts: 0,
    availableAt: input.createdAt,
  };
}

/**
 * A row the relay may publish.
 *
 * @internal
 */
export interface DecodedOutboxRow {
  readonly topic: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly options: ParsedPublishOptions;
}

/**
 * Why a stored row was refused. Never carries the row's contents.
 *
 * @internal
 */
export type InvalidRowCause =
  | 'envelope-too-large'
  | 'envelope-not-json'
  | 'envelope-id-mismatch'
  | 'options-invalid'
  | 'options-too-large'
  | 'ordering-key-mismatch'
  | 'topic-invalid';

/** Whether a stored topic is publishable: non-empty, bounded, no Cc/Cf/Zl/Zp. */
function isValidTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && topic.length > 0 && topic.isWellFormed() &&
    UTF8.encode(topic).length <= MAX_TOPIC_BYTES && !hasForbiddenAliasCharacter(topic);
}

/** Parses JSON, answering `undefined` for anything unparseable. */
function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes a stored row, re-validating every field the relay acts on.
 *
 * @internal
 * @param record - The stored row
 * @param maxEnvelopeBytes - The configured envelope ceiling
 * @returns The decoded row, or the cause it was refused
 */
export function decodeOutboxRecord(
  record: OutboxRecord,
  maxEnvelopeBytes: number,
): { readonly ok: true; readonly row: DecodedOutboxRow } | {
  readonly ok: false;
  readonly cause: InvalidRowCause;
} {
  if (!isValidTopic(record.topic)) return { ok: false, cause: 'topic-invalid' };
  if (typeof record.envelope !== 'string') return { ok: false, cause: 'envelope-not-json' };
  if (UTF8.encode(record.envelope).length > maxEnvelopeBytes) {
    return { ok: false, cause: 'envelope-too-large' };
  }
  const envelope = parseJson(record.envelope);
  if (!isObject(envelope)) return { ok: false, cause: 'envelope-not-json' };
  if (envelope.id !== record.id) return { ok: false, cause: 'envelope-id-mismatch' };
  if (typeof record.options === 'string' && record.options.length > MAX_STORED_OPTIONS_LENGTH) {
    return { ok: false, cause: 'options-too-large' };
  }
  const rawOptions = parseJson(record.options);
  let options: ParsedPublishOptions;
  try {
    options = parsePublishOptions(rawOptions);
  } catch {
    return { ok: false, cause: 'options-invalid' };
  }
  if (options.deduplicationId === undefined) return { ok: false, cause: 'options-invalid' };
  // The column decides blocking and the options decide placement: a
  // disagreement would order by one key and place by another.
  if (options.orderingKey !== record.orderingKey) {
    return { ok: false, cause: 'ordering-key-mismatch' };
  }
  return { ok: true, row: { topic: record.topic, envelope, options } };
}
