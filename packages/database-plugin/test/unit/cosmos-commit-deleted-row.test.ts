/**
 * A Cosmos unit-of-work commit whose row was deleted after the call.
 *
 * Measured on the emulator: a batch operation carrying `ifMatch` against a row
 * that no longer exists answers 404, because the service checks existence
 * before the ETag (412 is only for a row still present). A conditional write
 * losing its row is the same lost race as a stale ETag, so the commit throws
 * `SerializationConflictError`. A plain update of a deleted row conflicts
 * too (409); only a plain delete keeps the batch's own 404.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IDataSource } from '@setu-ts/common';
import { CosmosAdapter, SerializationConflictError } from '../../src/index.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';

/** Each buffered write, and whether its commit is a conflict when the row is gone. */
const rows: readonly {
  readonly name: string;
  readonly write: (source: IDataSource) => Promise<unknown>;
  readonly conflict: boolean;
}[] = [
  {
    name: 'a conditional update',
    write: (source) => source.updateWhere!('a', { version: 1 }, { version: 2 }),
    conflict: true,
  },
  {
    name: 'a conditional delete',
    write: (source) => source.deleteWhere!('a', { version: 1 }),
    conflict: true,
  },
  {
    name: 'a plain update',
    write: (source) => source.update('a', { version: 2 }),
    conflict: true,
  },
  {
    name: 'a plain delete',
    write: (source) => source.delete('a'),
    conflict: false,
  },
];

describe('Cosmos commit after the row was deleted', () => {
  for (const row of rows) {
    it(`${row.name} commits as ${row.conflict ? 'a serialization conflict' : 'the batch error'}`, async () => {
      const fake = createFakeCosmosClient({ containers: { Row: { partitionKeyPaths: ['/id'] } } });
      const adapter = new CosmosAdapter({ database: 'db', client: fake.client });
      await adapter.connect();
      try {
        const root = adapter.createDataSource('Row');
        await root.create({ id: 'a', version: 1 });
        const tx = await adapter.beginTransaction();
        await row.write(tx.createDataSource('Row'));
        await root.delete('a');
        const error: unknown = await tx.commit().catch((caught: unknown) => caught);
        const batch = (row.conflict ? (error as Error).cause : error) as Error & { code?: number };
        expect(error instanceof SerializationConflictError).toBe(row.conflict);
        expect(batch.name).toBe('CosmosTransactionBatchError');
        expect(batch.code).toBe(404);
        expect(await root.findById('a')).toBeNull();
      } finally {
        await adapter.disconnect();
      }
    });
  }
});
