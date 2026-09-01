/**
 * Real-emulator exercise for the Bigtable adapter.
 *
 * Guarded on `BIGTABLE_EMULATOR_ENDPOINT` and declared with the BDD `ignore`
 * option rather than an early `return`, so an unset variable is reported as
 * **ignored** instead of as a passing test that exercised nothing (the M70c
 * trap, in test form).
 *
 * This is the only place the milestone's measured facts are proven against the
 * service rather than against a double: the lazy `npm:@google-cloud/bigtable`
 * import, the exclusive range boundary the SDK's shorthand gets wrong, the
 * byte-exact value filter that a regex would over-match, the `condition`
 * wrapper that returns a whole row where a bare chain returns one cell, the
 * conditional writes that make `create` and `update` refuse, the start-key
 * cursor walk over tied values, the single-row atomic transaction, and the
 * interop read of a row written by the raw SDK.
 *
 * Run it against the local emulator with:
 *
 * ```
 * docker run -d --name he-bigtable -p 127.0.0.1:8086:8086 \
 *   gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
 *   gcloud beta emulators bigtable start --host-port=0.0.0.0:8086
 *
 * BIGTABLE_EMULATOR_ENDPOINT=127.0.0.1:8086 deno test -A \
 *   packages/database-plugin/test/integration/real-bigtable-adapter.test.ts
 * ```
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FilterExpression, IDataSource, NormalizedQuery } from '@setu-ts/common';
import { decodeCursor } from '@setu-ts/common';
import { matchesFilter } from '../../src/query/query-builder.ts';
import { BigtableAdapter } from '../../src/adapters/bigtable/bigtable-adapter.ts';
import { createLazyBigtableLoader } from '../../src/adapters/bigtable/bigtable-client.ts';
import {
  BigtableTransactionScopeError,
  UnsupportedQueryFeatureError,
  UnsupportedRawQueryError,
} from '../../src/errors.ts';
import type { BigtableEntityMapping } from '../../src/adapters/bigtable/bigtable-mapping.ts';

/** The emulator address; absent, every case below is ignored. */
const endpoint = Deno.env.get('BIGTABLE_EMULATOR_ENDPOINT');
const skipReal = endpoint === undefined;
/** The project and instance the emulator serves implicitly (it has no admin API). */
const projectId = 'setu-m82';
const instanceId = 'setu-m82-instance';
/** A per-run discriminator keeping this run's tables from any other's. */
const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** Builds a fully-resolved query, so each case states only what it varies. */
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

/**
 * The raw SDK client, used ONLY to provision tables and to plant an interop
 * row. The adapter provisions nothing: throughput and garbage-collection
 * choices belong to the application, exactly as Cosmos containers do.
 *
 * @returns The native Bigtable client
 */
// deno-lint-ignore no-explicit-any -- the native SDK is untyped at this boundary
async function rawClient(): Promise<any> {
  const { Bigtable } = await import('npm:@google-cloud/bigtable@^6');
  // deno-lint-ignore no-explicit-any -- ditto
  return new (Bigtable as any)({ projectId, apiEndpoint: endpoint });
}

/**
 * Creates a table with the named families, tolerating a re-create.
 *
 * The emulator implements NO instance admin API (`instance.create()` answers
 * `12 UNIMPLEMENTED`), so instances are implicit and tables are created
 * directly.
 *
 * @param table - The table id
 * @param families - The column families to create
 * @returns The table id
 */
async function provision(table: string, families: readonly string[]): Promise<string> {
  const client = await rawClient();
  try {
    await client.instance(instanceId).table(table).create({ families: [...families] });
  } catch (error) {
    // `6 ALREADY_EXISTS` is the only tolerable failure here.
    if ((error as { code?: number }).code !== 6) throw error;
  }
  await client.close();
  return table;
}

/**
 * Builds a connected adapter over the lazy SDK arm.
 *
 * The lazy arm is deliberate: it is the only place the literal
 * `import('npm:@google-cloud/bigtable@^6')` actually runs.
 *
 * @param tables - The per-entity mapping
 * @returns The connected adapter
 */
async function connect(
  tables?: Readonly<Record<string, BigtableEntityMapping>>,
): Promise<BigtableAdapter> {
  const adapter = new BigtableAdapter({
    projectId,
    instance: instanceId,
    apiEndpoint: endpoint as string,
    ...(tables === undefined ? {} : { tables }),
  });
  await adapter.connect();
  return adapter;
}

describe('BigtableAdapter against a real Bigtable emulator (guarded)', () => {
  it('lazily imports the SDK and reads every CRUD write back', { ignore: skipReal }, async () => {
    const table = await provision(`crud_${suffix}`, ['cf']);
    const adapter = await connect({ User: { table } });
    try {
      expect(adapter.isReady()).toBe(true);
      const users = adapter.createDataSource('User');
      const when = new Date('2026-08-31T10:11:12.000Z');
      await users.create({
        id: 'u1',
        name: 'ada',
        age: 36,
        active: true,
        joined: when,
        tags: ['x', 'y'],
        note: null,
      });

      const read = await users.findById('u1');
      expect(read).toEqual({
        id: 'u1',
        name: 'ada',
        age: 36,
        active: true,
        joined: when,
        tags: ['x', 'y'],
        note: null,
      });

      expect(await users.update('u1', { age: 37 })).toMatchObject({ id: 'u1', age: 37 });
      expect((await users.findById('u1'))?.age).toBe(37);
      expect(await users.delete('u1')).toBe(true);
      expect(await users.findById('u1')).toBe(null);
      expect(await users.delete('u1')).toBe(false);
    } finally {
      await adapter.disconnect();
    }
  });

  it('addresses a row by a key COMPOSED from several fields', { ignore: skipReal }, async () => {
    const table = await provision(`composed_${suffix}`, ['cf']);
    const adapter = await connect({
      Order: { table, rowKey: { fields: ['tenantId', 'orderId'], prefix: 'o/' } },
    });
    try {
      const orders = adapter.createDataSource('Order');
      await orders.create({ tenantId: 't1', orderId: 'a9', total: 42 });
      expect(await orders.findById({ tenantId: 't1', orderId: 'a9' }))
        .toEqual({ tenantId: 't1', orderId: 'a9', total: 42 });

      // The PHYSICAL row key, read through the raw SDK: the composition is a
      // wire fact, not an internal detail, because an existing table's keys
      // have to line up with it.
      const client = await rawClient();
      const [rows] = await client.instance(instanceId).table(table).getRows({});
      expect(rows.map((row: { id: string }) => row.id)).toEqual(['o/t1#a9']);
      await client.close();

      // A scalar cannot say which of two fields it is.
      await expect(orders.findById('a9')).rejects.toThrow(/needs a record naming every field/);
      // And a value carrying the separator would collide with another key.
      await expect(orders.create({ tenantId: 't#1', orderId: 'b', total: 1 }))
        .rejects.toThrow(/contains the '#' separator/);
    } finally {
      await adapter.disconnect();
    }
  });

  it('honours the EXCLUSIVE range boundary the SDK shorthand gets wrong', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`range_${suffix}`, ['cf']);
    const adapter = await connect({
      Item: { table, rowKey: { fields: ['tenant', 'id'] } },
    });
    try {
      const items = adapter.createDataSource('Item');
      for (const tenant of ['t1', 't2']) {
        for (const id of ['a', 'b']) await items.create({ tenant, id, n: `${tenant}-${id}` });
      }
      // The prefix range for `t1` ends at the EXCLUSIVE successor of `t1#`, so
      // it must not spill into `t2`.
      const rows = await items.findAll(query({ where: { tenant: 't1' } }));
      expect(rows.map((r) => r.n)).toEqual(['t1-a', 't1-b']);

      // And the boundary itself, pinned against the service. This is the P4
      // trap in the sharpest form available: the SAME logical range, expressed
      // through the SDK's `{ start, end }` SHORTHAND, returns one row too many
      // because that form is inclusive at BOTH ends. The adapter never builds
      // it, and this is what proves the explicit form is the one that works.
      const loader = createLazyBigtableLoader({
        projectId,
        apiEndpoint: endpoint as string,
      });
      const facade = await loader.load();
      try {
        const table_ = facade.instance(instanceId).table(table);
        const exclusive = await table_.readRows({
          ranges: [{
            start: { value: 't1#a', inclusive: true },
            end: { value: 't2#a', inclusive: false },
          }],
        });
        expect(exclusive.map((row) => row.key)).toEqual(['t1#a', 't1#b']);
        const inclusive = await table_.readRows({
          ranges: [{
            start: { value: 't1#a', inclusive: true },
            end: { value: 't2#a', inclusive: true },
          }],
        });
        expect(inclusive.map((row) => row.key)).toEqual(['t1#a', 't1#b', 't2#a']);
      } finally {
        await facade.close();
      }

      const raw = await rawClient();
      try {
        const [shorthand] = await raw.instance(instanceId).table(table).getRows({
          start: 't1#a',
          end: 't2#a',
        });
        // Three rows, not two: the shorthand's upper bound is inclusive.
        expect(shorthand.map((row: { id: string }) => row.id))
          .toEqual(['t1#a', 't1#b', 't2#a']);
      } finally {
        await raw.close();
      }
    } finally {
      await adapter.disconnect();
    }
  });

  it('keeps a numeric key field a NUMBER by reading its cell, not the row key', {
    ignore: skipReal,
  }, async () => {
    // The row key is bytes and records no type, so the key field's CELL is what
    // preserves it — which is why the projection always keeps the key
    // qualifiers even when the caller's `select` names none.
    //
    // The key field is named `zid` deliberately: cells come back in
    // lexicographic qualifier order, so a key sorting FIRST would be rescued by
    // the projection's one-cell arm and the assertion would hold whether the
    // key qualifiers were kept or not. Observable through
    // the minted cursor, which carries the key values from the unprojected row.
    const table = await provision(`numkey_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table, rowKey: { fields: ['zid'] } } });
    try {
      const rows = adapter.createDataSource('Row');
      await rows.create({ zid: 7, name: 'ada' });
      await rows.create({ zid: 8, name: 'bob' });
      const page = await rows.findPage?.(query({ limit: 1, select: ['name'] }));
      expect(page?.rows).toEqual([{ name: 'ada' }]);
      const decoded = decodeCursor(page?.nextCursor as string);
      expect(decoded?.keyValues).toEqual([7]);
    } finally {
      await adapter.disconnect();
    }
  });

  it("excludes the row that sits exactly on a prefix range's exclusive end", {
    ignore: skipReal,
  }, async () => {
    // The prefix range for `o/` ends at its successor, `o0` — and a row keyed
    // exactly `o0` is the one row an inclusive upper bound would wrongly
    // include. Planted through the raw SDK, because the mapped entity cannot
    // compose that key itself.
    const table = await provision(`bound_${suffix}`, ['cf']);
    const raw = await rawClient();
    await raw.instance(instanceId).table(table).insert([
      { key: 'o/1', data: { cf: { id: 's:1' } } },
      { key: 'o/2', data: { cf: { id: 's:2' } } },
      { key: 'o0', data: { cf: { id: 's:outside' } } },
    ]);
    await raw.close();

    const adapter = await connect({ Order: { table, rowKey: { fields: ['id'], prefix: 'o/' } } });
    try {
      const rows = await adapter.createDataSource('Order').findAll(query());
      expect(rows.map((row) => row.id)).toEqual(['1', '2']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('matches a value by EXACT BYTES, so a regex metacharacter is data', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`bytes_${suffix}`, ['cf']);
    const adapter = await connect({ Code: { table } });
    try {
      const codes = adapter.createDataSource('Code');
      await codes.create({ id: 'c1', pattern: 'a.*b' });
      // The row a REGEX would also match. The SDK's string value form IS a
      // regex — measured, `{ value: 'a.*b' }` matched both of these.
      await codes.create({ id: 'c2', pattern: 'axxb' });

      const rows = await codes.findAll(query({ where: { pattern: 'a.*b' } }));
      expect(rows.map((r) => r.id)).toEqual(['c1']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('answers a pushed-down predicate with the WHOLE row, not the matching cell', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`whole_${suffix}`, ['cf', 'meta']);
    const adapter = await connect({
      Person: { table, columns: { city: 'meta:city', tier: 'meta:tier' } },
    });
    try {
      const people = adapter.createDataSource('Person');
      await people.create({ id: 'p1', name: 'ada', city: 'london', tier: 'gold' });
      await people.create({ id: 'p2', name: 'bob', city: 'paris', tier: 'gold' });

      // A bare value chain would strip every non-matching cell and answer with
      // `{ city }` alone; the `condition` wrapper is what returns the row.
      const rows = await people.findAll(query({ where: { city: 'london' } }));
      expect(rows).toEqual([{ id: 'p1', name: 'ada', city: 'london', tier: 'gold' }]);

      // Two conjunctive equalities nest as two conditions and still return whole rows.
      const both = await people.findAll(query({ where: { city: 'paris', tier: 'gold' } }));
      expect(both).toEqual([{ id: 'p2', name: 'bob', city: 'paris', tier: 'gold' }]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('projects across column families while keeping the key field', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`project_${suffix}`, ['cf', 'meta']);
    const adapter = await connect({
      Person: { table, columns: { city: 'meta:city' } },
    });
    try {
      const people = adapter.createDataSource('Person');
      await people.create({ id: 'p1', name: 'ada', city: 'london', age: 36 });
      const rows = await people.findAll(query({
        select: ['name', 'city'],
        filter: { type: 'comparison', field: 'age', operator: 'gt', value: 30 },
      }));
      // `age` was READ (the client-side filter needs it) but not returned, and
      // `id` was read so the key field's cell — not the row key — supplies it.
      expect(rows).toEqual([{ name: 'ada', city: 'london' }]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('keeps a row carrying NONE of the projected columns', { ignore: skipReal }, async () => {
    // A filter that removes every cell of a row removes the ROW — measured, the
    // service does not answer with an empty row — so a bare column projection
    // silently drops a row that has none of the projected columns. The
    // projection is interleaved with a one-cell arm for exactly this. Only
    // reachable on a table this adapter did not write, whose rows carry no key
    // cell, so the rows are planted through the raw SDK.
    const table = await provision(`sparseproject_${suffix}`, ['cf']);
    const client = await rawClient();
    await client.instance(instanceId).table(table).insert([
      { key: 'o1', data: { cf: { name: 'ada' } } },
      { key: 'o2', data: { cf: { other: 'x' } } },
    ]);
    await client.close();

    const adapter = await connect({ Order: { table, valueEncoding: 'raw' } });
    try {
      const rows = await adapter.createDataSource('Order').findAll(query({ select: ['name'] }));
      expect(rows).toEqual([{ name: 'ada' }, {}]);
    } finally {
      await adapter.disconnect();
    }
  });

  it('refuses to overwrite on create and to fabricate on update', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`conditional_${suffix}`, ['cf']);
    const adapter = await connect({ User: { table } });
    try {
      const users = adapter.createDataSource('User');
      await users.create({ id: 'u1', name: 'ada' });
      await expect(users.create({ id: 'u1', name: 'bob' })).rejects.toThrow(/does not overwrite/);
      expect((await users.findById('u1'))?.name).toBe('ada');
      await expect(users.update('nope', { name: 'x' })).rejects.toThrow(/no row keyed 'nope'/);
      expect(await users.findById('nope')).toBe(null);
    } finally {
      await adapter.disconnect();
    }
  });

  it('walks a start-key cursor over deliberately TIED values', { ignore: skipReal }, async () => {
    const table = await provision(`page_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table } });
    try {
      const rows = adapter.createDataSource('Row');
      // Six rows carrying only two distinct `rank` values: a walk that lost the
      // key tiebreaker returns four of six and reports success.
      for (let i = 1; i <= 6; i += 1) {
        await rows.create({ id: `r${i}`, rank: i <= 3 ? 1 : 2 });
      }
      const seen = await walkPages(rows, { limit: 2 });
      expect(seen).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
      expect(new Set(seen).size).toBe(6);
    } finally {
      await adapter.disconnect();
    }
  });

  it('reports a filtered page non-terminal even when it carries zero rows', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`sparse_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table, rowKey: { fields: ['id'] } } });
    try {
      const rows = adapter.createDataSource('Row');
      for (let i = 1; i <= 6; i += 1) await rows.create({ id: `r${i}`, rank: i });
      // An ORDERED comparison is not pushed down, so the first raw batch can
      // match nothing at all — the case a `rows.length`-derived cursor gets
      // wrong.
      const filter: FilterExpression = {
        type: 'comparison',
        field: 'rank',
        operator: 'gt',
        value: 5,
      };
      const seen = await walkPages(rows, { limit: 2, filter });
      expect(seen).toEqual(['r6']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('expands an `in` on the final key field into an explicit key read', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`inlist_${suffix}`, ['cf']);
    const adapter = await connect({ Item: { table, rowKey: { fields: ['tenant', 'id'] } } });
    try {
      const items = adapter.createDataSource('Item');
      for (const id of ['a', 'b', 'c']) await items.create({ tenant: 't1', id, n: id });
      const rows = await items.findAll(query({
        where: { tenant: 't1' },
        filter: { type: 'comparison', field: 'id', operator: 'in', value: ['a', 'c'] },
      }));
      expect(rows.map((r) => r.id)).toEqual(['a', 'c']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('commits delete-then-write as ONE atomic mutation list', { ignore: skipReal }, async () => {
    const table = await provision(`tx_${suffix}`, ['cf']);
    const adapter = await connect({ User: { table } });
    try {
      const users = adapter.createDataSource('User');
      await users.create({ id: 'u1', name: 'ada', stale: 'yes' });

      const tx = await adapter.beginTransaction();
      const scoped = tx.createDataSource('User');
      expect(await scoped.delete('u1')).toBe(true);
      await scoped.create({ id: 'u1', name: 'bob' });
      // Nothing has landed yet: reads observe committed state only.
      expect((await users.findById('u1'))?.name).toBe('ada');
      await tx.commit();
      // The delete ran first, so the qualifier the insert did not name is gone.
      expect(await users.findById('u1')).toEqual({ id: 'u1', name: 'bob' });
    } finally {
      await adapter.disconnect();
    }
  });

  it('rolls back without sending anything, and refuses a second row', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`txscope_${suffix}`, ['cf']);
    const adapter = await connect({ User: { table } });
    try {
      const users = adapter.createDataSource('User');

      const rolled = await adapter.beginTransaction();
      await rolled.createDataSource('User').create({ id: 'r1', name: 'ada' });
      await rolled.rollback();
      expect(await users.findById('r1')).toBe(null);

      const scoped = await adapter.beginTransaction();
      const source = scoped.createDataSource('User');
      await source.create({ id: 's1' });
      await expect(source.create({ id: 's2' })).rejects.toThrow(BigtableTransactionScopeError);
      await scoped.commit();
      expect(await users.findById('s1')).toEqual({ id: 's1' });
      expect(await users.findById('s2')).toBe(null);
    } finally {
      await adapter.disconnect();
    }
  });

  it('counts with and without a residual predicate', { ignore: skipReal }, async () => {
    const table = await provision(`count_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table } });
    try {
      const rows = adapter.createDataSource('Row');
      for (let i = 1; i <= 4; i += 1) await rows.create({ id: `r${i}`, rank: i });
      // No predicate: the read strips every cell value and counts rows.
      expect(await rows.count({})).toBe(4);
      expect(await rows.count({}, { type: 'comparison', field: 'rank', operator: 'gt', value: 2 }))
        .toBe(2);
      expect(await rows.count({ rank: 1 })).toBe(1);
    } finally {
      await adapter.disconnect();
    }
  });

  it('reads a row written by the RAW SDK, recovering key fields from the row key', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`interop_${suffix}`, ['cf']);
    // The interop shape: untagged values, and no key cell at all.
    const client = await rawClient();
    await client.instance(instanceId).table(table).insert([
      { key: 't1#o9', data: { cf: { total: '42', label: 'legacy' } } },
    ]);
    await client.close();

    const adapter = await connect({
      Order: { table, rowKey: { fields: ['tenantId', 'orderId'] }, valueEncoding: 'raw' },
    });
    try {
      const orders = adapter.createDataSource('Order');
      expect(await orders.findById({ tenantId: 't1', orderId: 'o9' })).toEqual({
        tenantId: 't1',
        orderId: 'o9',
        total: '42',
        label: 'legacy',
      });
    } finally {
      await adapter.disconnect();
    }
  });

  it('refuses by name what Bigtable cannot serve', { ignore: skipReal }, async () => {
    const table = await provision(`refuse_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table } });
    try {
      const rows = adapter.createDataSource('Row');
      await rows.create({ id: 'r1', name: 'ada' });

      // Descending is refused rather than shipped on `reversed: true`, which
      // this emulator SILENTLY IGNORES — measured, it answered ascending with
      // no error, so a descending path could never be verified here.
      await expect(rows.findAll(query({ orderBy: { id: 'desc' } })))
        .rejects.toThrow(UnsupportedQueryFeatureError);
      await expect(rows.findAll(query({ orderBy: { name: 'asc' } })))
        .rejects.toThrow(/only be ordered by its row key/);
      await expect(rows.findAll(query({ offset: 1 }))).rejects.toThrow(/no row offset/);
      await expect(adapter.rawQuery('SELECT 1')).rejects.toThrow(UnsupportedRawQueryError);

      // The full key ascending IS the scan order and is honoured.
      expect((await rows.findAll(query({ orderBy: { id: 'asc' } }))).map((r) => r.id))
        .toEqual(['r1']);
    } finally {
      await adapter.disconnect();
    }
  });

  it('names a missing table rather than failing with a bare error', {
    ignore: skipReal,
  }, async () => {
    // No connect-time probe exists precisely because this diagnostic already
    // quotes the full resource path — and an admin probe would refuse a
    // data-plane service account that cannot list tables.
    const adapter = await connect({ Ghost: { table: `absent_${suffix}` } });
    try {
      let caught: unknown;
      try {
        await adapter.createDataSource('Ghost').findById('x');
      } catch (error) {
        caught = error;
      }
      expect(String((caught as Error).message)).toContain(`absent_${suffix}`);
    } finally {
      await adapter.disconnect();
    }
  });

  it('agrees with the memory reference on every portable filter operator', {
    ignore: skipReal,
  }, async () => {
    const table = await provision(`conform_${suffix}`, ['cf']);
    const adapter = await connect({ Row: { table } });
    try {
      const rows = adapter.createDataSource('Row');
      const seed = [
        { id: 'r1', name: '50% off bracket', rank: 1 },
        { id: 'r2', name: '50x off', rank: 2 },
        { id: 'r3', name: 'a.*b glob', rank: 3 },
        { id: 'r4', name: 'axxb glob', rank: 4 },
        { id: 'r5', name: 'plain text', rank: 5 },
      ];
      for (const row of seed) await rows.create(row);

      const cases: FilterExpression[] = [
        { type: 'comparison', field: 'name', operator: 'eq', value: 'a.*b glob' },
        { type: 'comparison', field: 'name', operator: 'contains', value: '50% off' },
        { type: 'comparison', field: 'rank', operator: 'gt', value: 3 },
        { type: 'comparison', field: 'rank', operator: 'lte', value: 2 },
        { type: 'comparison', field: 'id', operator: 'in', value: ['r1', 'r5'] },
        { type: 'comparison', field: 'id', operator: 'in', value: [] },
        {
          type: 'or',
          filters: [
            { type: 'comparison', field: 'rank', operator: 'eq', value: 1 },
            { type: 'comparison', field: 'name', operator: 'contains', value: 'plain' },
          ],
        },
        {
          type: 'and',
          filters: [
            { type: 'comparison', field: 'rank', operator: 'gte', value: 2 },
            { type: 'comparison', field: 'rank', operator: 'lt', value: 4 },
          ],
        },
      ];
      for (const filter of cases) {
        const expected = seed.filter((row) => matchesFilter(row, filter)).map((row) => row.id);
        const actual = (await rows.findAll(query({ filter }))).map((row) => String(row.id));
        expect(actual.sort(), JSON.stringify(filter)).toEqual([...expected].sort());
      }
    } finally {
      await adapter.disconnect();
    }
  });
});

/**
 * Walks every page of a cursor query, returning the ids seen in order.
 *
 * @param source - The data source to page
 * @param base - The page query, minus the cursor
 * @returns Every id, in page order
 */
async function walkPages(
  source: IDataSource,
  base: Partial<NormalizedQuery>,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 25; page += 1) {
    const result = await (source.findPage as (q: NormalizedQuery) => Promise<{
      rows: Record<string, unknown>[];
      nextCursor: string | null;
    }>)(query(cursor === undefined ? base : { ...base, cursor }));
    ids.push(...result.rows.map((row) => String(row.id)));
    if (result.nextCursor === null) return ids;
    cursor = result.nextCursor;
  }
  throw new Error('page walk did not terminate');
}
