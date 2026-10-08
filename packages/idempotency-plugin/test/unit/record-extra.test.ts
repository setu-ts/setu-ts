/**
 * Additional record-codec edge cases (plan §3.10): the store-limit and
 * redaction paths, and the status-only records they produce.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedactionService, ResponseSnapshot } from '@setu-ts/common';
import type { ResolvedRouteOptions } from '../../src/core/options.ts';
import {
  decodeHttpRecord,
  encodeHttpRecord,
  IdempotencyRecordError,
} from '../../src/core/record.ts';

/** Resolved route options with defaults. */
function resolved(over: Partial<ResolvedRouteOptions> = {}): ResolvedRouteOptions {
  return {
    key: { header: 'Idempotency-Key' },
    required: true,
    principal: 'required',
    namespace: undefined,
    fingerprint: 'request',
    leaseMs: 1_000,
    ttlMs: 60_000,
    response: 'full',
    maxResponseBytes: 262_144,
    replayHeaders: [],
    redaction: undefined,
    ...over,
  };
}

/** A buffered snapshot. */
function snapshot(
  body: Uint8Array | string | null,
  status = 200,
  headers = new Headers(),
): ResponseSnapshot {
  return { streaming: false, status, headers, body };
}

const redactor: IRedactionService = {
  redactValue: (_p, value) => value,
  redactRecord: (record) => ({ ...record, token: '[redacted]' }),
};

describe('record codec — store limit and redaction (M109a §3.10)', () => {
  it('returns a status-only record when the serialized record exceeds the store limit', () => {
    const encoded = encodeHttpRecord(snapshot('a'.repeat(500)), resolved(), 20);
    expect(encoded.omitted).toBe('store-limit');
    const parsed = JSON.parse(encoded.record) as { b: unknown; h: unknown[] };
    expect(parsed.b).toBeNull();
    expect(parsed.h).toEqual([]);
  });

  it('redacts a JSON object body and stores the redacted JSON', () => {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    const encoded = encodeHttpRecord(
      snapshot(JSON.stringify({ token: 'raw' }), 200, headers),
      resolved({ redaction: redactor }),
      undefined,
    );
    expect(encoded.omitted).toBeUndefined();
    const decoded = decodeHttpRecord(encoded.record, resolved());
    if (decoded instanceof IdempotencyRecordError) throw decoded;
    expect(new TextDecoder().decode(decoded.body as Uint8Array)).toBe('{"token":"[redacted]"}');
  });

  it('records status-only when redaction is set but the body is not a JSON object', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    expect(
      encodeHttpRecord(
        snapshot('plain', 200, headers),
        resolved({ redaction: redactor }),
        undefined,
      ).omitted,
    )
      .toBe('redaction');
    // A JSON array is not a plain object either.
    const jsonHeaders = new Headers({ 'content-type': 'application/json' });
    expect(
      encodeHttpRecord(
        snapshot('[]', 200, jsonHeaders),
        resolved({ redaction: redactor }),
        undefined,
      ).omitted,
    ).toBe('redaction');
  });

  it('round-trips a binary body', () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const encoded = encodeHttpRecord(snapshot(bytes), resolved(), undefined);
    const decoded = decodeHttpRecord(encoded.record, resolved());
    if (decoded instanceof IdempotencyRecordError) throw decoded;
    expect(decoded.body).toEqual(bytes);
  });
});
