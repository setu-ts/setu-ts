/**
 * The outbox store bridge over `IDatabaseService` (M107).
 *
 * `IOutboxStore` is declared in `@setu-ts/common` so this package can
 * implement it by name without importing `@setu-ts/messaging-plugin`
 * (AI_GUIDELINES §2.2) — the M101c `createDatabaseTenantDataStore` shape. The
 * messaging plugin's outbox resolves the factory in `onInit` and writes and
 * relays through it; it never resolves `CAPABILITIES.DATABASE` itself.
 *
 * **The discriminator is one rule on every backend.** Every row carries
 * `kind: 'setu-outbox'`, every read conjoins it to its `where`, and a lookup
 * by id treats a row whose `kind` differs as missing. An outbox that shares an
 * entity with business data — a Cosmos container is queried as a whole — never
 * reads, counts, transitions or deletes a business document that happens to
 * carry `status: 'pending'` or `'sent'`.
 *
 * **Transitions are conditional, as two calls.** Each reads the row and writes
 * only from the expected status, so a late failure can never regress a `sent`
 * row. `IRepository` has no conditional write, so between the read and the
 * write another relay can change the row; the worst outcome is one stale
 * overwrite (a duplicate publish, never a loss). Closing the window needs the
 * conditional write ROADMAP Milestone 105 owns.
 *
 * **Absent optional columns are written as `null`** and read back as absent.
 * A SQL column has no "absent" state, and the memory adapter refuses a
 * `select` naming a column no stored row carries — so `failedKeys`, which
 * selects `tenantId` and `orderingKey` only, would fail on an outbox whose rows
 * never carried a tenant.
 *
 * @module
 */
import type {
  EntityKey,
  IOutboxStore,
  IOutboxWriteScope,
  IServiceRegistry,
  OutboxKey,
  OutboxRecord,
  OutboxStatus,
  OutboxStoreStats,
  OutboxTransition,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, OUTBOX_RECORD_KIND } from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../errors.ts';
import { causeChain } from '../errors/classify.ts';
import type { IDatabaseService, IRepository } from '../interfaces/index.ts';
import { OutboxStoreUnavailableError } from './errors.ts';

/**
 * Options for {@linkcode createDatabaseOutboxStore}.
 *
 * @since 0.9.0
 */
export interface DatabaseOutboxStoreOptions {
  /** The outbox entity (table, collection or container). Default `'Outbox'`. */
  readonly entity?: string;
  /**
   * The named database connection to use — `DatabasePlugin({ name })`, so the
   * store resolves `database.<name>`. Omitted (or `'default'`) resolves
   * `CAPABILITIES.DATABASE`. It must be the database the caller's unit of work
   * belongs to: a row written through another database's unit of work is never
   * relayed by this store.
   */
  readonly database?: string;
}

/** The default outbox entity. */
const DEFAULT_ENTITY = 'Outbox';

/** The record fields every row carries. */
const REQUIRED_FIELDS = [
  'id',
  'kind',
  'topic',
  'envelope',
  'options',
  'position',
  'createdAt',
  'status',
  'attempts',
  'availableAt',
] as const;

/** The optional record fields: written as `null` when absent, read back as absent. */
const OPTIONAL_FIELDS = [
  'orderingKey',
  'tenantId',
  'traceparent',
  'lastError',
  'settledAt',
  'sentBy',
] as const;

/** The four statuses a row may carry. */
const STATUSES: ReadonlySet<string> = new Set<OutboxStatus>([
  'pending',
  'sent',
  'failed',
  'discarded',
]);

/** MongoDB's server code for "transactions need a replica set". */
const MONGO_ILLEGAL_OPERATION = 20;

/** A row as the adapter hands it back. */
type Row = Record<string, unknown>;

/**
 * The row an outbox record is written as: every field, with each absent
 * optional field as `null`.
 */
function toRow(record: OutboxRecord): Row {
  const row: Row = { ...record, kind: OUTBOX_RECORD_KIND };
  for (const field of OPTIONAL_FIELDS) {
    if (row[field] === undefined) row[field] = null;
  }
  return row;
}

/**
 * The record a stored row reads back as: only the record's own fields (an
 * adapter's system columns are dropped), with a `null` or missing optional
 * field omitted. Values are passed through as stored — the relay decodes and
 * refuses a malformed row by itself, which needs the row's id to mark it.
 */
function fromRow(row: Row): OutboxRecord {
  const record: Row = {};
  for (const field of REQUIRED_FIELDS) record[field] = row[field];
  for (const field of OPTIONAL_FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined) record[field] = value;
  }
  return record as unknown as OutboxRecord;
}

/** The status a fetched row carries, refused when it is outside the vocabulary. */
function statusOf(row: Row, id: string): OutboxStatus {
  const status = row.status;
  if (typeof status === 'string' && STATUSES.has(status)) return status as OutboxStatus;
  // The stored value is not quoted: a row may have been edited by anyone with
  // write access to the table.
  throw new TypeError(`Outbox row '${id}' carries an unrecognized status`);
}

/**
 * Decides why a backend cannot serve the outbox from the refusal `verify()`
 * met, walking the bounded cause chain the driver classifier walks.
 */
function unavailableReason(error: unknown): OutboxStoreUnavailableError['reason'] {
  const chain = causeChain(error);
  for (const member of chain) {
    if (member instanceof UnsupportedQueryFeatureError) {
      if (member.adapter === 'bigtable') return 'bigtable';
      if (member.adapter === 'dynamodb' && member.feature === 'orderBy') return 'dynamodb-index';
    }
  }
  for (const member of chain) {
    if (isMongoReplicaSetRefusal(member)) return 'mongodb-replica-set';
  }
  return 'entity-unavailable';
}

/**
 * Whether one error is the server's measured standalone refusal: code `20`,
 * `codeName: 'IllegalOperation'` ("Transaction numbers are only allowed on a
 * replica set member or mongos"). Read guarded, since a cause is foreign.
 */
function isMongoReplicaSetRefusal(member: object): boolean {
  try {
    const candidate = member as { code?: unknown; codeName?: unknown };
    return candidate.code === MONGO_ILLEGAL_OPERATION &&
      candidate.codeName === 'IllegalOperation';
  } catch {
    return false;
  }
}

/**
 * The `IOutboxStore` over `IDatabaseService`. Constructed by
 * {@linkcode createDatabaseOutboxStore}; internal, so the column mapping and
 * the discriminator have one implementation.
 */
export class DatabaseOutboxStore implements IOutboxStore {
  readonly #service: IDatabaseService;
  readonly #entity: string;

  /**
   * Binds the store to the database service and entity it reads and writes.
   *
   * @param service - The database service the relay reads and transitions through
   * @param entity - The outbox entity
   */
  constructor(service: IDatabaseService, entity: string) {
    this.#service = service;
    this.#entity = entity;
  }

  /** The repository over the outbox entity, outside any transaction. */
  #repo(): IRepository<Row, EntityKey> {
    return this.#service.getRepository<Row, EntityKey>(this.#entity);
  }

  /** The `where` every read carries: the discriminator and one status. */
  #where(status: OutboxStatus): Row {
    return { kind: OUTBOX_RECORD_KIND, status };
  }

  /**
   * Reads an outbox row by id; a row of another `kind` is missing.
   */
  async #find(id: string): Promise<Row | null> {
    const row = await this.#repo().findById(id);
    if (row === null || row.kind !== OUTBOX_RECORD_KIND) return null;
    return row;
  }

  /** @inheritdoc */
  async append(scope: IOutboxWriteScope, record: OutboxRecord): Promise<void> {
    await scope.getRepository(this.#entity).create(toRow(record));
  }

  /** @inheritdoc */
  async scanPending(after: string | undefined, limit: number): Promise<readonly OutboxRecord[]> {
    const rows = await this.#repo().findAll({
      where: this.#where('pending'),
      ...(after === undefined
        ? {}
        : { filter: { type: 'comparison', field: 'position', operator: 'gt', value: after } }),
      orderBy: { position: 'asc' },
      limit,
    });
    return rows.map(fromRow);
  }

  /** @inheritdoc */
  async failedKeys(limit: number): Promise<readonly OutboxKey[]> {
    const rows = await this.#repo().findAll({
      where: this.#where('failed'),
      select: ['tenantId', 'orderingKey'],
      limit,
    });
    return rows.map((row) => {
      const key: { tenantId?: string; orderingKey?: string } = {};
      if (typeof row.tenantId === 'string') key.tenantId = row.tenantId;
      if (typeof row.orderingKey === 'string') key.orderingKey = row.orderingKey;
      return key;
    });
  }

  /** @inheritdoc */
  async markSent(
    id: string,
    update: { readonly settledAt: number; readonly sentBy: string; readonly deleteNow: boolean },
  ): Promise<OutboxTransition> {
    const row = await this.#find(id);
    if (row === null) return { outcome: 'missing' };
    const status = statusOf(row, id);
    if (status !== 'pending') return notPending(status, row);
    if (update.deleteNow) {
      return (await this.#repo().delete(id)) ? { outcome: 'applied' } : { outcome: 'missing' };
    }
    await this.#repo().update(id, {
      status: 'sent',
      settledAt: update.settledAt,
      sentBy: update.sentBy,
    });
    return { outcome: 'applied' };
  }

  /** @inheritdoc */
  async markFailure(
    id: string,
    update: {
      readonly attempts: number;
      readonly lastError: string;
      readonly availableAt: number;
      readonly status: 'pending' | 'failed';
    },
  ): Promise<OutboxTransition> {
    const row = await this.#find(id);
    if (row === null) return { outcome: 'missing' };
    const status = statusOf(row, id);
    if (status !== 'pending') return notPending(status, row);
    await this.#repo().update(id, {
      attempts: update.attempts,
      lastError: update.lastError,
      availableAt: update.availableAt,
      status: update.status,
    });
    return { outcome: 'applied' };
  }

  /** @inheritdoc */
  async release(id: string, action: 'retry' | 'discard', now: number): Promise<OutboxTransition> {
    const row = await this.#find(id);
    if (row === null) return { outcome: 'missing' };
    const status = statusOf(row, id);
    if (status !== 'failed') return { outcome: 'not-failed', status };
    await this.#repo().update(
      id,
      action === 'retry'
        ? { status: 'pending', attempts: 0, availableAt: now }
        : { status: 'discarded', settledAt: now },
    );
    return { outcome: 'applied' };
  }

  /** @inheritdoc */
  async stats(): Promise<OutboxStoreStats> {
    const repo = this.#repo();
    const pending = await repo.count({ where: this.#where('pending') });
    const failed = await repo.count({ where: this.#where('failed') });
    const [oldest] = await this.scanPending(undefined, 1);
    return oldest === undefined
      ? { pending, failed }
      : { pending, failed, oldestPendingCreatedAt: oldest.createdAt };
  }

  /** @inheritdoc */
  async purge(before: number, limit: number): Promise<number> {
    const repo = this.#repo();
    let deleted = 0;
    for (const status of ['sent', 'discarded'] as const) {
      const rows = await repo.findAll({
        where: this.#where(status),
        filter: { type: 'comparison', field: 'settledAt', operator: 'lt', value: before },
        select: ['id'],
        limit,
      });
      for (const row of rows) {
        if (await repo.delete(row.id as EntityKey)) deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * Runs the relay's first query and a transactional probe reading exactly
   * what the relay reads, refusing the backend by name when either rejects.
   *
   * On the memory adapter and MongoDB a missing entity cannot be detected —
   * both create lazily — so the first step passes there by construction.
   *
   * @inheritdoc
   */
  async verify(): Promise<void> {
    try {
      await this.scanPending(undefined, 1);
      await this.#service.transaction((uow) =>
        uow.getRepository<Row, EntityKey>(this.#entity).findAll({
          where: this.#where('pending'),
          limit: 1,
        })
      );
    } catch (error) {
      throw new OutboxStoreUnavailableError(this.#entity, unavailableReason(error), {
        cause: error,
      });
    }
  }
}

/** The `not-pending` outcome, carrying `sentBy` when the row has one. */
function notPending(status: Exclude<OutboxStatus, 'pending'>, row: Row): OutboxTransition {
  return typeof row.sentBy === 'string'
    ? { outcome: 'not-pending', status, sentBy: row.sentBy }
    : { outcome: 'not-pending', status };
}

/**
 * Builds the outbox store bridge as a {@linkcode RegistryFactory}, for the
 * messaging plugin's `outbox.store` option.
 *
 * The factory resolves `CAPABILITIES.DATABASE` (or `database.<name>`) from the
 * registry it is handed — typed as `IDatabaseService`, the token's documented
 * interface — and returns an `IOutboxStore` over it. The messaging plugin
 * resolves it in `onInit`, so `DatabasePlugin` may be registered before or
 * after the messaging plugin, and runs `verify()` there.
 *
 * **Per backend.** Memory, Prisma, Drizzle (with the outbox table in
 * `drizzleTables`), D1, a MongoDB replica set, DynamoDB with a GSI
 * `{ partitionKey: 'status', sortKey: 'position' }` (projection `ALL`), and
 * Cosmos with the outbox entity mapped to the business container and a
 * partition-key path the row carries (`tenantId` or `orderingKey`) are
 * supported. `verify()` refuses Bigtable, a standalone MongoDB, a DynamoDB
 * entity without that GSI, and a missing or unreadable entity, each by name
 * with an {@linkcode OutboxStoreUnavailableError}.
 *
 * @param options - The outbox entity and the database connection
 * @returns A factory the messaging plugin resolves in `onInit`
 * @throws {TypeError} When `entity` is empty or `database` is not a legal
 *   connection name — at the call, before any application starts
 *
 * @example
 * ```typescript
 * import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
 * import { MessagingPlugin } from '@setu-ts/messaging-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'memory' }),
 *     MessagingPlugin({ outbox: { store: createDatabaseOutboxStore() } }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseOutboxStore(
  options?: DatabaseOutboxStoreOptions,
): RegistryFactory<IOutboxStore> {
  const entity = options?.entity ?? DEFAULT_ENTITY;
  if (typeof entity !== 'string' || entity.trim() === '') {
    throw new TypeError('createDatabaseOutboxStore: entity must be a non-empty string');
  }
  const database = options?.database;
  const token = database === undefined || database === 'default'
    ? CAPABILITIES.DATABASE
    : createCapabilityToken(`database.${database}`);
  return (services: IServiceRegistry): IOutboxStore =>
    new DatabaseOutboxStore(services.get<IDatabaseService>(token), entity);
}
