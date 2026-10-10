/**
 * The shared backend probe (M109b §3.6, §11.1): the adapter-class checks, the
 * MongoDB code-20 recognition, and the rolled-back two-create transaction —
 * exercised directly, so the primitives M107's, M108's and M109b's stores
 * share have one test home.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BigtableAdapter } from '../../../src/adapters/bigtable/bigtable-adapter.ts';
import { CosmosAdapter } from '../../../src/adapters/cosmos/cosmos-adapter.ts';
import type { IDatabaseService } from '../../../src/interfaces/index.ts';
import { DatabaseService, MemoryAdapter } from '../../../src/index.ts';
import {
  isBigtableBackend,
  isCosmosBackend,
  isMongoReplicaSetRefusal,
  MONGO_ILLEGAL_OPERATION,
  ProbeRollback,
  probeTwoCreateTransaction,
} from '../../../src/transactional/backend-probe.ts';
import { IDEMPOTENCY_RECORD_KIND } from '@setu-ts/common';
import { allRows, ENTITY, memoryService } from '../../fixtures/idempotency-store.ts';

/** The error the real `mongodb` driver raises inside a transaction on a standalone server. */
function mongoStandaloneError(): Error {
  const error = new Error('Transaction numbers are only allowed on a replica set member or mongos');
  Object.assign(error, { code: MONGO_ILLEGAL_OPERATION, codeName: 'IllegalOperation' });
  return error;
}

describe('backend-probe adapter checks (M109b §3.6)', () => {
  it('recognises Cosmos and Bigtable by adapter arm', async () => {
    const cosmos = await memoryService('cosmos');
    expect(isCosmosBackend(cosmos)).toBe(true);
    expect(isBigtableBackend(cosmos)).toBe(false);
    const bigtable = await memoryService('bigtable');
    expect(isBigtableBackend(bigtable)).toBe(true);
    expect(isCosmosBackend(bigtable)).toBe(false);
    const memory = await memoryService();
    expect(isCosmosBackend(memory)).toBe(false);
    expect(isBigtableBackend(memory)).toBe(false);
  });

  it('recognises a shipped adapter handed to the custom arm, by class', async () => {
    const memory = new MemoryAdapter();
    await memory.connect();
    const cosmos = new DatabaseService(
      Object.create(CosmosAdapter.prototype) as CosmosAdapter,
      (e) => memory.createDataSource(e),
      'custom',
    );
    expect(isCosmosBackend(cosmos)).toBe(true);
    const bigtable = new DatabaseService(
      Object.create(BigtableAdapter.prototype) as BigtableAdapter,
      (e) => memory.createDataSource(e),
      'custom',
    );
    expect(isBigtableBackend(bigtable)).toBe(true);
  });

  it('is false for an IDatabaseService this package did not build', async () => {
    const inner = await memoryService();
    const own: IDatabaseService = {
      getRepository: (e) => inner.getRepository(e),
      transaction: (work) => inner.transaction(work),
      query: (sql, params) => inner.query(sql, params),
      migrate: () => inner.migrate(),
      isHealthy: () => inner.isHealthy(),
      close: () => inner.close(),
    };
    expect(isCosmosBackend(own)).toBe(false);
    expect(isBigtableBackend(own)).toBe(false);
  });
});

describe('isMongoReplicaSetRefusal (M109b §3.6)', () => {
  it('accepts only code 20 with codeName IllegalOperation', () => {
    expect(isMongoReplicaSetRefusal(mongoStandaloneError())).toBe(true);
    expect(isMongoReplicaSetRefusal(Object.assign(new Error('x'), { code: 20 }))).toBe(false);
    expect(isMongoReplicaSetRefusal({ code: 20, codeName: 'Other' })).toBe(false);
    expect(isMongoReplicaSetRefusal({})).toBe(false);
  });

  it('treats a throwing code getter as not the refusal', () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    expect(isMongoReplicaSetRefusal(hostile)).toBe(false);
  });
});

describe('probeTwoCreateTransaction (M109b §3.6)', () => {
  it('creates the rows in one transaction, rolls back, and rethrows the rollback', async () => {
    const service = await memoryService();
    const rollback = new ProbeRollback('test probe');
    await expect(
      probeTwoCreateTransaction(
        service,
        ENTITY,
        [
          { id: 'p-1', kind: IDEMPOTENCY_RECORD_KIND, role: 'claim', result: null },
          { id: 'p-1.r', kind: IDEMPOTENCY_RECORD_KIND, role: 'result', result: '{}' },
        ],
        rollback,
      ),
    ).rejects.toBe(rollback);
    expect(await allRows(service)).toEqual([]);
  });

  it('propagates the backend refusal when the transaction rejects', async () => {
    const inner = await memoryService();
    const cause = new Error('one row per transaction');
    const service: IDatabaseService = { ...inner, transaction: () => Promise.reject(cause) };
    await expect(
      probeTwoCreateTransaction(
        service,
        ENTITY,
        [
          { id: 'p-1' },
          { id: 'p-1.r' },
        ],
        new ProbeRollback('test probe'),
      ),
    ).rejects.toBe(cause);
  });

  it('names the rollback error', () => {
    expect(new ProbeRollback('why').name).toBe('ProbeRollback');
    expect(new ProbeRollback('why').message).toBe('why');
  });
});
