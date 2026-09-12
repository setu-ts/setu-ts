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
