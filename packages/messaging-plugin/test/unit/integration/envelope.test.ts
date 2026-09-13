/**
 * `createEnvelope` / `validateEnvelope` — the two directions of the wire
 * shape, asserted field by field.
 *
 * `createFakeRuntime` is given an explicit `startTimestamp`: its default is
 * `Date.now()`, which would make the ISO-8601 assertion non-deterministic
 * (the clock-mixing pitfall in a second guise).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { IntegrationEventRejectedError } from '../../../src/errors.ts';
import { defineIntegrationEvent } from '../../../src/integration/definition.ts';
import { createEnvelope, validateEnvelope } from '../../../src/integration/envelope.ts';
// Declared against the BARREL: dropping the type from `src/index.ts` must
// fail this file's type-check (the M56 defect class).
import type { IntegrationEventEnvelope } from '../../../src/index.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

const FIXED_MS = 1_700_000_000_000;

const definition = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

const VALID_ENVELOPE: IntegrationEventEnvelope<{ orderId: string }> = {
  id: 'e-1',
  type: 'orders.placed',
  version: 1,
  occurredAt: new Date(FIXED_MS).toISOString(),
  data: { orderId: 'o-1' },
};

/** A copy of the valid envelope without one top-level field. */
function without(field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID_ENVELOPE };
  delete copy[field];
  return copy;
}

describe('createEnvelope', () => {
  it('writes exactly the nine documented fields, each from its named source', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'env-uuid', startTimestamp: FIXED_MS });
    const payload = { orderId: 'o-1' };
    const envelope = createEnvelope(runtime, definition, payload, {
      correlationId: 'root-1',
      causationId: 'e-0',
      aggregateId: 'order-1',
      aggregateVersion: 3,
    });
    expect(Object.keys(envelope).sort()).toEqual([
      'aggregateId',
      'aggregateVersion',
      'causationId',
      'correlationId',
      'data',
      'id',
      'occurredAt',
      'type',
      'version',
    ]);
    expect(envelope.id).toBe('env-uuid-0');
    expect(envelope.type).toBe('orders.placed');
    expect(envelope.version).toBe(1);
    expect(envelope.data).toBe(payload);
    expect(envelope.correlationId).toBe('root-1');
    expect(envelope.causationId).toBe('e-0');
    expect(envelope.aggregateId).toBe('order-1');
    expect(envelope.aggregateVersion).toBe(3);
    // `occurredAt` is the runtime's clock as a parseable ISO-8601 instant.
    expect(envelope.occurredAt).toBe(new Date(FIXED_MS).toISOString());
    expect(Number.isNaN(Date.parse(envelope.occurredAt))).toBe(false);
  });

  it('omits every optional field when no metadata is given', () => {
    const envelope = createEnvelope(createFakeRuntime(), definition, { orderId: 'o-1' });
    expect('correlationId' in envelope).toBe(false);
    expect('causationId' in envelope).toBe(false);
    expect('aggregateId' in envelope).toBe(false);
    expect('aggregateVersion' in envelope).toBe(false);
  });

  it('omits exactly the metadata members that are absent, never writing undefined', () => {
    const envelope = createEnvelope(createFakeRuntime(), definition, { orderId: 'o-1' }, {
      correlationId: 'root-1',
    });
    expect(envelope.correlationId).toBe('root-1');
    expect('causationId' in envelope).toBe(false);
    expect('aggregateId' in envelope).toBe(false);
    expect('aggregateVersion' in envelope).toBe(false);
  });
});

describe('validateEnvelope', () => {
  it('accepts a valid envelope with every mandatory field intact', () => {
    const validated = validateEnvelope({ ...VALID_ENVELOPE }, definition);
    expect(validated.id).toBe('e-1');
    expect(validated.type).toBe('orders.placed');
    expect(validated.version).toBe(1);
    expect(validated.occurredAt).toBe(new Date(FIXED_MS).toISOString());
    expect(validated.data).toEqual({ orderId: 'o-1' });
  });

  it('accepts an unknown extra field and it survives onto the validated envelope', () => {
    const value = { ...VALID_ENVELOPE, addedByLaterFrameworkVersion: 42 };
    const validated = validateEnvelope(value, definition);
    expect((validated as unknown as Record<string, unknown>)['addedByLaterFrameworkVersion'])
      .toBe(42);
  });

  it('refuses null, a primitive, and an array as malformed', () => {
    for (const value of [null, 'not-an-envelope', 7, [VALID_ENVELOPE]]) {
      let caught: unknown;
      try {
        validateEnvelope(value, definition);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
      expect((caught as IntegrationEventRejectedError).reason).toBe('malformed');
    }
  });

  it('refuses each missing mandatory field as malformed', () => {
    for (const field of ['id', 'type', 'version', 'occurredAt', 'data']) {
      let caught: unknown;
      try {
        validateEnvelope(without(field), definition);
      } catch (error) {
        caught = error;
      }
      expect(caught, `missing "${field}" must be refused`).toBeInstanceOf(
        IntegrationEventRejectedError,
      );
      expect((caught as IntegrationEventRejectedError).reason).toBe('malformed');
      expect((caught as IntegrationEventRejectedError).message).toContain(`"${field}"`);
    }
  });

  it('refuses each mandatory field of the wrong primitive type as malformed', () => {
    const wrongTypes: Record<string, unknown>[] = [
      { ...VALID_ENVELOPE, id: 42 },
      { ...VALID_ENVELOPE, type: 42 },
      { ...VALID_ENVELOPE, version: '1' },
      { ...VALID_ENVELOPE, occurredAt: 42 },
    ];
    for (const value of wrongTypes) {
      let caught: unknown;
      try {
        validateEnvelope(value, definition);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
      expect((caught as IntegrationEventRejectedError).reason).toBe('malformed');
    }
  });

  it('refuses a mismatched type with reason type-mismatch', () => {
    let caught: unknown;
    try {
      validateEnvelope({ ...VALID_ENVELOPE, type: 'orders.cancelled' }, definition);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    const rejection = caught as IntegrationEventRejectedError;
    expect(rejection.reason).toBe('type-mismatch');
    expect(rejection.expectedType).toBe('orders.placed');
    expect(rejection.expectedVersion).toBe(1);
    expect(rejection.message).toContain('orders.cancelled');
  });

  it('refuses a mismatched version with reason version-mismatch', () => {
    let caught: unknown;
    try {
      validateEnvelope({ ...VALID_ENVELOPE, version: 2 }, definition);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationEventRejectedError);
    const rejection = caught as IntegrationEventRejectedError;
    expect(rejection.reason).toBe('version-mismatch');
    expect(rejection.expectedVersion).toBe(1);
    expect(rejection.message).toContain('2');
  });
});

describe('envelope guards found in review (PR #287)', () => {
  const runtime = createFakeRuntime({ uuidPrefix: 'guard', startTimestamp: FIXED_MS });
  const guarded = defineIntegrationEvent<{ n: number }>({
    type: 't',
    version: 1,
    topic: 't.v1',
    parse: (value) => value as { n: number },
  });
  const base = {
    id: 'i',
    type: 't',
    version: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: { n: 1 },
  };

  // `JSON.stringify` DROPS a key whose value is `undefined`, so an undefined
  // payload published cleanly and then arrived with no `data` at all — every
  // consumer refused it, and on the default composition that refusal is
  // reported and dropped, so the event vanished silently.
  it('refuses an undefined payload at the producer and names the null remedy', () => {
    expect(() => createEnvelope(runtime, guarded, undefined as never))
      .toThrow(TypeError);
    expect(() => createEnvelope(runtime, guarded, undefined as never))
      .toThrow(/must publish `null` instead/);
  });

  it('publishes a null payload, the documented payloadless shape', () => {
    const nullable = defineIntegrationEvent<null>({
      type: 't',
      version: 1,
      topic: 't.v1',
      parse: () => null,
    });
    expect(createEnvelope(runtime, nullable, null).data).toBe(null);
  });

  // A non-finite number serializes to `null`, so the consumer would receive an
  // aggregate version it cannot use while the producer believed it sent one.
  for (const bad of [NaN, Infinity, -Infinity]) {
    it(`refuses a non-finite aggregateVersion (${String(bad)}) at the producer`, () => {
      expect(() => createEnvelope(runtime, guarded, { n: 1 }, { aggregateVersion: bad }))
        .toThrow(/"aggregateVersion" must be a finite number/);
    });
  }

  it('accepts a finite aggregateVersion unchanged', () => {
    expect(createEnvelope(runtime, guarded, { n: 1 }, { aggregateVersion: 0 }).aggregateVersion)
      .toBe(0);
  });

  // `occurredAt` is exposed to application code as an ISO-8601 instant; an
  // arbitrary string made that declared type a lie and produced an Invalid Date.
  // `Date.parse` alone is far weaker than the wire contract: it accepts
  // date-only values, RFC 2822, and — the case that corrupts data — a
  // zone-less timestamp, which every engine reads in its OWN local time.
  // Measured on a +05:30 host, '2026-01-01T00:00:00' became
  // '2025-12-31T18:30:00.000Z', so such an event means a different instant on
  // every consumer.
  for (
    const bad of [
      'not a timestamp',
      '2026-01-01', // date-only: not an instant
      '2026-01-01T00:00:00', // no zone designator: local-time drift
      'Thu, 01 Jan 1970 00:00:00 GMT', // RFC 2822, implementation-defined
      '2026-13-45T00:00:00Z', // well-shaped but an impossible date
    ]
  ) {
    it(`refuses an occurredAt that is not an ISO-8601 instant: ${bad}`, () => {
      expect(() => validateEnvelope({ ...base, occurredAt: bad }, guarded))
        .toThrow(/not an ISO-8601 instant/);
    });
  }

  // The interoperable RFC 3339 profile, so a producer in another language is
  // not refused for emitting a legal instant this framework does not itself
  // emit (no fractional seconds, a numeric offset, lowercase designators).
  for (
    const good of [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00+05:30',
      '2026-01-01t00:00:00z',
    ]
  ) {
    it(`accepts the ISO-8601 instant ${good}`, () => {
      expect(validateEnvelope({ ...base, occurredAt: good }, guarded).occurredAt).toBe(good);
    });
  }

  it('accepts the canonical occurredAt createEnvelope emits', () => {
    const built = createEnvelope(runtime, guarded, { n: 1 });
    expect(validateEnvelope({ ...built }, guarded).occurredAt).toBe(built.occurredAt);
  });

  // The optional causal fields are typed on the envelope and handed to
  // application code — and `causedBy` copies `correlationId` into the NEXT
  // event, so a wrong primitive propagates one hop before anyone sees it.
  for (const field of ['correlationId', 'causationId', 'aggregateId'] as const) {
    it(`refuses a non-string ${field}`, () => {
      expect(() => validateEnvelope({ ...base, [field]: 12345 }, guarded))
        .toThrow(new RegExp(`"${field}" field must be a string`));
    });
  }

  it('refuses a non-finite aggregateVersion on the wire', () => {
    expect(() => validateEnvelope({ ...base, aggregateVersion: 'four' }, guarded))
      .toThrow(/"aggregateVersion" field must be a finite number/);
  });

  it('accepts an envelope carrying every optional field correctly typed', () => {
    const full = {
      ...base,
      correlationId: 'c-1',
      causationId: 'e-1',
      aggregateId: 'a-1',
      aggregateVersion: 3,
    };
    expect(validateEnvelope(full, guarded).correlationId).toBe('c-1');
  });
});
