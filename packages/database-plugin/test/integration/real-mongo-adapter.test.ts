/**
 * Real-driver exercise for the Mongo adapter.
 *
 * This is intentionally guarded for local development and enabled by the CI
 * Mongo service. It drives the lazy import path and reads each write back
 * through the public adapter contract, which a structural double cannot prove.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';
import type { NormalizedQuery } from '@setu-ts/common';

const mongoUrl = Deno.env.get('MONGODB_URI');

function query(partial: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    where: partial.where ?? {},
    orderBy: partial.orderBy ?? {},
    limit: partial.limit ?? -1,
    offset: partial.offset ?? 0,
    select: partial.select ?? [],
    ...(partial.filter === undefined ? {} : { filter: partial.filter }),
  };
}

describe('MongoAdapter against a real MongoDB server (guarded)', () => {
  it('lazily imports the driver and reads CRUD operations back through IDataSource', async () => {
    if (mongoUrl === undefined) return;

    const collection = `m78_widgets_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url: mongoUrl,
      database: 'setu_m78',
      collections: { Widget: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Widget');
      const created = await source.create({ name: 'Bolt', size: 10 });
      expect(typeof created.id).toBe('string');
      await expect(source.findById(String(created.id))).resolves.toEqual(created);
      await expect(source.findAll(query({ where: { id: created.id } }))).resolves.toEqual([
        created,
      ]);
      await expect(source.findAll(query({
        filter: { type: 'comparison', field: 'id', operator: 'eq', value: created.id },
      }))).resolves.toEqual([created]);
      await expect(source.count({ id: created.id })).resolves.toBe(1);

      const updated = await source.update(String(created.id), { size: 20 });
      expect(updated).toEqual({ ...created, size: 20 });
      await expect(source.count(
        {},
        { type: 'comparison', field: 'size', operator: 'gte', value: 20 },
      )).resolves.toBe(1);

      const selected = await source.findAll(query({ select: ['name'] }));
      expect(selected).toEqual([{ name: 'Bolt' }]);
      await expect(source.delete(String(created.id))).resolves.toBe(true);
      await expect(source.findById(String(created.id))).resolves.toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it('serves a numeric primary key through every IDataSource entry point', async () => {
    if (mongoUrl === undefined) return;

    // The default `'auto'` mapping converted through `ObjectId.isValid`, which
    // the real driver answers `true` for on any number while its constructor
    // rejects one — so a collection keyed by application-assigned numbers threw
    // `BSONError` on create, findById, findAll, count and delete alike. Only a
    // real driver shows it: the structural double's `isValid` cannot.
    const collection = `m78_numeric_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url: mongoUrl,
      database: 'setu_m78',
      collections: { Widget: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Widget');
      const created = await source.create({ id: 7, name: 'numeric' });
      // The key keeps its own type, so the value `create()` returned is the
      // value `findById` accepts — the round trip a stringified key broke.
      expect(created).toEqual({ id: 7, name: 'numeric' });
      await expect(source.findById(created.id as number)).resolves.toEqual(created);
      await expect(source.findById(7)).resolves.toEqual({ id: 7, name: 'numeric' });
      await expect(source.findAll(query({ where: { id: 7 } }))).resolves.toEqual([
        { id: 7, name: 'numeric' },
      ]);
      await expect(source.count({ id: 7 })).resolves.toBe(1);
      await expect(source.update(7, { name: 'renamed' })).resolves.toEqual({
        id: 7,
        name: 'renamed',
      });
      await expect(source.delete(7)).resolves.toBe(true);
    } finally {
      await adapter.disconnect();
    }
  });

  it('commits and rolls back a real session transaction (replica set only)', async () => {
    // Transactions were proven by a fake whose session is inert, so neither
    // commit nor rollback was ever observed against a server. A standalone
    // `mongod` refuses `startTransaction` by design, so this case is guarded on
    // the deployment rather than only on the URL — CI's Mongo service is
    // standalone, while a `?replicaSet=` deployment runs it for real.
    if (mongoUrl === undefined || !mongoUrl.includes('replicaSet=')) return;

    const collection = `m78_tx_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url: mongoUrl,
      database: 'setu_m78',
      collections: { Widget: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Widget');

      const committed = await adapter.beginTransaction();
      await committed.createDataSource('Widget').create({ name: 'committed' });
      await committed.commit();
      expect((await source.findAll(query())).map((row) => row.name)).toEqual(['committed']);

      const abandoned = await adapter.beginTransaction();
      await abandoned.createDataSource('Widget').create({ name: 'rolled-back' });
      await abandoned.rollback();
      // The rolled-back write must be absent — the assertion a fake cannot make.
      expect((await source.findAll(query())).map((row) => row.name)).toEqual(['committed']);
    } finally {
      await adapter.disconnect();
    }
  });
});
