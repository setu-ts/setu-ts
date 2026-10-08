/**
 * The HTTP record: encode a response into a stored string, decode it back with
 * full validation, and replay it (plan §3.10).
 *
 * Decoding is a trust boundary: a store may be shared or corrupted, so
 * `decodeHttpRecord` re-validates the status, the headers (against the CURRENT
 * allow/deny lists) and the body size before any byte is written to a response.
 *
 * @module
 */
import type {
  HandlerResult,
  IRedactionService,
  IRequestContext,
  ResponseSnapshot,
} from '@setu-ts/common';
import { decodeFrameData, encodeFrameData } from '@setu-ts/common';
import type { EncodedPayload } from '@setu-ts/common';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  RECORDABLE_STATUS_MAX,
  RECORDABLE_STATUS_MIN,
  REPLAY_HEADER_ALLOW,
  REPLAY_HEADER_DENY_SET,
} from '../constants.ts';
import type { ResolvedRouteOptions } from './options.ts';

const encoder = new TextEncoder();
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** Why a response was recorded without its body/headers. */
export type RecordOmissionReason =
  | 'response-mode'
  | 'stream'
  | 'size'
  | 'store-limit'
  | 'redaction';

/** The result of {@linkcode encodeHttpRecord}. */
export interface EncodedHttpRecord {
  /** The serialized record. */
  readonly record: string;
  /** Why the body/headers were dropped, or `undefined` when recorded in full. */
  readonly omitted: RecordOmissionReason | undefined;
}

/** A validated record, ready to replay. */
export interface DecodedHttpRecord {
  /** The recorded status (200–499). */
  readonly status: number;
  /** The recorded `[name, value]` headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** The recorded body bytes, a text body as a string, or `null`. */
  readonly body: Uint8Array | string | null;
}

/**
 * Returned by {@linkcode decodeHttpRecord} when a record is invalid. Internal
 * (the middleware logs it and answers 503).
 *
 * @since 0.9.0
 */
export class IdempotencyRecordError extends Error {
  override readonly name = 'IdempotencyRecordError';

  /**
   * @param message - A message naming the failed rule, never the content
   */
  constructor(message: string) {
    super(message);
  }
}

/** The status-only record for a given status. */
function statusOnly(status: number): string {
  return JSON.stringify({ v: 1, s: status, h: [], b: null });
}

/** UTF-8 byte length of a string. */
function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

/** The header names replayable for this route. */
function allowedHeaders(resolved: ResolvedRouteOptions): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const name of REPLAY_HEADER_ALLOW) if (!REPLAY_HEADER_DENY_SET.has(name)) allowed.add(name);
  for (const name of resolved.replayHeaders) {
    if (!REPLAY_HEADER_DENY_SET.has(name)) allowed.add(name);
  }
  return allowed;
}

/**
 * Encodes a response snapshot into a stored record.
 *
 * @param snapshot - The response snapshot
 * @param resolved - The resolved route options
 * @param maxRecordBytes - The store's `maxRecordBytes`, or `undefined`
 * @returns The record and the omission reason, if any
 */
export function encodeHttpRecord(
  snapshot: ResponseSnapshot,
  resolved: ResolvedRouteOptions,
  maxRecordBytes: number | undefined,
): EncodedHttpRecord {
  let reason: RecordOmissionReason | undefined;
  if (resolved.response === 'status') {
    reason = 'response-mode';
  } else if (snapshot.streaming) {
    reason = 'stream';
  }
  if (reason !== undefined) {
    return { record: statusOnly(snapshot.status), omitted: reason };
  }

  const raw = snapshot.body as Uint8Array | string | null;
  let bytes: Uint8Array | null = raw === null
    ? null
    : (typeof raw === 'string' ? encoder.encode(raw) : raw);
  if ((bytes?.byteLength ?? 0) > resolved.maxResponseBytes) {
    return { record: statusOnly(snapshot.status), omitted: 'size' };
  }
  if (resolved.redaction !== undefined) {
    const redacted = redactJsonBody(
      bytes,
      snapshot.headers.get('content-type'),
      resolved.redaction,
    );
    if (redacted === undefined) {
      return { record: statusOnly(snapshot.status), omitted: 'redaction' };
    }
    bytes = redacted;
  }

  const headers: [string, string][] = [];
  const allowed = allowedHeaders(resolved);
  for (const [name, value] of snapshot.headers) {
    const lower = name.toLowerCase();
    if (REPLAY_HEADER_DENY_SET.has(lower) || !allowed.has(lower)) continue;
    headers.push([lower, value]);
  }
  const payload: EncodedPayload | null = bytes === null ? null : encodeFrameData(bytes);
  const record = JSON.stringify({ v: 1, s: snapshot.status, h: headers, b: payload });
  if (maxRecordBytes !== undefined && utf8Length(record) > maxRecordBytes) {
    return { record: statusOnly(snapshot.status), omitted: 'store-limit' };
  }
  return { record, omitted: undefined };
}

/** Redacts a JSON-object body, or returns `undefined` when it is not one. */
function redactJsonBody(
  bytes: Uint8Array | null,
  contentType: string | null,
  redaction: IRedactionService,
): Uint8Array | undefined {
  if (bytes === null) return undefined;
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const redacted = redaction.redactRecord(parsed as Readonly<Record<string, unknown>>);
  return encoder.encode(JSON.stringify(redacted));
}

/**
 * Validates and decodes a stored record.
 *
 * @param record - The stored record string
 * @param resolved - The resolved route options (for the current allow list and cap)
 * @returns The decoded record, or an {@linkcode IdempotencyRecordError}
 */
export function decodeHttpRecord(
  record: string,
  resolved: ResolvedRouteOptions,
): DecodedHttpRecord | IdempotencyRecordError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return new IdempotencyRecordError('stored record is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new IdempotencyRecordError('stored record is not an object');
  }
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1) return new IdempotencyRecordError('stored record version is not 1');

  const status = value.s;
  if (
    typeof status !== 'number' || !Number.isInteger(status) || status < RECORDABLE_STATUS_MIN ||
    status > RECORDABLE_STATUS_MAX
  ) {
    return new IdempotencyRecordError('stored status is not an integer in 200-499');
  }

  const allowed = allowedHeaders(resolved);
  const rawHeaders = value.h;
  if (!Array.isArray(rawHeaders)) {
    return new IdempotencyRecordError('stored headers are not an array');
  }
  const headers: [string, string][] = [];
  for (const pair of rawHeaders) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return new IdempotencyRecordError('a stored header is not a [name, value] pair');
    }
    const name = pair[0];
    const headerValue = pair[1];
    if (typeof name !== 'string' || typeof headerValue !== 'string') {
      return new IdempotencyRecordError('a stored header is not a pair of strings');
    }
    const lower = name.toLowerCase();
    if (REPLAY_HEADER_DENY_SET.has(lower)) {
      return new IdempotencyRecordError('a stored header is on the replay deny list');
    }
    if (!allowed.has(lower)) {
      return new IdempotencyRecordError('a stored header is not on the replay allow list');
    }
    if (headerValue.includes('\r') || headerValue.includes('\n')) {
      return new IdempotencyRecordError('a stored header value contains CR or LF');
    }
    try {
      new Headers().set(lower, headerValue);
    } catch {
      return new IdempotencyRecordError('a stored header value is not a valid header value');
    }
    headers.push([lower, headerValue]);
  }

  const rawBody = value.b;
  if (rawBody === null) {
    return { status, headers, body: null };
  }
  if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return new IdempotencyRecordError('stored body is not null or an object');
  }
  const body = rawBody as { data?: unknown; binary?: unknown };
  if (typeof body.data !== 'string') {
    return new IdempotencyRecordError('stored body data is not a string');
  }
  if (body.binary !== undefined && typeof body.binary !== 'boolean') {
    return new IdempotencyRecordError('stored body binary flag is not a boolean');
  }
  const encodedBody: EncodedPayload = body.binary === true
    ? { data: body.data, binary: true }
    : { data: body.data };
  const decoded = decodeFrameData(encodedBody);
  const byteLength = typeof decoded === 'string' ? utf8Length(decoded) : decoded.byteLength;
  if (byteLength > resolved.maxResponseBytes) {
    return new IdempotencyRecordError('stored body exceeds the route maxResponseBytes');
  }
  return { status, headers, body: decoded };
}

/**
 * Writes a decoded record to the response.
 *
 * @param ctx - The request context
 * @param decoded - The decoded record
 * @returns The handler result
 */
export function replay(ctx: IRequestContext, decoded: DecodedHttpRecord): HandlerResult {
  ctx.response.status(decoded.status);
  for (const [name, value] of decoded.headers) {
    ctx.response.header(name, value);
  }
  ctx.response.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
  if (decoded.body === null) return ctx.response.send();
  if (typeof decoded.body === 'string') return ctx.response.send(encoder.encode(decoded.body));
  return ctx.response.send(decoded.body);
}
