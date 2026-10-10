import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { OutboxService } from '../../src/outbox/outbox-service.ts';
import { resolveOutboxOptions } from '../../src/outbox/options.ts';
import {
  countingObserver,
  edit,
  FakeOutboxBroker,
  FaultStore,
  orderPlaced,
  outboxClock,
  outboxHarness,
  row,
  WALL_START,
} from './outbox.ts';

/** A fresh backend for the portable relay proofs. */
export interface RelayProofBackend {
  readonly db: IDatabaseService;
  readonly store: FaultStore;
  readonly dispose: () => Promise<void>;
}

/** Registers the same fencing, contention and numeric-boundary proofs on each backend. */
export function describeOutboxRelayProofs(
  name: string,
  build: () => Promise<RelayProofBackend>,
  ignore = false,
): void {
  describe(`outbox fencing — ${name}`, { ignore }, () => {
    it('a paused relay is fenced after a real claim and another relay settles the row', async () => {
      const backend = await build();
      try {
        await backend.store.verify();
        const observer = countingObserver();
        const a = await outboxHarness({ shared: backend, observer });
        const b = await outboxHarness({
          shared: { db: backend.db, store: new FaultStore(backend.store.inner) },
          clock: outboxClock(10000),
        });
        const id = await a.write({ n: 1 }, { tenantId: 't1' });
        a.store.claim = async (key, update) => {
          const answer = await a.store.inner.claim(key, update);
          a.clock.setWall(update.leaseUntil + 5000);
          b.clock.setWall(update.leaseUntil + 5000);
          await b.sweep();
          return answer;
        };
        await a.sweep();
        expect(a.broker.calls).toEqual([]);
        expect(a.store.count('markSent')).toBe(0);
        expect(a.store.count('markFailure')).toBe(0);
        expect(b.broker.sequence()).toEqual([1]);
        expect(await row(backend.db, id)).toMatchObject({ status: 'sent', claimVersion: 2 });
        expect(observer.counts['overlap-fenced']).toBe(1);
      } finally {
        await backend.dispose();
      }
    });

    it('four real-runtime relays drain 200 rows once each in per-key first-publish order', async () => {
      const backend = await build();
      try {
        await backend.store.verify();
        const runtime = createDenoRuntimeServices();
        const broker = new FakeOutboxBroker();
        broker.behaviour = async () => {
          await new Promise<void>((resolve) => runtime.setTimeout(resolve, 0));
        };
        let lostClaims = 0;
        let claims = 0;
        const claim = backend.store.claim.bind(backend.store);
        backend.store.claim = async (id, update) => {
          claims++;
          const answer = await claim(id, update);
          if (answer.outcome === 'claim-lost') lostClaims++;
          return answer;
        };
        const services = Array.from({ length: 4 }, () => {
          const service = new OutboxService({
            runtime,
            broker,
            options: resolveOutboxOptions({ store: backend.store, relay: { schedule: false } }),
          });
          service.activate({ kind: 'single', store: backend.store });
          return service;
        });
        for (let n = 0; n < 200; n++) {
          await backend.db.transaction((uow) =>
            services[0]!.write(uow, orderPlaced, { key: `K${n % 10}`, n }, { tenantId: 't1' })
          );
        }
        for (let round = 0; round < 40 && (await backend.store.stats()).pending > 0; round++) {
          await Promise.all(services.map((service) => service.sweep()));
        }
        expect(await backend.store.stats()).toMatchObject({ pending: 0, failed: 0 });
        expect(broker.published).toHaveLength(200);
        expect(new Set(broker.published.map((p) => p.message.id)).size).toBe(200);
        for (let k = 0; k < 10; k++) {
          expect(
            broker.published.filter((p) => p.options?.orderingKey === `K${k}`)
              .map((p) => (p.message.data as { n: number }).n),
          )
            .toEqual(Array.from({ length: 20 }, (_, index) => k + index * 10));
        }
        expect(claims).toBeGreaterThanOrEqual(200);
        // The ratio is test evidence, deliberately absent from shipped metrics.
        Deno.stdout.writeSync(
          new TextEncoder().encode(
            `${name}: claims=${claims}, lost=${lostClaims}, lost/claims=${lostClaims / claims}\n`,
          ),
        );
      } finally {
        await backend.dispose();
      }
    });

    it('claims past int32 and up to the exact safe maximum', async () => {
      const backend = await build();
      try {
        const h = await outboxHarness({ shared: backend });
        for (const version of [2_147_483_647, Number.MAX_SAFE_INTEGER - 1]) {
          const id = await h.write({ n: 1 }, { tenantId: 't1' });
          await edit(backend.db, id, { claimVersion: version });
          expect(
            await backend.store.claim(id, {
              claimVersion: version,
              leaseUntil: WALL_START + 30000,
            }),
          )
            .toEqual({ outcome: 'applied' });
          expect(await row(backend.db, id)).toMatchObject({
            claimVersion: version + 1,
            leaseUntil: WALL_START + 30000,
          });
          // Equality must match the stored double on MongoDB as well as the SQL bigint.
          expect(
            await backend.store.markSent(id, {
              claimVersion: version + 1,
              settledAt: WALL_START,
              sentBy: 'proof/scheduled',
              deleteNow: false,
            }),
          ).toEqual({ outcome: 'applied' });
          expect((await row(backend.db, id))!.status).toBe('sent');
        }
      } finally {
        await backend.dispose();
      }
    });
  });
}
