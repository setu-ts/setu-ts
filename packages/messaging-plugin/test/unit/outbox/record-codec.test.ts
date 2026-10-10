/**
 * Outbox record encode/decode (M107 §3.2, §3.7): the stored options are the
 * EFFECTIVE options, an oversized envelope is refused at write, and every
 * field the relay acts on is re-validated at read — each failure is a named
 * `invalid-row` cause, never a throw.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { spy } from '@std/testing/mock';
import type { OutboxRecord } from '@setu-ts/common';
import {
  MAX_PUBLISH_HEADER_NAME_BYTES,
  MAX_PUBLISH_HEADER_VALUE_BYTES,
  MAX_PUBLISH_HEADERS,
  MAX_PUBLISH_ID_BYTES,
  OUTBOX_RECORD_KIND,
  parsePublishOptions,
} from '@setu-ts/common';

import { OutboxEnvelopeTooLargeError } from '../../../src/outbox/errors.ts';
import {
  claimStateOf,
  decodeOutboxRecord,
  encodeOutboxRecord,
  MAX_CLAIM_HORIZON_MS,
  MAX_STORED_OPTIONS_LENGTH,
} from '../../../src/outbox/record-codec.ts';

const ENVELOPE = {
  id: 'e-1',
  type: 'orders.placed',
  version: 1,
  occurredAt: '2026-01-01T00:00:00.000Z',
  data: { n: 1 },
};

function encode(overrides: Partial<Parameters<typeof encodeOutboxRecord>[0]> = {}): OutboxRecord {
  return encodeOutboxRecord({
    topic: 'orders.placed.v1',
    envelope: ENVELOPE,
    options: Object.freeze({ orderingKey: 'k', deduplicationId: 'e-1', headers: {} }),
    position: 'p',
    createdAt: 42,
    maxEnvelopeBytes: 1024,
    ...overrides,
  });
}

describe('encodeOutboxRecord', () => {
  it('builds a pending record with the effective options and the key column', () => {
    const record = encode({ tenantId: 't', traceparent: 'tp' });
    expect(record).toEqual({
      id: 'e-1',
      kind: OUTBOX_RECORD_KIND,
      topic: 'orders.placed.v1',
      envelope: JSON.stringify(ENVELOPE),
      options: JSON.stringify({ orderingKey: 'k', deduplicationId: 'e-1' }),
      orderingKey: 'k',
      tenantId: 't',
      traceparent: 'tp',
      position: 'p',
      createdAt: 42,
      status: 'pending',
      attempts: 0,
      availableAt: 42,
      claimVersion: 0,
      leaseUntil: 0,
    });
  });

  it('omits absent optionals and keeps caller headers', () => {
    const record = encode({
      options: Object.freeze({ deduplicationId: 'd', headers: { 'x-a': '1' } }),
    });
    expect('orderingKey' in record).toBe(false);
    expect('tenantId' in record).toBe(false);
    expect('traceparent' in record).toBe(false);
    expect(JSON.parse(record.options)).toEqual({ deduplicationId: 'd', headers: { 'x-a': '1' } });
  });

  it('refuses an envelope over maxEnvelopeBytes by UTF-8 bytes', () => {
    const big = { ...ENVELOPE, data: { s: 'é'.repeat(600) } }; // 1200 bytes, 600 chars
    let error: unknown;
    try {
      encode({ envelope: big });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OutboxEnvelopeTooLargeError);
    expect((error as OutboxEnvelopeTooLargeError).limit).toBe(1024);
    expect((error as OutboxEnvelopeTooLargeError).bytes).toBeGreaterThan(1200);
  });
});

describe('claimStateOf', () => {
  const valid = encode();
  it('accepts the exact version and global horizon boundaries', () => {
    expect(claimStateOf(valid, 42)).toEqual({ claimVersion: 0, leaseUntil: 0 });
    expect(
      claimStateOf({
        ...valid,
        claimVersion: Number.MAX_SAFE_INTEGER - 1,
        leaseUntil: 42 + MAX_CLAIM_HORIZON_MS,
      }, 42),
    ).toEqual({
      claimVersion: Number.MAX_SAFE_INTEGER - 1,
      leaseUntil: 42 + MAX_CLAIM_HORIZON_MS,
    });
  });
  for (const field of ['claimVersion', 'leaseUntil'] as const) {
    for (
      const value of [
        undefined,
        null,
        'x',
        -1,
        1.5,
        Number.NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]
    ) {
      it(`refuses ${field}=${String(value)}`, () => {
        expect(claimStateOf({ ...valid, [field]: value } as unknown as OutboxRecord, 42))
          .toBeUndefined();
      });
    }
  }
  it('refuses exhausted versions and leases beyond the horizon', () => {
    expect(claimStateOf({ ...valid, claimVersion: Number.MAX_SAFE_INTEGER }, 42)).toBeUndefined();
    expect(claimStateOf({ ...valid, leaseUntil: 42 + MAX_CLAIM_HORIZON_MS + 1 }, 42))
      .toBeUndefined();
  });
});

describe('decodeOutboxRecord', () => {
  const valid = encode();

  it('decodes a valid row into topic, parsed envelope and validated options', () => {
    const decoded = decodeOutboxRecord(valid, 1024);
    expect(decoded).toEqual({
      ok: true,
      row: {
        topic: 'orders.placed.v1',
        envelope: ENVELOPE,
        options: { orderingKey: 'k', deduplicationId: 'e-1', headers: {} },
      },
    });
  });

  const cases: [string, Partial<OutboxRecord>, string][] = [
    [
      'an oversized envelope',
      { envelope: JSON.stringify({ ...ENVELOPE, pad: 'x'.repeat(2000) }) },
      'envelope-too-large',
    ],
    ['a non-JSON envelope', { envelope: '{nope' }, 'envelope-not-json'],
    ['a non-object envelope', { envelope: '[1]' }, 'envelope-not-json'],
    ['a non-string envelope', { envelope: 7 as unknown as string }, 'envelope-not-json'],
    ['an envelope id differing from the row id', { id: 'e-2' }, 'envelope-id-mismatch'],
    ['options that are not JSON', { options: 'nope' }, 'options-invalid'],
    [
      'options without a deduplication id',
      { options: JSON.stringify({ orderingKey: 'k' }) },
      'options-invalid',
    ],
    [
      'a reserved header',
      {
        options: JSON.stringify({
          orderingKey: 'k',
          deduplicationId: 'd',
          headers: { traceparent: 'x' },
        }),
      },
      'options-invalid',
    ],
    [
      'an options.orderingKey differing from the column',
      { options: JSON.stringify({ orderingKey: 'other', deduplicationId: 'd' }) },
      'ordering-key-mismatch',
    ],
    [
      'a key column with no key in options',
      { options: JSON.stringify({ deduplicationId: 'd' }) },
      'ordering-key-mismatch',
    ],
    ['an empty topic', { topic: '' }, 'topic-invalid'],
    ['a topic over 255 bytes', { topic: 'é'.repeat(128) }, 'topic-invalid'],
    ['a topic with a control character', { topic: 'orders\nplaced.v1' }, 'topic-invalid'],
    ['a topic with a line separator', { topic: 'orders .v1' }, 'topic-invalid'],
    ['a topic with a lone surrogate', { topic: 'a\ud800' }, 'topic-invalid'],
    ['a non-string topic', { topic: 5 as unknown as string }, 'topic-invalid'],
  ];
  for (const [label, change, cause] of cases) {
    it(`refuses ${label} as ${cause}`, () => {
      expect(decodeOutboxRecord({ ...valid, ...change }, 1024)).toEqual({ ok: false, cause });
    });
  }

  it('decodes the largest options the outbox can write, which fit the stored bound', () => {
    // Every M106 bound at its maximum, with values that escape (a `"` costs
    // two code units), so the derived bound is shown to be an upper bound.
    const key = 'k'.repeat(MAX_PUBLISH_ID_BYTES);
    const headers: Record<string, string> = {};
    for (let n = 0; n < MAX_PUBLISH_HEADERS; n++) {
      const name = `x-h${String(n).padStart(2, '0')}`;
      headers[name.padEnd(MAX_PUBLISH_HEADER_NAME_BYTES, 'a')] = '"'.repeat(
        MAX_PUBLISH_HEADER_VALUE_BYTES,
      );
    }
    const options = parsePublishOptions({ orderingKey: key, deduplicationId: key, headers });
    const record = encode({ options });
    expect(record.options.length).toBeLessThanOrEqual(MAX_STORED_OPTIONS_LENGTH);
    const decoded = decodeOutboxRecord(record, 1024);
    expect(decoded.ok).toBe(true);
  });

  it('refuses options over the stored bound before parsing them', () => {
    // VALID options padded with JSON whitespace: a parse would accept them and
    // the row would decode. Only a length check that runs BEFORE the parse
    // refuses them, so this fails if the check moves after it (audit L1).
    const padded = (length: number): string => {
      const head = '{"orderingKey":"k","deduplicationId":"e-1"';
      return head + ' '.repeat(length - head.length - 1) + '}';
    };
    const over = padded(MAX_STORED_OPTIONS_LENGTH + 1);
    expect(JSON.parse(over)).toEqual({ orderingKey: 'k', deduplicationId: 'e-1' });
    // The cost the bound exists to avoid is the parse, so the test watches it:
    // the cause alone is the same wherever the check sits.
    const parse = spy(JSON, 'parse');
    let result: ReturnType<typeof decodeOutboxRecord>;
    try {
      result = decodeOutboxRecord({ ...valid, options: over }, 1024);
    } finally {
      parse.restore();
    }
    expect(result).toEqual({ ok: false, cause: 'options-too-large' });
    expect(parse.calls.filter((call) => call.args[0] === over)).toEqual([]);
    // At the bound the same text is parsed and decodes: the bound is exact.
    const at = padded(MAX_STORED_OPTIONS_LENGTH);
    expect(at.length).toBe(MAX_STORED_OPTIONS_LENGTH);
    expect(decodeOutboxRecord({ ...valid, options: at }, 1024).ok).toBe(true);
  });

  it('accepts a 255-byte topic', () => {
    const decoded = decodeOutboxRecord({ ...valid, topic: 't'.repeat(255) }, 1024);
    expect(decoded.ok).toBe(true);
  });
});
