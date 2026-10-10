/**
 * The outbox bridge's startup check (M107 §3.4) and its factory: the two
 * queries `verify()` runs, each refusal reason decided from the adapter's real
 * error class (and the MongoDB code-20 shape measured against a real
 * standalone server), the adapter error kept as `cause`, and every refusal a
 * rejected promise.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES, OUTBOX_RECORD_KIND } from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../../src/errors.ts';
import { DatabaseService, MemoryAdapter } from '../../../src/index.ts';
import type { FindOptions, IDatabaseService } from '../../../src/interfaces/index.ts';
import {
  createDatabaseOutboxStore,
  DatabaseOutboxStore,
} from '../../../src/outbox/database-outbox-store.ts';
import { OutboxStoreUnavailableError } from '../../../src/outbox/errors.ts';
import { ENTITY, memoryService, record, recordingService } from '../../fixtures/outbox-store.ts';

/**
 * The error the real `mongodb` driver raises inside a transaction on a
 * standalone server — measured through `DatabaseService.transaction`
 * (M107): a `MongoServerError`, unwrapped, `code: 20`,
 * `codeName: 'IllegalOperation'`.
 */
function mongoStandaloneError(): Error {
  const error = new Error(
    'Transaction numbers are only allowed on a replica set member or mongos',
  );
  error.name = 'MongoServerError';
  Object.assign(error, { code: 20, codeName: 'IllegalOperation' });
  return error;
}

/**
 * A service whose relay query (step 1) and transactional probe (step 2) can
 * each be made to reject.
 */
function failingService(
  inner: IDatabaseService,
  failures: { scan?: unknown; probe?: unknown },
): IDatabaseService {
  return {
    ...inner,
    // Only `findAll` is reached by `verify()`: the spread keeps the type, and
    // the one method the store calls is supplied explicitly.
    getRepository: <E, Id extends EntityKey = string>(entity: string) => {
      const repo = inner.getRepository<E, Id>(entity);
      return {
        ...repo,
        findAll: (options?: FindOptions) =>
          failures.scan === undefined ? repo.findAll(options) : Promise.reject(failures.scan),
      };
    },
    transaction: (work) =>
      failures.probe === undefined ? inner.transaction(work) : Promise.reject(failures.probe),
  };
}

/** Runs `verify()` and returns its rejection. */
async function refusalOf(service: IDatabaseService): Promise<OutboxStoreUnavailableError> {
  const verifying = new DatabaseOutboxStore(service, ENTITY).verify();
  expect(verifying).toBeInstanceOf(Promise);
  const error = await verifying.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OutboxStoreUnavailableError);
  return error as OutboxStoreUnavailableError;
}

describe('DatabaseOutboxStore.verify', () => {
  it('refuses a source without conditional writes by name before any transition', async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const source = adapter.createDataSource(ENTITY);
    delete source.updateWhere;
    delete source.deleteWhere;
    const service = new DatabaseService(adapter, () => source, 'memory');
    const error = await refusalOf(service);
    expect(error.reason).toBe('conditional-writes-unsupported');
    const store = new DatabaseOutboxStore(service, ENTITY);
    for (
      const transition of [
        store.claim('nope', { claimVersion: 0, leaseUntil: 1 }),
        store.markSent('nope', { claimVersion: 0, settledAt: 1, sentBy: 'r', deleteNow: true }),
      ]
    ) {
      await expect(transition).rejects.toMatchObject({ reason: 'conditional-writes-unsupported' });
    }
  });

  for (const missing of ['updateWhere', 'deleteWhere'] as const) {
    it(`refuses a source lacking only ${missing}, before any row is published`, async () => {
      // The two members are independent optional capabilities. Without
      // `deleteWhere`, a `retainSentMs: 0` relay would publish a row and then
      // fail to delete it, leaving it pending to be published again.
      const adapter = new MemoryAdapter();
      await adapter.connect();
      const source = adapter.createDataSource(ENTITY);
      delete source[missing];
      const service = new DatabaseService(adapter, () => source, 'memory');
      const error = await refusalOf(service);
      expect(error.reason).toBe('conditional-writes-unsupported');
    });
  }

  it('leaves a pending OUTBOX row appended under the probe id untouched', async () => {
    // `append` accepts any id, so a caller can store a real pending row under
    // the probe id. A probe predicate of version 0 would claim it (0 → 1) and
    // its delete would then miss; version -1 matches no row a store can hold.
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await service.transaction((uow) =>
      store.append(uow, record(1, { id: 'setu-outbox-claim-probe' }))
    );
    const before = await service.getRepository(ENTITY).findAll();
    await store.verify();
    expect(await service.getRepository(ENTITY).findAll()).toEqual(before);
    expect(before[0]).toMatchObject({ id: 'setu-outbox-claim-probe', claimVersion: 0 });
  });

  it('the capability probe changes neither outbox rows nor a business row at the probe id', async () => {
    const service = await memoryService();
    const repo = service.getRepository(ENTITY);
    await repo.create({ ...record(1) });
    await repo.create({
      id: 'setu-outbox-claim-probe',
      kind: 'business',
      status: 'pending',
      claimVersion: 0,
    });
    const before = await repo.findAll();
    await new DatabaseOutboxStore(service, ENTITY).verify();
    expect(await repo.findAll()).toEqual(before);
  });
  it('passes on the memory adapter, after the relay query and a transactional probe', async () => {
    const { service, calls } = recordingService(await memoryService());

    await new DatabaseOutboxStore(service, ENTITY).verify();

    expect(calls).toEqual([
      {
        method: 'findAll',
        args: [{
          where: { kind: OUTBOX_RECORD_KIND, status: 'pending' },
          orderBy: { position: 'asc' },
          limit: 1,
        }],
      },
      { method: 'transaction', args: [] },
      {
        method: 'findAll',
        args: [{ where: { kind: OUTBOX_RECORD_KIND, status: 'pending' }, limit: 1 }],
      },
      {
        method: 'updateWhere',
        args: ['setu-outbox-claim-probe', {
          kind: OUTBOX_RECORD_KIND,
          status: 'pending',
          claimVersion: -1,
        }, { claimVersion: 0 }],
      },
      {
        method: 'deleteWhere',
        args: ['setu-outbox-claim-probe', {
          kind: OUTBOX_RECORD_KIND,
          status: 'pending',
          claimVersion: -1,
        }],
      },
    ]);
  });

  it('refuses Bigtable by name, whatever feature it refused', async () => {
    const cause = new UnsupportedQueryFeatureError('order-by', 'bigtable', 'no secondary index');
    const error = await refusalOf(failingService(await memoryService(), { scan: cause }));
    expect(error.reason).toBe('bigtable');
    expect(error.cause).toBe(cause);
    expect(error.entity).toBe(ENTITY);
    expect(error.message).toContain(`'${ENTITY}'`);
    expect(error.message).toContain('change-data-capture');
  });

  it('refuses DynamoDB without the status/position GSI, naming the index', async () => {
    const cause = new UnsupportedQueryFeatureError('orderBy', 'dynamodb', 'no access path');
    const error = await refusalOf(failingService(await memoryService(), { scan: cause }));
    expect(error.reason).toBe('dynamodb-index');
    expect(error.message).toContain("partitionKey: 'status', sortKey: 'position'");
  });

  it('reads another DynamoDB refusal as an unavailable entity', async () => {
    const cause = new UnsupportedQueryFeatureError('filter', 'dynamodb', 'nope');
    const error = await refusalOf(failingService(await memoryService(), { scan: cause }));
    expect(error.reason).toBe('entity-unavailable');
  });

  it('refuses a standalone MongoDB at the transactional probe with the replica-set reason', async () => {
    const cause = mongoStandaloneError();
    const error = await refusalOf(failingService(await memoryService(), { probe: cause }));
    expect(error.reason).toBe('mongodb-replica-set');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('replica set');
  });

  it('finds the MongoDB refusal deeper in the cause chain', async () => {
    const wrapped = new Error('wrapper', {
      cause: new Error('mid', { cause: mongoStandaloneError() }),
    });
    const error = await refusalOf(failingService(await memoryService(), { probe: wrapped }));
    expect(error.reason).toBe('mongodb-replica-set');
  });

  it('does not read code 20 without codeName IllegalOperation as the replica-set refusal', async () => {
    const cause = Object.assign(new Error('other'), { code: 20 });
    const error = await refusalOf(failingService(await memoryService(), { probe: cause }));
    expect(error.reason).toBe('entity-unavailable');
  });

  it('survives a cause whose code getter throws', async () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    const error = await refusalOf(failingService(await memoryService(), { probe: hostile }));
    expect(error.reason).toBe('entity-unavailable');
  });

  it('reads any other refusal as a missing or unreadable entity', async () => {
    const cause = new Error('relation "outbox" does not exist');
    const error = await refusalOf(failingService(await memoryService(), { scan: cause }));
    expect(error.reason).toBe('entity-unavailable');
    expect(error.message).toContain('missing or unreadable');
    expect(error.message).not.toContain('relation');
  });
});

describe('createDatabaseOutboxStore', () => {
  /** A registry answering one token; any other read throws, as the kernel's does. */
  function registry(token: string, service: IDatabaseService): IServiceRegistry & {
    asked: string[];
  } {
    const asked: string[] = [];
    return {
      asked,
      get: <T>(requested: string): T => {
        asked.push(requested);
        if (requested !== token) throw new Error(`no capability '${requested}'`);
        return service as T;
      },
    } as unknown as IServiceRegistry & { asked: string[] };
  }

  it('resolves CAPABILITIES.DATABASE and the default Outbox entity', async () => {
    const service = await memoryService();
    const services = registry(CAPABILITIES.DATABASE, service);

    const store = createDatabaseOutboxStore()(services);
    await service.transaction((uow) => store.append(uow, record(1, { status: 'failed' })));
    // The default entity is 'Outbox': read it back without the bridge.
    expect((await service.getRepository('Outbox').findAll()).length).toBe(1);

    expect(services.asked).toEqual([CAPABILITIES.DATABASE]);
    expect(await store.failedKeys(10)).toEqual([{}]);
  });

  it("treats database 'default' as CAPABILITIES.DATABASE", () => {
    const services = registry(CAPABILITIES.DATABASE, {} as IDatabaseService);
    createDatabaseOutboxStore({ database: 'default' })(services);
    expect(services.asked).toEqual([CAPABILITIES.DATABASE]);
  });

  it('resolves database.<name> and the configured entity', async () => {
    const service = await memoryService();
    const services = registry('database.analytics', service);

    const store = createDatabaseOutboxStore({ database: 'analytics', entity: 'Events' })(services);
    await service.transaction((uow) => store.append(uow, record(1, { status: 'failed' })));
    expect((await service.getRepository('Events').findAll()).length).toBe(1);

    expect(services.asked).toEqual(['database.analytics']);
    expect((await store.failedKeys(10)).length).toBe(1);
  });

  it('refuses an empty entity at the call', () => {
    expect(() => createDatabaseOutboxStore({ entity: '  ' })).toThrow(TypeError);
    expect(() => createDatabaseOutboxStore({ entity: '' })).toThrow('entity');
  });

  it('refuses an illegal database name at the call', () => {
    expect(() => createDatabaseOutboxStore({ database: 'Bad:Name' })).toThrow(TypeError);
  });
});
