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
/**
 * Whether the real-server cases run. They are declared with the BDD `ignore`
 * option rather than an early `return`, so an unset `MONGODB_URI` is reported
 * as **ignored** instead of as a passing test that exercised nothing — the
 * distinction CI depends on (M37's exit-77 rule in test form).
 */
const skipReal = mongoUrl === undefined;
/** The URL, narrowed for the guarded bodies; unused when `skipReal`. */
const url = mongoUrl ?? '';
/** Transactions need a replica set; a standalone `mongod` refuses them. */
const skipTx = skipReal || !url.includes('replicaSet=');

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
  it('lazily imports the driver and reads CRUD operations back through IDataSource', {
    ignore: skipReal,
  }, async () => {
    const collection = `m78_widgets_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url,
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

  it('serves a numeric primary key through every IDataSource entry point', {
    ignore: skipReal,
  }, async () => {
    // The default `'auto'` mapping converted through `ObjectId.isValid`, which
    // the real driver answers `true` for on any number while its constructor
    // rejects one — so a collection keyed by application-assigned numbers threw
    // `BSONError` on create, findById, findAll, count and delete alike. Only a
    // real driver shows it: the structural double's `isValid` cannot.
    const collection = `m78_numeric_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url,
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

  it('serves the shapes a fake cannot prove: empty groups, `_id` as the key, pk in update', {
    ignore: skipReal,
  }, async () => {
    const collection = `m78_shapes_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m78',
      collections: { Widget: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Widget');
      await source.create({ id: 1, name: 'one' });
      await source.create({ id: 2, name: 'two' });

      // An empty group is a legal `FilterExpression`. Emitted verbatim the
      // server refuses it outright ("$and argument must be a non-empty
      // array"), so it compiles to its boolean identity instead.
      await expect(source.findAll(query({ filter: { type: 'and', filters: [] } })))
        .resolves.toHaveLength(2);
      await expect(source.findAll(query({ filter: { type: 'or', filters: [] } })))
        .resolves.toHaveLength(0);
      // …and composed with an equality half, which is the other emitted shape.
      await expect(
        source.findAll(query({ where: { id: 1 }, filter: { type: 'and', filters: [] } })),
      ).resolves.toHaveLength(1);
      await expect(source.count({}, { type: 'or', filters: [] })).resolves.toBe(0);

      // The server rejects a `$set` that would change `_id`, so the primary key
      // must never reach the update payload.
      await expect(source.update(1, { id: 99, name: 'renamed' })).resolves.toEqual({
        id: 1,
        name: 'renamed',
      });
      await expect(source.findById(1)).resolves.toEqual({ id: 1, name: 'renamed' });
    } finally {
      await adapter.disconnect();
    }
  });

  it('round-trips a collection whose primary key IS `_id`', { ignore: skipReal }, async () => {
    const collection = `m78_native_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m78',
      collections: { Widget: { collection, primaryKey: '_id', idType: 'raw' } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Widget');
      // Mapping the key onto the driver's own field name wrote it and then
      // deleted it — on read the row lost its key, and on write the caller's
      // key was dropped so the server generated a different one.
      const created = await source.create({ _id: 42, name: 'native' });
      expect(created).toEqual({ _id: 42, name: 'native' });
      await expect(source.findById(42)).resolves.toEqual({ _id: 42, name: 'native' });
      await expect(source.delete(42)).resolves.toBe(true);
    } finally {
      await adapter.disconnect();
    }
  });

  it('commits and rolls back a real session transaction (replica set only)', {
    ignore: skipTx,
  }, async () => {
    // Transactions were proven by a fake whose session is inert, so neither
    // commit nor rollback was ever observed against a server. A standalone
    // `mongod` refuses `startTransaction` by design, so this case is guarded on
    // the deployment rather than only on the URL — CI's Mongo service is
    // standalone, while a `?replicaSet=` deployment runs it for real.
    const collection = `m78_tx_${crypto.randomUUID().replaceAll('-', '')}`;
    const adapter = new MongoAdapter({
      url,
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
