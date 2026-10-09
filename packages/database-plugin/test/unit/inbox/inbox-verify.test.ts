/**
 * The inbox bridge's startup check (M108 §3.10) and its factory: Cosmos DB
 * and Bigtable refused by adapter type, retention's first query, and a
 * two-row transactional probe that always rolls back — each refusal reason
 * decided from the adapter's real error class (and the MongoDB code-20 shape
 * measured against a real standalone server, M107).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, IRuntimeServices, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { BigtableTransactionScopeError } from '../../../src/errors.ts';
import type { FindOptions, IDatabaseService } from '../../../src/interfaces/index.ts';
import {
  createDatabaseInboxStore,
  DatabaseInboxStore,
} from '../../../src/inbox/database-inbox-store.ts';
import { InboxStoreUnavailableError } from '../../../src/inbox/errors.ts';
import { adapterInfoOf, DatabaseService } from '../../../src/services/database-service.ts';
import { BigtableAdapter } from '../../../src/adapters/bigtable/bigtable-adapter.ts';
import { CosmosAdapter } from '../../../src/adapters/cosmos/cosmos-adapter.ts';
import { MemoryAdapter } from '../../../src/index.ts';
import { allRows, ENTITY, memoryService } from '../../fixtures/inbox-store.ts';

/** The error the real `mongodb` driver raises inside a transaction on a standalone server. */
function mongoStandaloneError(): Error {
  const error = new Error(
    'Transaction numbers are only allowed on a replica set member or mongos',
  );
  error.name = 'MongoServerError';
  Object.assign(error, { code: 20, codeName: 'IllegalOperation' });
  return error;
}

/** A service whose retention query and whose probe's creates can each be made to reject. */
function failingService(
  inner: IDatabaseService,
  failures: { query?: unknown; secondCreate?: unknown; firstCreate?: unknown },
): IDatabaseService {
  return {
    ...inner,
    getRepository: <E, Id extends EntityKey = string>(entity: string) => {
      const repo = inner.getRepository<E, Id>(entity);
      return {
        ...repo,
        findAll: (options?: FindOptions) =>
          failures.query === undefined ? repo.findAll(options) : Promise.reject(failures.query),
      };
    },
    transaction: (work) =>
      inner.transaction((uow) => {
        let creates = 0;
        return work({
          getRepository: <E, Id extends EntityKey = string>(e: string) => {
            const repo = uow.getRepository<E, Id>(e);
            return {
              ...repo,
              create: (data: Partial<E>) => {
                creates += 1;
                if (creates === 1 && failures.firstCreate !== undefined) {
                  return Promise.reject(failures.firstCreate);
                }
                if (creates === 2 && failures.secondCreate !== undefined) {
                  return Promise.reject(failures.secondCreate);
                }
                return repo.create(data);
              },
            };
          },
        });
      }),
  };
}

/** Runs `verify()` and returns its rejection. */
async function refusalOf(service: IDatabaseService): Promise<InboxStoreUnavailableError> {
  const verifying = new DatabaseInboxStore(service, ENTITY, () => 'p').verify();
  expect(verifying).toBeInstanceOf(Promise);
  const error = await verifying.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(InboxStoreUnavailableError);
  return error as InboxStoreUnavailableError;
}

describe('DatabaseInboxStore.verify', () => {
  it('passes on the memory adapter and leaves no probe row behind', async () => {
    const service = await memoryService();
    await new DatabaseInboxStore(service, ENTITY, () => 'p').verify();
    expect(await allRows(service)).toEqual([]);
  });

  it('refuses Cosmos DB and Bigtable by adapter type, with no cause', async () => {
    const cosmos = await refusalOf(await memoryService('cosmos'));
    expect(cosmos.reason).toBe('cosmos-unsupported');
    expect(cosmos.cause).toBeUndefined();
    expect(cosmos.message).toContain("entity 'Inbox'");
    expect((await refusalOf(await memoryService('bigtable'))).reason).toBe('bigtable-unsupported');
  });

  it('refuses a shipped Cosmos or Bigtable adapter handed to the custom arm, by class', async () => {
    const memory = new MemoryAdapter();
    await memory.connect();
    for (
      const [prototype, reason] of [
        [CosmosAdapter.prototype, 'cosmos-unsupported'],
        [BigtableAdapter.prototype, 'bigtable-unsupported'],
      ] as const
    ) {
      // An instance of the class without a backend: `verify` must refuse it
      // before any I/O, so nothing on it is ever called.
      const adapter = Object.create(prototype) as CosmosAdapter;
      const service = new DatabaseService(adapter, (e) => memory.createDataSource(e), 'custom');
      expect((await refusalOf(service)).reason).toBe(reason);
    }
  });

  it('refuses a one-row-per-transaction adapter at the second probe row', async () => {
    const scope = new BigtableTransactionScopeError('one row per transaction');
    const error = await refusalOf(failingService(await memoryService(), { secondCreate: scope }));
    expect(error.reason).toBe('transaction-scope');
    expect(error.cause).toBe(scope);
  });

  it('refuses a standalone MongoDB through the probe, through a wrapped cause too', async () => {
    const raw = mongoStandaloneError();
    expect((await refusalOf(failingService(await memoryService(), { firstCreate: raw }))).reason)
      .toBe('mongodb-standalone');
    const wrapped = new Error('wrapped', { cause: raw });
    expect(
      (await refusalOf(failingService(await memoryService(), { firstCreate: wrapped }))).reason,
    ).toBe('mongodb-standalone');
  });

  it('refuses an unreadable entity, and a probe failure of any other kind', async () => {
    const missing = new Error('relation "Inbox" does not exist');
    const unreadable = await refusalOf(failingService(await memoryService(), { query: missing }));
    expect(unreadable.reason).toBe('entity-unavailable');
    expect(unreadable.cause).toBe(missing);
    const other = { code: 'weird' };
    expect((await refusalOf(failingService(await memoryService(), { firstCreate: other }))).reason)
      .toBe('entity-unavailable');
  });

  it('a cause whose code getter throws is not a MongoDB refusal', async () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    expect(
      (await refusalOf(failingService(await memoryService(), { firstCreate: hostile }))).reason,
    )
      .toBe('entity-unavailable');
  });

  it('skips the adapter-type check for an IDatabaseService that is not DatabaseService', async () => {
    const inner = await memoryService();
    const own: IDatabaseService = {
      getRepository: (e) => inner.getRepository(e),
      transaction: (work) => inner.transaction(work),
      query: (sql, params) => inner.query(sql, params),
      migrate: () => inner.migrate(),
      isHealthy: () => inner.isHealthy(),
      close: () => inner.close(),
    };
    expect(adapterInfoOf(own)).toBeUndefined();
    expect(adapterInfoOf(inner)?.type).toBe('memory');
    await new DatabaseInboxStore(own, ENTITY, () => 'p').verify();
  });
});

describe('createDatabaseInboxStore', () => {
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
    await createDatabaseInboxStore()(registry('database', service)).verify();
    await createDatabaseInboxStore({ database: 'default' })(registry('database', service)).verify();
    await createDatabaseInboxStore({ database: 'billing' })(registry('database.billing', service))
      .verify();
    expect(() => createDatabaseInboxStore({ database: 'billing' })(registry('database', service)))
      .toThrow('missing database.billing');
  });

  it('writes to the configured entity', async () => {
    const service = await memoryService();
    const store = createDatabaseInboxStore({ entity: 'Received' })(registry('database', service));
    await store.park({
      id: 'x'.repeat(64),
      kind: 'setu-inbox',
      consumer: 'c',
      topic: 't',
      status: 'parked',
      attempts: 1,
      updatedAt: 1,
    });
    expect(await service.getRepository('Received').findAll()).toHaveLength(1);
  });

  it('refuses an empty entity at the call', () => {
    expect(() => createDatabaseInboxStore({ entity: '  ' })).toThrow(TypeError);
  });
});
