/**
 * The tier-C idempotency store's startup check (M109b §3.6, §3.7): Cosmos DB
 * and Bigtable refused by adapter type and by adapter class, the wrapped
 * two-create probe that always rolls back, and each refusal reason decided
 * from the adapter's real error class (and the MongoDB code-20 shape measured
 * against a real standalone server, M107).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BigtableAdapter } from '../../../src/adapters/bigtable/bigtable-adapter.ts';
import { CosmosAdapter } from '../../../src/adapters/cosmos/cosmos-adapter.ts';
import type { IDatabaseService } from '../../../src/interfaces/index.ts';
import { TransactionalStoreUnavailableError } from '../../../src/idempotency/errors.ts';
import { MemoryAdapter } from '../../../src/index.ts';
import { DatabaseService } from '../../../src/services/database-service.ts';
import { allRows, ENTITY, memoryService, storeOver } from '../../fixtures/idempotency-store.ts';

/** The error the real `mongodb` driver raises inside a transaction on a standalone server. */
function mongoStandaloneError(): Error {
  const error = new Error(
    'Transaction numbers are only allowed on a replica set member or mongos',
  );
  error.name = 'MongoServerError';
  Object.assign(error, { code: 20, codeName: 'IllegalOperation' });
  return error;
}

/** A service whose probe transaction can be made to reject. */
function failingService(inner: IDatabaseService, probe: unknown): IDatabaseService {
  return { ...inner, transaction: () => Promise.reject(probe) };
}

/** Runs `verify()` and returns its rejection. */
async function refusalOf(service: IDatabaseService): Promise<TransactionalStoreUnavailableError> {
  const verifying = storeOver(service).verify();
  expect(verifying).toBeInstanceOf(Promise);
  const error = await verifying.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TransactionalStoreUnavailableError);
  return error as TransactionalStoreUnavailableError;
}

describe('DatabaseIdempotencyStore.verify', () => {
  it('passes on the memory adapter and leaves no probe row behind', async () => {
    const service = await memoryService();
    await storeOver(service).verify();
    expect(await allRows(service)).toEqual([]);
  });

  it('refuses Cosmos DB and Bigtable by adapter type, with no cause', async () => {
    const cosmos = await refusalOf(await memoryService('cosmos'));
    expect(cosmos.reason).toBe('cosmos-unsupported');
    expect(cosmos.cause).toBeUndefined();
    expect(cosmos.entity).toBe(ENTITY);
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
      const adapter = Object.create(prototype) as CosmosAdapter;
      const service = new DatabaseService(adapter, (e) => memory.createDataSource(e), 'custom');
      expect((await refusalOf(service)).reason).toBe(reason);
    }
  });

  it('refuses a standalone MongoDB through the probe, through a wrapped cause too', async () => {
    const raw = mongoStandaloneError();
    const direct = await refusalOf(failingService(await memoryService(), raw));
    expect(direct.reason).toBe('mongodb-standalone');
    expect(direct.cause).toBe(raw);
    const wrapped = new Error('wrapped', { cause: raw });
    expect((await refusalOf(failingService(await memoryService(), wrapped))).reason).toBe(
      'mongodb-standalone',
    );
  });

  it('reads any other probe refusal as an unavailable entity', async () => {
    const cause = new Error('relation "Idempotency" does not exist');
    const error = await refusalOf(failingService(await memoryService(), cause));
    expect(error.reason).toBe('entity-unavailable');
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('relation');
    const other = { code: 'weird' };
    expect((await refusalOf(failingService(await memoryService(), other))).reason).toBe(
      'entity-unavailable',
    );
  });

  it('a cause whose code getter throws is not a MongoDB refusal', async () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    expect((await refusalOf(failingService(await memoryService(), hostile))).reason).toBe(
      'entity-unavailable',
    );
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
    await storeOver(own).verify();
    expect(await allRows(inner)).toEqual([]);
  });
});
