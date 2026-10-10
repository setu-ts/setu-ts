import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FakeOutboxBroker, outboxClock, outboxHarness } from '../../fixtures/outbox.ts';

describe('four relay sweeps over one outbox', () => {
  it('publishes each id once and keeps first-publish order for all ten keys', async () => {
    const broker = new FakeOutboxBroker();
    broker.behaviour = async () => {
      await Promise.resolve();
    };
    const first = await outboxHarness({ broker });
    for (let n = 0; n < 200; n++) await first.write({ key: `K${n % 10}`, n });
    let lost = 0;
    const claim = first.store.claim.bind(first.store);
    first.store.claim = async (id, update) => {
      const result = await claim(id, update);
      if (result.outcome === 'claim-lost') lost++;
      return result;
    };
    const relays = [first];
    for (let i = 1; i < 4; i++) {
      relays.push(
        await outboxHarness({
          shared: { db: first.db, store: first.store },
          broker,
          clock: outboxClock(i * 10000),
        }),
      );
    }
    for (let lap = 0; lap < 20 && (await first.store.stats()).pending > 0; lap++) {
      await Promise.all(relays.map((h) => h.sweep()));
    }
    expect(await first.store.stats()).toMatchObject({ pending: 0, failed: 0 });
    expect(broker.published).toHaveLength(200);
    expect(new Set(broker.published.map((p) => p.message.id)).size).toBe(200);
    for (let k = 0; k < 10; k++) {
      expect(
        broker.published.filter((p) => p.options?.orderingKey === `K${k}`)
          .map((p) => (p.message.data as { n: number }).n),
      )
        .toEqual(Array.from({ length: 20 }, (_, index) => k + index * 10));
    }
    expect(lost).toBeGreaterThan(0);
  });
});
