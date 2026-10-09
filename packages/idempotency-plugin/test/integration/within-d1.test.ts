/** D1 deferred commits over the adapter's real node:sqlite double. @module */
import { describe, it } from '@std/testing/bdd';
import { afterAll, beforeAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DuplicateKeyError } from '@setu-ts/common';
import type { ITransactionalIdempotencyStore, RegistryFactory } from '@setu-ts/common';
import { D1Adapter } from '@setu-ts/cloudflare-plugin';
import { createDatabaseIdempotencyStore } from '@setu-ts/database-plugin';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { SqliteD1 } from '../../../cloudflare-plugin/test/d1-fakes.ts';
import {
  deferred,
  servicesOf,
  withinApp,
  withinOptions,
  writeBusiness,
} from '../fixtures/within-backends.ts';

describe('within-d1: real SQLite', () => {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const claims = `claims_${suffix}`;
  const business = `business_${suffix}`;
  let d1: SqliteD1;
  let app: ReturnType<typeof withinApp>;
  const raw: unknown[] = [];
  const observedStore: RegistryFactory<ITransactionalIdempotencyStore> = (services) => {
    const store = createDatabaseIdempotencyStore()(services);
    return {
      find: store.find.bind(store),
      purge: store.purge.bind(store),
      verify: store.verify.bind(store),
      run: async (claim, work) => {
        try {
          return await store.run(claim, work);
        } catch (error) {
          raw.push(error);
          throw error;
        }
      },
    };
  };
  beforeAll(async () => {
    d1 = new SqliteD1(
      (await Deno.readTextFile(
        new URL('../../../database-plugin/test/fixtures/idempotency-sqlite.sql', import.meta.url),
      )).replaceAll('setu_idempotency', claims),
      `CREATE TABLE ${business} (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
    );
    app = withinApp(
      new D1Adapter(d1, {
        tables: { Idempotency: { table: claims }, Business: { table: business } },
      }),
      [],
      65_536,
      observedStore,
    );
    await app.start();
  });
  afterAll(async () => {
    await app?.stop();
    await d1?.prepare(`DROP TABLE ${claims}`).run();
    await d1?.prepare(`DROP TABLE ${business}`).run();
  });
  it('commits two creates with business work and replays the result', async () => {
    const { idempotency } = servicesOf(app);
    let calls = 0;
    const work = (uow: IUnitOfWork) => {
      calls++;
      return writeBusiness(uow, 'happy');
    };
    expect(await idempotency.within(withinOptions('happy'), work)).toEqual({
      value: 'happy',
      replayed: false,
    });
    expect(await idempotency.within(withinOptions('happy'), work)).toEqual({
      value: 'happy',
      replayed: true,
    });
    expect(calls).toBe(1);
    expect(d1.dump(business)).toEqual([{ id: 'happy', name: 'happy' }]);
    expect(d1.dump(claims)).toHaveLength(2);
  });
  it('refuses a concurrent duplicate at commit with two outside effects', async () => {
    const { idempotency } = servicesOf(app);
    const before = d1.dump(business).length;
    const both = deferred();
    const release = deferred();
    let calls = 0;
    const adapter = new D1Adapter(d1, {
      tables: { Idempotency: { table: claims }, Business: { table: business } },
    });
    const work = async (uow: IUnitOfWork) => {
      const id = `race-${++calls}`;
      await writeBusiness(uow, id);
      if (calls === 2) both.resolve();
      await release.promise;
      return 'winner';
    };
    const competitor = withinApp(adapter, [], 65_536, observedStore);
    await competitor.start();
    try {
      const pending = Promise.all([
        idempotency.within(withinOptions('race'), work),
        servicesOf(competitor).idempotency.within(withinOptions('race'), work),
      ]);
      await both.promise;
      release.resolve();
      const outcomes = await pending;
      expect(outcomes.map((r) => r.value)).toEqual(['winner', 'winner']);
      expect(outcomes.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(calls).toBe(2);
      expect(d1.dump(business)).toHaveLength(before + 1);
      expect(raw).toHaveLength(1);
      expect(raw[0]).toBeInstanceOf(DuplicateKeyError);
    } finally {
      await competitor.stop();
    }
  });
  it('obligation 8: an expired unpurged key cannot commit twice', async () => {
    const { idempotency, database } = servicesOf(app);
    const options = withinOptions('expired');
    await idempotency.within(options, (uow: IUnitOfWork) => writeBusiness(uow, 'expired-seed'));
    const repo = database.getRepository<Record<string, unknown>>('Idempotency');
    const result = (await repo.findAll()).find((r) => r.result === '{"v":"expired-seed"}')!;
    const id = String(result.id).slice(0, -2);
    await repo.update(id, { expiresAt: 1 });
    await repo.update(`${id}.r`, { expiresAt: 1 });
    const before = d1.dump(business).length;
    let calls = 0;
    const release = deferred();
    const work = async (uow: IUnitOfWork) => {
      const id = `expired-${++calls}`;
      await writeBusiness(uow, id);
      await release.promise;
      return id;
    };
    const pending = Promise.all([
      idempotency.within(options, work),
      idempotency.within(options, work),
    ]);
    const timer = setTimeout(release.resolve, 100);
    try {
      expect(await pending).toEqual([{ value: 'expired-seed', replayed: true }, {
        value: 'expired-seed',
        replayed: true,
      }]);
      expect(calls).toBe(0);
      expect(d1.dump(business)).toHaveLength(before);
      expect((await repo.findById(id))?.expiresAt).toBe(1);
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
  });
});
