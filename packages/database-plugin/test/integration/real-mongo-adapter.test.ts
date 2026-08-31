/**
 * Real-driver exercise for the Mongo adapter.
 *
 * This is intentionally guarded for local development and enabled by the CI
 * Mongo service. It drives the lazy import path and reads each write back
 * through the public adapter contract, which a structural double cannot prove.
 *
 * M79 §6.1 added the behavioural commit of the §1A probes: flat and compound
 * composite keys with the P4/P5 order-sensitivity guard, the dotted nested
 * path (P8), the `Date` range (P9), the tied-fixture cursor walk (P10/P11)
 * and the P11 negative control. §1B carries the container command (a
 * single-node replica set — the transaction case below needs it).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MongoAdapter } from '../../src/adapters/mongo/mongo-adapter.ts';
import type { FilterExpression, NormalizedQuery } from '@setu-ts/common';

/** `MONGO_URL` is the §7 gate variable; `MONGODB_URI` is the CI's name. */
const mongoUrl = Deno.env.get('MONGO_URL') ?? Deno.env.get('MONGODB_URI');
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
    ...(partial.cursor === undefined ? {} : { cursor: partial.cursor }),
  };
}

/** A per-run discriminator keeping this run's documents from any other's. */
const suffix = crypto.randomUUID().replaceAll('-', '');

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

  // ---------------------------------------------------------------------------
  // M79 §6.1 — the §1A probes committed as behaviour against the real server.
  // ---------------------------------------------------------------------------

  it('round-trips a flat composite key regardless of caller key-object order (P3)', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_flat_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Grant: { collection, primaryKey: ['tenantId', 'userId'] } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Grant');
      // A flat composite stores each named column as a top-level field — the
      // row reads back without the driver's `_id` at all.
      const created = await source.create({ tenantId: 'acme', userId: 'u1', role: 'admin' });
      expect(created).toEqual({ tenantId: 'acme', userId: 'u1', role: 'admin' });

      // Canonical key order…
      await expect(source.findById({ tenantId: 'acme', userId: 'u1' })).resolves.toEqual(created);
      // …and the REVERSED caller object: a flat composite filter is a field
      // map, so it is order-independent (P3 measured Prisma the same way —
      // the two backends agree here and disagree on compound `_id` below).
      await expect(source.findById({ userId: 'u1', tenantId: 'acme' })).resolves.toEqual(
        created,
      );

      // update returns the updated row; delete reports true.
      const updated = await source.update({ userId: 'u1', tenantId: 'acme' }, { role: 'owner' });
      expect(updated).toEqual({ tenantId: 'acme', userId: 'u1', role: 'owner' });
      await expect(source.delete({ tenantId: 'acme', userId: 'u1' })).resolves.toBe(true);
      await expect(source.findById({ tenantId: 'acme', userId: 'u1' })).resolves.toBeNull();
    } finally {
      await adapter.disconnect();
    }
  });

  it('round-trips a compound-`_id` collection and matches a REVERSE-order key (P4/P5)', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_compound_${suffix}`;
    // A second, raw client drives the order-sensitivity probe directly against
    // the server; the driver import stays inside the guarded body.
    const { MongoClient } = await import('mongodb');
    const raw = new MongoClient(url);
    await raw.connect();
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: {
        Grant: { collection, primaryKey: ['tenantId', 'userId'], idType: 'compound' },
      },
    });

    try {
      // Inside the try: the `finally` below owns the raw client, so a throwing
      // connect() must not escape before it can close it.
      await adapter.connect();
      const source = adapter.createDataSource('Grant');
      const created = await source.create({ tenantId: 'acme', userId: 'u1', role: 'admin' });
      expect(created).toEqual({ tenantId: 'acme', userId: 'u1', role: 'admin' });

      // THE ORDER-SENSITIVITY GUARD (P4) — no fake can produce it. The raw
      // driver treats `_id` subdocument equality LITERALLY: the row is there,
      // its `_id` carries the mapping's declared order, and the same key
      // written in the reverse property order MISSES.
      const handle = raw.db('setu_m79').collection(collection);
      const stored = await handle.findOne({ role: 'admin' });
      expect(stored?._id).toEqual({ tenantId: 'acme', userId: 'u1' });
      await expect(
        handle.findOne({ _id: { userId: 'u1', tenantId: 'acme' } }),
      ).resolves.toBeNull();
      // The adapter's REVERSE-order caller key still matches (P5): the
      // adapter rebuilds the subdocument in the MAPPING's declared order,
      // never the caller's — the reason the `'compound'` arm is safe to ship.
      await expect(source.findById({ userId: 'u1', tenantId: 'acme' })).resolves.toEqual(
        created,
      );

      // update returns the updated row; delete reports true — both through
      // the same imposed-order key builder.
      const updated = await source.update({ userId: 'u1', tenantId: 'acme' }, { role: 'owner' });
      expect(updated).toEqual({ tenantId: 'acme', userId: 'u1', role: 'owner' });
      await expect(source.delete({ userId: 'u1', tenantId: 'acme' })).resolves.toBe(true);
      await expect(source.findById({ tenantId: 'acme', userId: 'u1' })).resolves.toBeNull();
    } finally {
      await adapter.disconnect();
      await raw.close();
    }
  });

  it('matches a dotted nested-path filter against a real subdocument (P8)', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_nested_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Profile: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Profile');
      const run = `n-${suffix}`;
      const cities = ['Kolkata', 'Kolkata', 'Kolkata', 'Mumbai'];
      for (const [i, city] of cities.entries()) {
        await source.create({
          id: `${run}-${i + 1}`,
          run,
          profile: { address: { city } },
        });
      }

      // P8: the two-segment path joins to Mongo's native dotted key and
      // matches exactly the three Kolkata subdocuments.
      const found = await source.findAll(query({
        where: { run },
        filter: {
          type: 'comparison',
          field: ['profile', 'address', 'city'],
          operator: 'eq',
          value: 'Kolkata',
        },
      }));
      expect(found.map((row) => row.id).sort()).toEqual([
        `${run}-1`,
        `${run}-2`,
        `${run}-3`,
      ]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('filters a Date range over real BSON dates (P9)', { ignore: skipReal }, async () => {
    const collection = `m79_dates_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Event: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Event');
      const run = `d-${suffix}`;
      const times = [
        new Date('2026-03-01T00:00:00Z'),
        new Date('2026-03-02T00:00:00Z'),
        new Date('2026-03-03T00:00:00Z'),
      ];
      for (const [i, createdAt] of times.entries()) {
        await source.create({ id: `${run}-${i + 1}`, run, createdAt });
      }

      // P9: a `Date` reaches the driver natively — `gte` from day two…
      const from = await source.findAll(query({
        where: { run },
        filter: {
          type: 'comparison',
          field: 'createdAt',
          operator: 'gte',
          value: new Date('2026-03-02T00:00:00Z'),
        },
      }));
      expect(from.map((row) => row.id).sort()).toEqual([`${run}-2`, `${run}-3`]);

      // …and strictly before day two.
      const before = await source.findAll(query({
        where: { run },
        filter: {
          type: 'comparison',
          field: 'createdAt',
          operator: 'lt',
          value: new Date('2026-03-02T00:00:00Z'),
        },
      }));
      expect(before.map((row) => row.id)).toEqual([`${run}-1`]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('walks a tied fixture across three pages returning every row exactly once (P10/P11)', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_walk_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Walk: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Walk');
      const run = `w-${suffix}`;
      // The P11 fixture shape: six rows over only TWO distinct sort values.
      // The original P10 walk seeded distinct values, so the tiebreaker branch
      // never executed and the test would have passed against a builder that
      // omitted it entirely — the ties are deliberate. The sort key is the
      // numeric `score` (the P10 shape with a JSON-round-trip-stable value).
      const scores = [30, 30, 30, 10, 10, 10];
      const ids = scores.map((_, i) => `r${i + 1}-${suffix}`);
      for (const [i, score] of scores.entries()) {
        await source.create({ id: ids[i], run, score });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (let page = 0; page < 10; page++) {
        const result = await source.findPage!(query({
          where: { run },
          orderBy: { score: 'desc' },
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        }));
        pages += 1;
        seen.push(...result.rows.map((row) => String(row.id)));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      // Every row exactly once: no duplicates, none skipped — 6 rows at limit
      // 2 is exactly 3 pages, and the last reports a null cursor.
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(6);
      expect(pages).toBe(3);
    } finally {
      await adapter.disconnect();
    }
  });

  it('walks tied BSON Date values across three pages without losing rows', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_date_walk_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Walk: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Walk');
      const run = `dw-${suffix}`;
      const createdAt = [
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-05-01T00:00:00Z'),
      ];
      const ids = createdAt.map((_, i) => `date-${i + 1}-${suffix}`);
      for (const [i, value] of createdAt.entries()) {
        await source.create({ id: ids[i], run, createdAt: value });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (let page = 0; page < 10; page++) {
        const result = await source.findPage!(query({
          where: { run },
          orderBy: { createdAt: 'desc' },
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        }));
        pages += 1;
        seen.push(...result.rows.map((row) => String(row.id)));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      expect([...seen].sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(6);
      expect(pages).toBe(3);
    } finally {
      await adapter.disconnect();
    }
  });

  it('LOSES rows on the tied fixture when the key tiebreaker is omitted (P11 negative control)', {
    ignore: skipReal,
  }, async () => {
    const collection = `m79_naive_${suffix}`;
    const adapter = new MongoAdapter({
      url,
      database: 'setu_m79',
      collections: { Walk: { collection } },
    });

    await adapter.connect();
    try {
      const source = adapter.createDataSource('Walk');
      const run = `x-${suffix}`;
      const scores = [30, 30, 30, 10, 10, 10];
      const ids = scores.map((_, i) => `x${i + 1}-${suffix}`);
      for (const [i, score] of scores.entries()) {
        await source.create({ id: ids[i], run, score });
      }

      // The naive walk a builder WITHOUT the key appendix would produce: one
      // `score < cursor` comparison per page, no key tiebreaker. P11's poison
      // is silence — the walk must complete without error AND lose rows,
      // asserted as a loss so a future change that makes the naive walk
      // correct by accident fails here.
      const seen: string[] = [];
      let cursorScore: number | null = null;
      for (let page = 0; page < 10; page++) {
        const found = await source.findAll(query({
          where: { run },
          orderBy: { score: 'desc' },
          limit: 2,
          ...(cursorScore === null ? {} : {
            filter: {
              type: 'comparison',
              field: 'score',
              operator: 'lt',
              value: cursorScore,
            } as FilterExpression,
          }),
        }));
        if (found.length === 0) break;
        seen.push(...found.map((row) => String(row.id)));
        cursorScore = found[found.length - 1].score as number;
      }

      // Three rows share the high score: page one takes two of them and
      // `score < 30` then hides the third forever. Page two takes two of the
      // three low rows, and `score < 10` hides the last one. Four seen, two
      // lost — one from each tie group.
      expect(seen.length).toBe(4);
      expect(new Set(seen).size).toBe(4);
      expect(ids.filter((id) => !seen.includes(id)).length).toBe(2);
    } finally {
      await adapter.disconnect();
    }
  });
});
