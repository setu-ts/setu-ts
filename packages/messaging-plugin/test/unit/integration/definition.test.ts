/**
 * `defineIntegrationEvent` — the accepted definition exposes its four fields
 * unchanged, and every §3.2 refusal fires a `TypeError` at definition time
 * naming the offending field (and, for the topic, the expected suffix).
 *
 * The suffix cases are the versioned-rollout policy made mechanical: the
 * `.v10` near-miss exists because a looser check than
 * `topic.endsWith('.v' + version)` accepts it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { defineIntegrationEvent } from '../../../src/integration/definition.ts';
// Declared against the BARREL: dropping the type from `src/index.ts` must
// fail this file's type-check (the M56 defect class).
import type { IntegrationEventDefinition } from '../../../src/index.ts';

interface OrderPlaced {
  orderId: string;
}

function parseOrderPlaced(value: unknown): OrderPlaced {
  return value as OrderPlaced;
}

const VALID = {
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: parseOrderPlaced,
};

describe('defineIntegrationEvent', () => {
  it('exposes the four fields of the accepted definition unchanged', () => {
    const definition: IntegrationEventDefinition<OrderPlaced> = defineIntegrationEvent({
      type: 'orders.placed',
      version: 2,
      topic: 'orders.placed.v2',
      parse: parseOrderPlaced,
    });
    expect(definition.type).toBe('orders.placed');
    expect(definition.version).toBe(2);
    expect(definition.topic).toBe('orders.placed.v2');
    expect(definition.parse).toBe(parseOrderPlaced);
  });

  it('refuses an empty type, naming the field', () => {
    expect(() => defineIntegrationEvent({ ...VALID, type: '' })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, type: '' })).toThrow(/"type"/);
  });

  it('refuses an empty topic, naming the field', () => {
    expect(() => defineIntegrationEvent({ ...VALID, topic: '' })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, topic: '' })).toThrow(/"topic"/);
  });

  it('refuses a version of 0, naming the field', () => {
    expect(() => defineIntegrationEvent({ ...VALID, version: 0 })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: 0 })).toThrow(/"version"/);
  });

  it('refuses a negative version', () => {
    expect(() => defineIntegrationEvent({ ...VALID, version: -1 })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: -1 })).toThrow(/"version"/);
  });

  it('refuses a fractional version', () => {
    expect(() => defineIntegrationEvent({ ...VALID, version: 1.5 })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: 1.5 })).toThrow(/"version"/);
  });

  it('refuses NaN as a version', () => {
    // The M90a NaN-disables-the-check class: NaN would produce a suffix
    // string and compare wrongly afterwards.
    expect(() => defineIntegrationEvent({ ...VALID, version: Number.NaN })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: Number.NaN })).toThrow(/"version"/);
  });

  it('refuses a version beyond the safe-integer range', () => {
    // `Number.MAX_SAFE_INTEGER + 1` is not a safe integer, so its suffix
    // string cannot be trusted to identify a version.
    expect(() => defineIntegrationEvent({ ...VALID, version: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/"version"/);
  });

  it('refuses an absent parse', () => {
    expect(() =>
      defineIntegrationEvent({
        ...VALID,
        parse: undefined as unknown as (value: unknown) => OrderPlaced,
      })
    ).toThrow(TypeError);
    expect(() =>
      defineIntegrationEvent({
        ...VALID,
        parse: undefined as unknown as (value: unknown) => OrderPlaced,
      })
    ).toThrow(/"parse"/);
  });

  it('refuses a topic with no version suffix at all, naming the expected suffix', () => {
    expect(() => defineIntegrationEvent({ ...VALID, topic: 'orders.placed' })).toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, topic: 'orders.placed' })).toThrow(
      /\.v1/,
    );
  });

  it('refuses a topic whose suffix disagrees with the version', () => {
    expect(() => defineIntegrationEvent({ ...VALID, version: 1, topic: 'orders.placed.v2' }))
      .toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: 1, topic: 'orders.placed.v2' }))
      .toThrow(/\.v1/);
  });

  it('refuses the .v10 near-miss for version 1', () => {
    // A suffix check looser than the exact `.v${version}` string accepts this
    // definition and silently couples a v1 consumer to a v10 topic.
    expect(() => defineIntegrationEvent({ ...VALID, version: 1, topic: 'orders.placed.v10' }))
      .toThrow(TypeError);
    expect(() => defineIntegrationEvent({ ...VALID, version: 1, topic: 'orders.placed.v10' }))
      .toThrow(/\.v1/);
  });
});
