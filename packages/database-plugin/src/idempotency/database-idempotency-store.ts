/**
 * The tier-C idempotency store bridge over `IDatabaseService` (M109b).
 *
 * `ITransactionalIdempotencyStore` is declared in `@setu-ts/common` so this
 * package can implement it by name without importing
 * `@setu-ts/idempotency-plugin` (AI_GUIDELINES §2.2) — the M107/M108 shape.
 * The idempotency plugin resolves the factory in `onInit`, verifies it, and
 * runs every `within` through it; it never resolves `CAPABILITIES.DATABASE`
 * itself.
 *
 * **Two rows, creates only.** `run` opens ONE transaction, creates the CLAIM
 * row in it FIRST, runs the work, then creates the RESULT row holding the
 * work's encoded result, and commits. Only creates — no update and no delete —
 * so every supported backend can perform it: DynamoDB and D1 have no
 * read-your-own-writes inside a transaction (an in-transaction `update` reads
 * committed state and throws; DynamoDB's buffer refuses two operations on one
 * item). The claim's primary key is still the race's arbitration point, so a
 * concurrent duplicate loses it and its business writes roll back.
 *
 * **The discriminator is one rule on every backend.** Every row carries
 * `kind: 'setu-idempotency'` and a `role` (`claim` or `result`); `find` reads
 * both rows by id and requires both, and `purge` lists claims only, so a
 * business document that shares the entity is never read or purged as ours.
 *
 * @module
 */
import type {
  EntityKey,
  IRuntimeServices,
  IServiceRegistry,
  ITransactionalIdempotencyStore,
  RegistryFactory,
  TransactionalIdempotencyClaim,
  TransactionalIdempotencyRecord,
} from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, IDEMPOTENCY_RECORD_KIND } from '@setu-ts/common';
import { causeChain } from '../errors/classify.ts';
import type { IDatabaseService, IRepository } from '../interfaces/index.ts';
import {
  isBigtableBackend,
  isCosmosBackend,
  isMongoReplicaSetRefusal,
  ProbeRollback,
  probeTwoCreateTransaction,
} from '../transactional/backend-probe.ts';
import { TransactionalStoreUnavailableError } from './errors.ts';

/**
 * Options for {@linkcode createDatabaseIdempotencyStore}.
 *
 * @since 0.9.0
 */
export interface DatabaseIdempotencyStoreOptions {
  /** The idempotency entity (table or collection). Default `'Idempotency'`. */
  readonly entity?: string;
  /**
   * The named database connection to use — `DatabasePlugin({ name })`, so the
   * store resolves `database.<name>`. Omitted (or `'default'`) resolves
   * `CAPABILITIES.DATABASE`. It must be the database the work writes to: the
   * record is created in that database's transaction, and work writing
   * elsewhere gets no all-or-nothing guarantee.
   */
  readonly database?: string;
}

/** The default idempotency entity. */
const DEFAULT_ENTITY = 'Idempotency';

/** The claim row's role. */
const CLAIM_ROLE = 'claim';

/** The result row's role. */
const RESULT_ROLE = 'result';

/** The suffix of a claim's result row id. */
const RESULT_SUFFIX = '.r';

/** A row as the adapter hands it back. */
type Row = Record<string, unknown>;

/** A retention purge owns only complete records with the tier-C JSON envelope. */
function isResultEnvelope(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'v');
}

/** The claim row for a claim. */
function claimRow(claim: TransactionalIdempotencyClaim): Row {
  return {
    id: claim.id,
    kind: IDEMPOTENCY_RECORD_KIND,
    role: CLAIM_ROLE,
    fingerprint: claim.fingerprint,
    createdAt: claim.createdAt,
    expiresAt: claim.expiresAt,
    result: null,
  };
}

/** The result row for a claim and its encoded result. */
function resultRow(claim: TransactionalIdempotencyClaim, result: string): Row {
  return {
    id: `${claim.id}${RESULT_SUFFIX}`,
    kind: IDEMPOTENCY_RECORD_KIND,
    role: RESULT_ROLE,
    fingerprint: claim.fingerprint,
    createdAt: claim.createdAt,
    expiresAt: claim.expiresAt,
    result,
  };
}

/**
 * Decides why a backend cannot serve tier C from the refusal the probe met,
 * walking the bounded cause chain the driver classifier walks.
 */
function unavailableReason(error: unknown): TransactionalStoreUnavailableError['reason'] {
  for (const member of causeChain(error)) {
    if (isMongoReplicaSetRefusal(member)) return 'mongodb-standalone';
  }
  return 'entity-unavailable';
}

/**
 * The `ITransactionalIdempotencyStore` over `IDatabaseService`. Constructed by
 * {@linkcode createDatabaseIdempotencyStore}; internal, so the two-row layout
 * and the discriminator have one implementation.
 */
export class DatabaseIdempotencyStore implements ITransactionalIdempotencyStore {
  readonly #service: IDatabaseService;
  readonly #entity: string;
  readonly #uuid: () => string;

  /**
   * Binds the store to the database service and entity it reads and writes.
   *
   * @param service - The database service the work writes through
   * @param entity - The idempotency entity
   * @param uuid - The id source for the startup probe's rows
   */
  constructor(service: IDatabaseService, entity: string, uuid: () => string) {
    this.#service = service;
    this.#entity = entity;
    this.#uuid = uuid;
  }

  /** The repository over the idempotency entity, outside any transaction. */
  #repo(): IRepository<Row, EntityKey> {
    return this.#service.getRepository<Row, EntityKey>(this.#entity);
  }

  /** Reads one of a key's rows by id; a row of another `kind` or `role` is missing. */
  async #row(id: string, role: string): Promise<Row | null> {
    const row = await this.#repo().findById(id);
    if (row === null || row.kind !== IDEMPOTENCY_RECORD_KIND) return null;
    if (row.role !== role) return null;
    return row;
  }

  /** @inheritdoc */
  async find(id: string): Promise<TransactionalIdempotencyRecord | undefined> {
    const claim = await this.#row(id, CLAIM_ROLE);
    if (claim === null) return undefined;
    const result = await this.#row(`${id}${RESULT_SUFFIX}`, RESULT_ROLE);
    if (result === null) return undefined;
    return {
      id,
      fingerprint: String(result.fingerprint),
      result: String(result.result),
      createdAt: Number(result.createdAt),
      expiresAt: Number(result.expiresAt),
    };
  }

  /** @inheritdoc */
  run<R>(
    claim: TransactionalIdempotencyClaim,
    work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
  ): Promise<R> {
    return this.#service.transaction(async (uow) => {
      const repo = uow.getRepository<Row, EntityKey>(this.#entity);
      await repo.create(claimRow(claim));
      const outcome = await work(uow);
      await repo.create(resultRow(claim, outcome.result));
      return outcome.value;
    });
  }

  /** @inheritdoc */
  async purge(before: number, limit: number): Promise<number> {
    const repo = this.#repo();
    const rows = await repo.findAll({
      where: { kind: IDEMPOTENCY_RECORD_KIND, role: CLAIM_ROLE },
      filter: { type: 'comparison', field: 'expiresAt', operator: 'lt', value: before },
      select: ['id'],
      limit,
    });
    let deleted = 0;
    for (const row of rows) {
      const id = String(row.id);
      // An orphan or tampered result is not a record the purge owns (§10 O4).
      const record = await this.find(id);
      if (record === undefined || !isResultEnvelope(record.result)) continue;
      await repo.delete(id as EntityKey);
      await repo.delete(`${id}${RESULT_SUFFIX}` as EntityKey);
      deleted += 1;
    }
    return deleted;
  }

  /**
   * Refuses Cosmos DB and Bigtable by adapter arm or class, then runs a
   * transactional probe that writes a claim and a result row and always rolls
   * back — refusing the backend by name when it rejects.
   *
   * Nothing the probe writes survives: the transaction is rolled back, and the
   * deferred backends send nothing.
   *
   * @inheritdoc
   */
  async verify(): Promise<void> {
    // By arm, and by class for a shipped adapter handed to the `'custom'` arm.
    if (isCosmosBackend(this.#service)) {
      throw new TransactionalStoreUnavailableError(this.#entity, 'cosmos-unsupported');
    }
    if (isBigtableBackend(this.#service)) {
      throw new TransactionalStoreUnavailableError(this.#entity, 'bigtable-unsupported');
    }
    const rollback = new ProbeRollback('idempotency startup probe');
    try {
      const claim: TransactionalIdempotencyClaim = {
        id: `setu-idempotency-probe-${this.#uuid()}`,
        fingerprint: '0'.repeat(64),
        createdAt: 0,
        expiresAt: 0,
      };
      await probeTwoCreateTransaction(
        this.#service,
        this.#entity,
        [claimRow(claim), resultRow(claim, '{"v":null}')],
        rollback,
      );
    } catch (error) {
      if (error === rollback) return;
      throw new TransactionalStoreUnavailableError(this.#entity, unavailableReason(error), {
        cause: error,
      });
    }
  }
}

/**
 * Builds the tier-C idempotency store bridge as a {@linkcode RegistryFactory},
 * for the idempotency plugin's `transactional.store` option.
 *
 * The factory resolves `CAPABILITIES.DATABASE` (or `database.<name>`) from the
 * registry it is handed — typed as `IDatabaseService`, the token's documented
 * interface — and returns an `ITransactionalIdempotencyStore` over it. The
 * idempotency plugin resolves it in `onInit`, so `DatabasePlugin` may be
 * registered before or after, and runs `verify()` there.
 *
 * **Per backend.** Memory, Prisma, Drizzle (with the idempotency table in
 * `drizzleTables`), D1, a MongoDB replica set and DynamoDB are supported.
 * `verify()` refuses Cosmos DB, Bigtable, a standalone MongoDB and a missing
 * or unreadable entity, each by name with a
 * {@linkcode TransactionalStoreUnavailableError}.
 *
 * @param options - The idempotency entity and the database connection
 * @returns A factory the idempotency plugin resolves in `onInit`
 * @throws {TypeError} When `entity` is empty — at the call, before any
 *   application starts
 *
 * @example
 * ```typescript
 * import { createDatabaseIdempotencyStore, DatabasePlugin } from '@setu-ts/database-plugin';
 * import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'memory' }),
 *     IdempotencyPlugin({ transactional: { store: createDatabaseIdempotencyStore() } }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseIdempotencyStore(
  options?: DatabaseIdempotencyStoreOptions,
): RegistryFactory<ITransactionalIdempotencyStore> {
  const entity = options?.entity ?? DEFAULT_ENTITY;
  if (typeof entity !== 'string' || entity.trim() === '') {
    throw new TypeError('createDatabaseIdempotencyStore: entity must be a non-empty string');
  }
  const database = options?.database;
  const token = database === undefined || database === 'default'
    ? CAPABILITIES.DATABASE
    : createCapabilityToken(`database.${database}`);
  return (services: IServiceRegistry): ITransactionalIdempotencyStore => {
    const runtime = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return new DatabaseIdempotencyStore(
      services.get<IDatabaseService>(token),
      entity,
      () => runtime.uuid(),
    );
  };
}
