/**
 * The shared inbound-header normalizer.
 *
 * `MessageMetadata.headers` is declared `Readonly<Record<string, string>>` and
 * M75 documents it as populated by every first-party broker. AMQP field tables,
 * Service Bus application properties and kafkajs `IHeaders` all deliver values
 * that are not strings, so each arm is pinned here rather than left to an
 * assertion at the call site.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { normalizeTransportHeaders } from '../../src/brokers/header-normalize.ts';

describe('normalizeTransportHeaders', () => {
  it('returns an empty record when the transport carried no headers', () => {
    expect(normalizeTransportHeaders(undefined)).toEqual({});
  });

  it('passes a string value through unchanged', () => {
    expect(normalizeTransportHeaders({ traceparent: '00-abc-def-01' })).toEqual({
      traceparent: '00-abc-def-01',
    });
  });

  it('decodes a byte value as UTF-8, which is how amqplib and kafkajs deliver', () => {
    const bytes = new TextEncoder().encode('00-abc-def-01');
    expect(normalizeTransportHeaders({ traceparent: bytes })).toEqual({
      traceparent: '00-abc-def-01',
    });
  });

  it('stringifies finite numbers and booleans', () => {
    expect(normalizeTransportHeaders({ retries: 3, negative: -1, replay: false })).toEqual({
      retries: '3',
      negative: '-1',
      replay: 'false',
    });
  });

  it('renders a Date as ISO-8601, the form Service Bus round-trips', () => {
    expect(normalizeTransportHeaders({ enqueued: new Date(0) })).toEqual({
      enqueued: '1970-01-01T00:00:00.000Z',
    });
  });

  it('takes the first element of a repeated header, matching Headers.get', () => {
    expect(normalizeTransportHeaders({ traceparent: ['first', 'second'] })).toEqual({
      traceparent: 'first',
    });
    // The array arm decodes too — kafkajs permits `Buffer[]`.
    expect(normalizeTransportHeaders({ b: [new TextEncoder().encode('bytes')] })).toEqual({
      b: 'bytes',
    });
  });

  it('DROPS a value with no faithful string form rather than corrupting it', () => {
    // `[object Object]` and `"NaN"` read as real header values to a subscriber;
    // an absent key reads as absent, which is the truth.
    const result = normalizeTransportHeaders({
      nested: { a: 1 },
      empty: null,
      missing: undefined,
      notANumber: Number.NaN,
      unbounded: Number.POSITIVE_INFINITY,
      invalidDate: new Date('nonsense'),
      emptyArray: [],
      arrayOfTables: [{ a: 1 }],
    });
    expect(result).toEqual({});
  });

  it('keeps the sound keys when only some values are undecodable', () => {
    expect(normalizeTransportHeaders({ traceparent: '00-abc', nested: { a: 1 } })).toEqual({
      traceparent: '00-abc',
    });
  });
});
