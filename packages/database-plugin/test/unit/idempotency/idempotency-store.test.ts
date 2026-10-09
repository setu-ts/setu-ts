/**
 * The tier-C idempotency store bridge (M109b §3.6, §3.10): two creates per
 * `run` (never an update or a delete), `find` requiring both rows of the
 * matching `kind`, `purge` deleting both rows and honouring `limit`, and the
 * factory's resolution — all over the memory adapter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  EntityKey,
  IIdempotencyService,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import { CAPABILITIES, IDEMPOTENCY_RECORD_KIND } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import type { IDatabaseService, IRepository } from '../../../src/interfaces/index.ts';
import { createDatabaseIdempotencyStore } from '../../../src/idempotency/database-idempotency-store.ts';
import { TransactionalStoreUnavailableError } from '../../../src/idempotency/errors.ts';
import {
  allRows,
  claim,
  ENTITY,
  memoryService,
  seed,
  storeOver,
} from '../../fixtures/idempotency-store.ts';

/** A row as the adapter hands it back. */
type Row = Record<string, unknown>;

/** The one row with `id`, asserted present. */
function rowFor(rows: readonly Row[], id: string): Row {
  const row = rows.find((candidate) => candidate.id === id);
  expect(row).toBeDefined();
  return row as Row;
}

describe('DatabaseIdempotencyStore.run (M109b §3.1, §3.6)', () => {
  it('creates the claim first and the result row, and returns the work value', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const value = await store.run(
      claim('a'),
      () => Promise.resolve({ result: '{"v":1}', value: { n: 1 } }),
    );

    expect(value).toEqual({ n: 1 });
    const rows = await allRows(service);
    expect(rows).toHaveLength(2);
    const claimRow = rowFor(rows, claim('a').id);
    const resultRow = rowFor(rows, `${claim('a').id}.r`);
    expect(claimRow.kind).toBe(IDEMPOTENCY_RECORD_KIND);
    expect(claimRow.role).toBe('claim');
    expect(claimRow.result).toBeNull();
    expect(claimRow.fingerprint).toBe('f'.repeat(64));
    expect(resultRow.kind).toBe(IDEMPOTENCY_RECORD_KIND);
    expect(resultRow.role).toBe('result');
    expect(resultRow.result).toBe('{"v":1}');
    expect(resultRow.createdAt).toBe(1_000);
    expect(resultRow.expiresAt).toBe(2_000);
  });

  it('rolls the whole transaction back when the work throws', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const boom = new Error('work failed');

    await expect(store.run(claim('a'), () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await allRows(service)).toEqual([]);
  });

  it('rolls back both rows when the result-row create is refused', async () => {
    const inner = await memoryService();
    let creates = 0;
    const service: IDatabaseService = {
      ...inner,
      transaction: (work) =>
        inner.transaction((uow) =>
          work({
            getRepository: <E, Id extends EntityKey = string>(entity: string) => {
              const repo = uow.getRepository<E, Id>(entity);
              return {
                ...repo,
                create: (data: Partial<E>) => {
                  creates += 1;
                  return creates === 2
                    ? Promise.reject(new Error('commit refused'))
                    : repo.create(data);
                },
              };
            },
          })
        ),
    };
    await expect(
      storeOver(service).run(claim('a'), () => Promise.resolve({ result: '{"v":1}', value: 1 })),
    ).rejects.toThrow('commit refused');
    expect(await allRows(inner)).toEqual([]);
  });
});

describe('DatabaseIdempotencyStore.find (M109b §3.1)', () => {
  it('reads the committed record as a whole', async () => {
    const service = await memoryService();
    await storeOver(service).run(
      claim('a'),
      () => Promise.resolve({ result: '{"v":7}', value: 7 }),
    );

    expect(await storeOver(service).find(claim('a').id)).toEqual({
      id: claim('a').id,
      fingerprint: 'f'.repeat(64),
      result: '{"v":7}',
      createdAt: 1_000,
      expiresAt: 2_000,
    });
  });

  it('is undefined when no row exists', async () => {
    const service = await memoryService();
    expect(await storeOver(service).find('x'.repeat(64))).toBeUndefined();
  });

  it('is undefined when the result row is missing', async () => {
    const service = await memoryService();
    await seed(service, [
      {
        id: claim('a').id,
        kind: IDEMPOTENCY_RECORD_KIND,
        role: 'claim',
        fingerprint: 'f'.repeat(64),
        createdAt: 1_000,
        expiresAt: 2_000,
        result: null,
      },
    ]);
    expect(await storeOver(service).find(claim('a').id)).toBeUndefined();
  });

  it('is undefined for a claim row of another kind', async () => {
    const service = await memoryService();
    await seed(service, [
      { id: claim('a').id, kind: 'business', role: 'claim', result: null },
    ]);
    expect(await storeOver(service).find(claim('a').id)).toBeUndefined();
  });

  it('is undefined when the claim row carries the wrong role', async () => {
    const service = await memoryService();
    await seed(service, [
      { id: claim('a').id, kind: IDEMPOTENCY_RECORD_KIND, role: 'result', result: '{}' },
    ]);
    expect(await storeOver(service).find(claim('a').id)).toBeUndefined();
  });

  it('is undefined when the result row is of another kind', async () => {
    const service = await memoryService();
    await seed(service, [
      {
        id: claim('a').id,
        kind: IDEMPOTENCY_RECORD_KIND,
        role: 'claim',
        fingerprint: 'f'.repeat(64),
        createdAt: 1_000,
        expiresAt: 2_000,
        result: null,
      },
      { id: `${claim('a').id}.r`, kind: 'business', role: 'result', result: '{}' },
    ]);
    expect(await storeOver(service).find(claim('a').id)).toBeUndefined();
  });
});

describe('DatabaseIdempotencyStore.purge (M109b §3.10)', () => {
  it('keeps both rows and replays when the second purge delete fails', async () => {
    const inner = await memoryService();
    const failResultDelete = <E, Id extends EntityKey>(repo: IRepository<E, Id>) =>
      new Proxy(repo, {
        get(target, property) {
          if (property === 'delete') {
            return (id: Id) =>
              String(id).endsWith('.r')
                ? Promise.reject(new Error('result delete refused'))
                : repo.delete(id);
          }
          const member: unknown = Reflect.get(target, property);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    const service: IDatabaseService = {
      ...inner,
      getRepository: <E, Id extends EntityKey = string>(entity: string) =>
        failResultDelete(inner.getRepository<E, Id>(entity)),
      transaction: (work) =>
        inner.transaction((uow) =>
          work({
            getRepository: <E, Id extends EntityKey = string>(entity: string) =>
              failResultDelete(uow.getRepository<E, Id>(entity)),
          })
        ),
    };
    const store = storeOver(service);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin({
          transactional: { store, purge: { schedule: false } },
        }),
      ],
    });
    await app.start();
    try {
      const idempotency = app.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
      const options = { key: 'interrupted-purge', scope: 'scope', namespace: 'namespace' };
      expect(await idempotency.within(options, () => Promise.resolve('winner')))
        .toEqual({ value: 'winner', replayed: false });
      const before = await allRows(inner);
      await expect(store.purge(Number.MAX_SAFE_INTEGER, 10)).rejects.toThrow(
        'result delete refused',
      );
      expect(await allRows(inner)).toEqual(before);
      expect(await idempotency.within(options, () => Promise.resolve('unexpected')))
        .toEqual({ value: 'winner', replayed: true });
    } finally {
      await app.stop();
    }
  });

  for (const result of ['not JSON', 'null', '1', '[]', '{"wrong":1}', '{"v":1,"extra":2}']) {
    it(`preserves a record with invalid envelope ${result}`, async () => {
      const service = await memoryService();
      const store = storeOver(service);
      await store.run(claim('invalid'), () => Promise.resolve({ result, value: undefined }));
      const before = await allRows(service);
      expect(await store.purge(3_000, 10)).toBe(0);
      expect(await allRows(service)).toEqual(before);
    });
  }
  it('preserves incomplete and foreign-result records while purging valid values', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    for (const label of ['orphan', 'foreign', 'valid']) {
      await store.run(claim(label), () => Promise.resolve({ result: '{"v":1}', value: 1 }));
    }
    const repo = service.getRepository<Row>(ENTITY);
    await repo.delete(`${claim('orphan').id}.r`);
    await repo.update(`${claim('foreign').id}.r`, { kind: 'foreign' });
    expect(await store.purge(3_000, 10)).toBe(1);
    expect((await allRows(service)).map((r) => r.id).sort()).toEqual(
      [claim('orphan').id, claim('foreign').id, `${claim('foreign').id}.r`].sort(),
    );
  });

  it('spares a record re-created after a concurrent purge removed the one it listed', async () => {
    const inner = await memoryService();
    const store = storeOver(inner);
    await store.run(claim('reused'), () => Promise.resolve({ result: '{"v":"old"}', value: 1 }));
    let interleaved = false;
    // Between this purge's listing and its delete, another replica's purge
    // removes the expired record and a client re-creates the key (R2-1).
    const interleave: IDatabaseService['transaction'] = async (work, options) => {
      if (!interleaved) {
        interleaved = true;
        const repo = inner.getRepository<Row>(ENTITY);
        await repo.delete(claim('reused').id);
        await repo.delete(`${claim('reused').id}.r`);
        await store.run(
          claim('reused', { createdAt: 5_000, expiresAt: 90_000 }),
          () => Promise.resolve({ result: '{"v":"fresh"}', value: 2 }),
        );
      }
      return await inner.transaction(work, options);
    };
    const service = new Proxy(inner, {
      get(target, property) {
        if (property === 'transaction') return interleave;
        const member: unknown = Reflect.get(target, property);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    expect(await storeOver(service).purge(3_000, 10)).toBe(0);
    expect(await store.find(claim('reused').id)).toEqual({
      id: claim('reused').id,
      fingerprint: 'f'.repeat(64),
      result: '{"v":"fresh"}',
      createdAt: 5_000,
      expiresAt: 90_000,
    });
  });

  it('deletes both rows of an expired record', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await store.run(claim('a'), () => Promise.resolve({ result: '{}', value: 1 }));

    expect(await store.purge(3_000, 10)).toBe(1);
    expect(await allRows(service)).toEqual([]);
  });

  it('deletes only expired records and honours the limit', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await store.run(
      claim('old', { expiresAt: 1_000 }),
      () => Promise.resolve({ result: '{}', value: 1 }),
    );
    await store.run(
      claim('new', { expiresAt: 9_000 }),
      () => Promise.resolve({ result: '{}', value: 2 }),
    );

    expect(await store.purge(3_000, 10)).toBe(1);
    const remaining = await allRows(service);
    expect(remaining.map((row) => row.id)).toEqual([
      claim('new').id,
      `${claim('new').id}.r`,
    ]);
  });

  it('counts at most `limit` records', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    for (const label of ['a', 'b', 'c']) {
      await store.run(claim(label), () => Promise.resolve({ result: '{}', value: 1 }));
    }
    expect(await store.purge(3_000, 2)).toBe(2);
    expect((await allRows(service)).length).toBe(2);
  });

  it('never purges a row of another kind', async () => {
    const service = await memoryService();
    await seed(service, [
      {
        id: 'business-1',
        kind: 'business',
        role: 'claim',
        fingerprint: 'f'.repeat(64),
        createdAt: 0,
        expiresAt: 0,
        result: null,
      },
    ]);
    expect(await storeOver(service).purge(9_999, 10)).toBe(0);
    expect((await allRows(service)).length).toBe(1);
  });
});

describe('createDatabaseIdempotencyStore (M109b §3.6)', () => {
  /** A registry holding a database service under `token` and a runtime. */
  function registry(token: string, service: IDatabaseService): IServiceRegistry {
    const runtime = { uuid: () => 'u-1' } as unknown as IRuntimeServices;
    const entries = new Map<string, unknown>([
      [token, service],
      [CAPABILITIES.RUNTIME, runtime],
    ]);
    return {
      get: <T>(name: string) => {
        if (!entries.has(name)) throw new Error(`missing ${name}`);
        return entries.get(name) as T;
      },
    } as unknown as IServiceRegistry;
  }

  it('resolves the default database, and a named one', async () => {
    const service = await memoryService();
    await createDatabaseIdempotencyStore()(registry('database', service)).verify();
    await createDatabaseIdempotencyStore({ database: 'default' })(registry('database', service))
      .verify();
    await createDatabaseIdempotencyStore({ database: 'billing' })(
      registry('database.billing', service),
    )
      .verify();
    expect(() =>
      createDatabaseIdempotencyStore({ database: 'billing' })(registry('database', service))
    )
      .toThrow('missing database.billing');
  });

  it('refuses an empty entity at the call', () => {
    expect(() => createDatabaseIdempotencyStore({ entity: '  ' })).toThrow(TypeError);
    expect(() => createDatabaseIdempotencyStore({ entity: '' })).toThrow(
      'entity must be a non-empty string',
    );
  });

  it('writes to the configured entity', async () => {
    const service = await memoryService();
    const store = createDatabaseIdempotencyStore({ entity: 'Custom' })(
      registry('database', service),
    );
    await store.run(claim('a'), () => Promise.resolve({ result: '{}', value: 1 }));
    expect((await service.getRepository<Row, EntityKey>('Custom').findAll()).length).toBe(2);
    expect(await storeOver(service).find(claim('a').id)).toBeUndefined();
  });
});

describe('TransactionalStoreUnavailableError (M109b §3.6)', () => {
  it('names the entity and the reason, and keeps the cause', () => {
    const cause = new Error('adapter said no');
    const error = new TransactionalStoreUnavailableError('Idempotency', 'mongodb-standalone', {
      cause,
    });
    expect(error.name).toBe('TransactionalStoreUnavailableError');
    expect(error.entity).toBe('Idempotency');
    expect(error.reason).toBe('mongodb-standalone');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("entity 'Idempotency'");
    expect(error.message).toContain('replica set');
    expect(error.message).not.toContain('adapter said no');
  });

  it('states each refusal reason', () => {
    const cosmos = new TransactionalStoreUnavailableError(ENTITY, 'cosmos-unsupported');
    expect(cosmos.message).toContain('Cosmos DB');
    const bigtable = new TransactionalStoreUnavailableError(ENTITY, 'bigtable-unsupported');
    expect(bigtable.message).toContain('Bigtable');
    const entity = new TransactionalStoreUnavailableError(ENTITY, 'entity-unavailable');
    expect(entity.message).toContain('missing or unreadable');
  });
});
