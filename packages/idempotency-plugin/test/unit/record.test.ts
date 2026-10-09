/**
 * Unit tests for the HTTP record codec (plan §3.10).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HandlerResult,
  IRedactionService,
  IRequestContext,
  ResponseSnapshot,
} from '@setu-ts/common';
import type { ResolvedRouteOptions } from '../../src/core/options.ts';
import {
  decodeHttpRecord,
  encodeHttpRecord,
  IdempotencyRecordError,
  replay,
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
function buffered(
  over: { status?: number; headers?: Headers; body?: Uint8Array | string | null } = {},
): ResponseSnapshot {
  return {
    streaming: false,
    status: over.status ?? 200,
    headers: over.headers ?? new Headers({ 'content-type': 'text/plain' }),
    body: over.body ?? null,
  };
}

/** A redaction service that tags a field. */
const taggingRedactor: IRedactionService = {
  redactValue: (_path, value) => value,
  redactRecord: (record) => ({ ...record, secret: '[redacted]' }),
};

describe('encodeHttpRecord (M109a §3.10)', () => {
  it('round-trips a string body through the codec', () => {
    const encoded = encodeHttpRecord(buffered({ body: 'hi' }), resolved(), undefined);
    expect(encoded.omitted).toBeUndefined();
    const decoded = decodeHttpRecord(encoded.record, resolved());
    expect(decoded).not.toBeInstanceOf(IdempotencyRecordError);
    if (decoded instanceof IdempotencyRecordError) return;
    const body = decoded.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body as Uint8Array)).toBe('hi');
  });

  it('applies the ALLOW and DENY lists', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-custom': 'dropped',
      'set-cookie': 'sid=1',
      'content-language': 'fr',
    });
    const encoded = encodeHttpRecord(buffered({ headers }), resolved(), undefined);
    const decoded = decodeHttpRecord(encoded.record, resolved());
    if (decoded instanceof IdempotencyRecordError) throw decoded;
    expect(decoded.headers.map(([name]) => name)).toEqual(['content-type']);
  });

  it('records status-only for response: "status"', () => {
    const encoded = encodeHttpRecord(
      buffered({ body: 'x' }),
      resolved({ response: 'status' }),
      undefined,
    );
    expect(encoded.omitted).toBe('response-mode');
    expect(JSON.parse(encoded.record).b).toBeNull();
  });

  it('records status-only for a streaming response', () => {
    const snapshot = {
      streaming: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>(),
    } as ResponseSnapshot;
    expect(encodeHttpRecord(snapshot, resolved(), undefined).omitted).toBe('stream');
  });

  it('records status-only when the body exceeds maxResponseBytes', () => {
    const encoded = encodeHttpRecord(
      buffered({ body: 'abcd' }),
      resolved({ maxResponseBytes: 3 }),
      undefined,
    );
    expect(encoded.omitted).toBe('size');
  });

  it('records status-only when the serialized record exceeds the store limit', () => {
    const encoded = encodeHttpRecord(buffered({ body: 'a'.repeat(100) }), resolved(), 10);
    expect(encoded.omitted).toBe('store-limit');
  });

  it('redacts a JSON object body and records status-only for a non-object body', () => {
    const jsonHeaders = new Headers({ 'content-type': 'application/json' });
    const encoded = encodeHttpRecord(
      buffered({ headers: jsonHeaders, body: JSON.stringify({ secret: 'value' }) }),
      resolved({ redaction: taggingRedactor }),
      undefined,
    );
    if (encoded.omitted !== undefined) throw new Error('expected a full record');
    const decoded = decodeHttpRecord(encoded.record, resolved({ redaction: taggingRedactor }));
    if (decoded instanceof IdempotencyRecordError) throw decoded;
    expect(new TextDecoder().decode(decoded.body as Uint8Array)).toContain('[redacted]');

    const plain = encodeHttpRecord(
      buffered({ body: 'plain text' }),
      resolved({ redaction: taggingRedactor }),
      undefined,
    );
    expect(plain.omitted).toBe('redaction');
  });
});

describe('decodeHttpRecord (M109a §3.10)', () => {
  const record = (value: unknown): string => JSON.stringify(value);

  it('rejects invalid JSON, a wrong version, and a non-object', () => {
    expect(decodeHttpRecord('nope', resolved())).toBeInstanceOf(IdempotencyRecordError);
    expect(decodeHttpRecord(record([]), resolved())).toBeInstanceOf(IdempotencyRecordError);
    expect(decodeHttpRecord(record({ v: 2, s: 200, h: [], b: null }), resolved())).toBeInstanceOf(
      IdempotencyRecordError,
    );
  });

  it('rejects a status outside 200-499 and a non-integer status', () => {
    for (const status of [199, 500, 201.5]) {
      expect(decodeHttpRecord(record({ v: 1, s: status, h: [], b: null }), resolved()))
        .toBeInstanceOf(
          IdempotencyRecordError,
        );
    }
  });

  it('rejects a DENY header and a header no longer on the allow list', () => {
    expect(
      decodeHttpRecord(record({ v: 1, s: 200, h: [['set-cookie', 'x']], b: null }), resolved()),
    ).toBeInstanceOf(IdempotencyRecordError);
    expect(
      decodeHttpRecord(record({ v: 1, s: 200, h: [['x-not-allowed', 'x']], b: null }), resolved()),
    ).toBeInstanceOf(IdempotencyRecordError);
    expect(
      decodeHttpRecord(
        record({ v: 1, s: 200, h: [['content-type', 'a\rb']], b: null }),
        resolved(),
      ),
    ).toBeInstanceOf(IdempotencyRecordError);
  });

  it('rejects a malformed header pair and a non-string body', () => {
    expect(decodeHttpRecord(record({ v: 1, s: 200, h: ['x'], b: null }), resolved()))
      .toBeInstanceOf(
        IdempotencyRecordError,
      );
    expect(decodeHttpRecord(record({ v: 1, s: 200, h: [[1, 2]], b: null }), resolved()))
      .toBeInstanceOf(
        IdempotencyRecordError,
      );
    expect(decodeHttpRecord(record({ v: 1, s: 200, h: [], b: { data: 1 } }), resolved()))
      .toBeInstanceOf(
        IdempotencyRecordError,
      );
    expect(
      decodeHttpRecord(
        record({ v: 1, s: 200, h: [], b: { data: 'x', binary: 'yes' } }),
        resolved(),
      ),
    )
      .toBeInstanceOf(IdempotencyRecordError);
    expect(decodeHttpRecord(record({ v: 1, s: 200, h: [], b: 5 }), resolved())).toBeInstanceOf(
      IdempotencyRecordError,
    );
  });

  it('returns an error, never throws, for a binary body that is not valid base64 (M109a audit F3)', () => {
    // atob throws InvalidCharacterError here; a throw surfaced as a masked
    // 500 instead of the 503 a tampered record answers.
    const tampered = record({ v: 1, s: 200, h: [], b: { data: '!!!notbase64', binary: true } });
    let result: unknown;
    expect(() => {
      result = decodeHttpRecord(tampered, resolved());
    }).not.toThrow();
    expect(result).toBeInstanceOf(IdempotencyRecordError);
    expect((result as Error).message).toBe('stored body is not valid base64');
    // A valid base64 body under the same flag still decodes.
    const valid = record({ v: 1, s: 200, h: [], b: { data: btoa('ok'), binary: true } });
    expect(decodeHttpRecord(valid, resolved())).not.toBeInstanceOf(IdempotencyRecordError);
  });

  it('rejects a decoded body larger than the current maxResponseBytes', () => {
    const encoded = encodeHttpRecord(buffered({ body: 'abcd' }), resolved(), undefined);
    expect(decodeHttpRecord(encoded.record, resolved({ maxResponseBytes: 1 }))).toBeInstanceOf(
      IdempotencyRecordError,
    );
  });
});

describe('replay (M109a §3.10)', () => {
  function recorder() {
    const state = {
      status: 0,
      headers: [] as [string, string][],
      sent: undefined as Uint8Array | undefined,
    };
    const ctx = {
      response: {
        status: (code: number) => {
          state.status = code;
          return ctx.response;
        },
        header: (name: string, value: string) => {
          state.headers.push([name, value]);
          return ctx.response;
        },
        send: (body?: Uint8Array): HandlerResult => {
          state.sent = body;
          return undefined as unknown as HandlerResult;
        },
      },
    } as unknown as IRequestContext;
    return { ctx, state };
  }

  it('writes the status, headers and replay sentinel and sends the body', () => {
    const { ctx, state } = recorder();
    replay(ctx, {
      status: 201,
      headers: [['content-type', 'text/plain']],
      body: new Uint8Array([1, 2]),
    });
    expect(state.status).toBe(201);
    expect(state.headers).toEqual([['content-type', 'text/plain'], [
      'Idempotent-Replayed',
      'true',
    ]]);
    expect(state.sent).toEqual(new Uint8Array([1, 2]));
  });

  it('sends no body for a status-only record', () => {
    const { ctx, state } = recorder();
    replay(ctx, { status: 204, headers: [], body: null });
    expect(state.sent).toBeUndefined();
  });
});
