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
});
