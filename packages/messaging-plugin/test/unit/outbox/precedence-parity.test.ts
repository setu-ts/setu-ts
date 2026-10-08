/**
 * One precedence rule, two entry points (M107 §3.5): under a NON-default
 * caller `deduplicationId`, a non-default selector and caller headers,
 * `publishIntegrationEvent` and `write` + `sweep` hand the broker identical
 * topic, envelope and options.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { defineIntegrationEvent } from '../../../src/integration/definition.ts';
import { publishIntegrationEvent } from '../../../src/integration/publish.ts';
import type { OutboxWriteInput } from '../../../src/interfaces/index.ts';
import { FakeOutboxBroker, outboxClock, outboxHarness } from '../../fixtures/outbox.ts';

interface Shipped {
  readonly shipmentId: string;
  readonly region: string;
}

/** A non-default selector: keys by region, not by the aggregate id. */
const shipped = defineIntegrationEvent<Shipped>({
  type: 'orders.shipped',
  version: 2,
  topic: 'orders.shipped.v2',
  parse: (value) => value as Shipped,
  orderingKey: (envelope) => `region-${envelope.data.region}`,
});

/** Drives both entry points with the same input; returns what each broker saw. */
async function bothPaths(input: OutboxWriteInput) {
  // Two clocks starting identically, so both envelopes get the same id and
  // time. The outbox service takes one uuid for its instance id at
  // construction; the direct runtime skips one to match.
  const direct = new FakeOutboxBroker();
  const runtime = outboxClock().runtime;
  runtime.uuid();
  await publishIntegrationEvent(
    runtime,
    direct,
    shipped,
    { shipmentId: 's-1', region: 'eu' },
    input.metadata,
    input.options,
  );
  const h = await outboxHarness({ clock: outboxClock() });
  await h.db.transaction((uow) =>
    h.service.write(uow, shipped, { shipmentId: 's-1', region: 'eu' }, input)
  );
  await h.sweep();
  return { direct: direct.published, outbox: h.broker.published };
}

describe('precedence parity between publishIntegrationEvent and the outbox', () => {
  it('a caller deduplicationId and headers, with the selector choosing the key', async () => {
    const { direct, outbox } = await bothPaths({
      metadata: { aggregateId: 's-1', correlationId: 'corr-1' },
      options: { deduplicationId: 'caller-dedup-7', headers: { 'x-origin': 'svc-a' } },
    });
    expect(direct).toHaveLength(1);
    expect(outbox).toEqual(direct);
    expect(outbox[0]!.options).toEqual({
      orderingKey: 'region-eu',
      deduplicationId: 'caller-dedup-7',
      headers: { 'x-origin': 'svc-a' },
    });
  });

  it('a caller orderingKey beats the selector; the dedup id defaults to the envelope id', async () => {
    const { direct, outbox } = await bothPaths({ options: { orderingKey: 'caller-key' } });
    expect(outbox).toEqual(direct);
    expect(outbox[0]!.options).toEqual({
      orderingKey: 'caller-key',
      deduplicationId: outbox[0]!.message.id,
      headers: {},
    });
  });
});
