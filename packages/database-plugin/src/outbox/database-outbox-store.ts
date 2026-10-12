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
 * **Transitions use native conditional writes.** The expected kind and status
 * guard each write, preventing a stale failure from regressing a sent row.
 * Sources lacking native conditional writes are refused at startup.
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
import { isMongoReplicaSetRefusal } from '../transactional/backend-probe.ts';
import { conditionalDelete, conditionalUpdate } from '../repositories/conditional-write.ts';
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
  'claimVersion',
  'leaseUntil',
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

/**
 * The integer fields a 64-bit column may hand back as a JS `bigint`: Prisma
 * Client returns a `BigInt` column as `bigint`, and Prisma's only 64-bit
 * integer type is `BigInt`. The relay reads these as numbers.
 */
const INTEGER_FIELDS = [
  'createdAt',
  'attempts',
  'availableAt',
  'claimVersion',
  'leaseUntil',
  'settledAt',
] as const;

/**
 * Converts any `bigint` into a number; anything else is passed through.
 *
 * A safe-integer `bigint` converts exactly. An unsafe one converts to a number
 * at or beyond `2^53`, which is not a safe integer either, so the relay still
 * refuses it in `claimVersion` and `leaseUntil` — and every other integer
 * field is an ordinary number the relay and the health indicator can compare,
 * rather than a `bigint` that throws when mixed with a number.
 */
function toNumber(value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** A stored row with every integer field read as a number, each field read once. */
function normalizeIntegers(row: Row): Row {
  const normalized: Row = { ...row };
  for (const field of INTEGER_FIELDS) normalized[field] = toNumber(normalized[field]);
  return normalized;
}

/** The four statuses a row may carry. */
const STATUSES: ReadonlySet<string> = new Set<OutboxStatus>([
  'pending',
  'sent',
  'failed',
  'discarded',
]);

/** The id the conditional capability probes address. Not a UUID, so `write` never produces it. */
const CLAIM_PROBE_ID = 'setu-outbox-claim-probe';

/**
 * The version the probes require: `-1`, which no row can carry — `append`
 * writes `0` and a claim only increments. So the probes match no row even
 * when a caller appended one under the probe id through the public
 * `append`, which accepts any id; a version of `0` would have claimed it.
 */
const UNMATCHABLE_VERSION = -1;

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
function fromRow(stored: Row): OutboxRecord {
  const row = normalizeIntegers(stored);
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
      if (member.feature === 'conditional-write') return 'conditional-writes-unsupported';
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
    return normalizeIntegers(row);
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
    update: {
      readonly claimVersion: number;
      readonly settledAt: number;
      readonly sentBy: string;
      readonly deleteNow: boolean;
    },
  ): Promise<OutboxTransition> {
    return await this.#transition(
      id,
      'pending',
      update.deleteNow ? undefined : {
        status: 'sent',
        settledAt: update.settledAt,
        sentBy: update.sentBy,
      },
      update.claimVersion,
    );
  }

  /** @inheritdoc */
  async markFailure(
    id: string,
    update: {
      readonly claimVersion: number;
      readonly attempts: number;
      readonly lastError: string;
      readonly availableAt: number;
      readonly status: 'pending' | 'failed';
    },
  ): Promise<OutboxTransition> {
    const { claimVersion, ...failure } = update;
    return await this.#transition(id, 'pending', { ...failure, leaseUntil: 0 }, claimVersion);
  }

  /** @inheritdoc */
  async claim(
    id: string,
    update: { readonly claimVersion: number; readonly leaseUntil: number },
  ): Promise<OutboxTransition> {
    return await this.#transition(id, 'pending', {
      claimVersion: update.claimVersion + 1,
      leaseUntil: update.leaseUntil,
    }, update.claimVersion);
  }

  /** @inheritdoc */
  async markInvalid(id: string, now: number): Promise<OutboxTransition> {
    return await this.#transition(id, 'pending', {
      status: 'failed',
      lastError: 'invalid-row',
      availableAt: now,
      leaseUntil: 0,
    });
  }

  /** @inheritdoc */
  async release(id: string, action: 'retry' | 'discard', now: number): Promise<OutboxTransition> {
    return await this.#transition(
      id,
      'failed',
      action === 'retry'
        ? { status: 'pending', attempts: 0, availableAt: now, leaseUntil: 0, lastError: null }
        : { status: 'discarded', settledAt: now },
    );
  }

  /** Native transition, with bounded classifying re-reads and an optional claim guard. */
  async #transition(
    id: string,
    expected: 'pending' | 'failed',
    data?: Row,
    claimVersion?: number,
  ): Promise<OutboxTransition> {
    const repo = this.#repo();
    const where = {
      kind: OUTBOX_RECORD_KIND,
      status: expected,
      ...(claimVersion === undefined ? {} : { claimVersion }),
    };
    for (let round = 0; round < 3; round += 1) {
      const result = data === undefined
        ? await conditionalDelete(repo, id, where)
        : await conditionalUpdate(repo, id, where, data);
      if (result.outcome === 'applied') return { outcome: 'applied' };
      if (result.outcome === 'unsupported') {
        throw new OutboxStoreUnavailableError(this.#entity, 'conditional-writes-unsupported');
      }
      const row = await this.#find(id);
      if (row === null) return { outcome: 'missing' };
      const status = statusOf(row, id);
      if (expected === 'pending' && status !== 'pending') return { outcome: 'not-pending', status };
      if (expected === 'failed' && status !== 'failed') return { outcome: 'not-failed', status };
      if (claimVersion !== undefined && row.claimVersion !== claimVersion) {
        return { outcome: 'claim-lost' };
      }
    }
    throw new Error(
      `Outbox entity '${this.#entity}' transition encountered contention in all 3 rounds.`,
    );
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
      // Both conditional operations are probed: they are independent optional
      // members, and `markSent` with `deleteNow` (`retainSentMs: 0`) needs the
      // conditional DELETE after a row is already published — a store lacking
      // it would leave every published row pending, to be published again
      // once its claim expired.
      const repo = this.#repo();
      if (repo.updateWhere === undefined || repo.deleteWhere === undefined) {
        throw new UnsupportedQueryFeatureError(
          'conditional-write',
          'database-plugin',
          'The bound repository lacks updateWhere or deleteWhere.',
        );
      }
      const probe = {
        kind: OUTBOX_RECORD_KIND,
        status: 'pending',
        claimVersion: UNMATCHABLE_VERSION,
      };
      await repo.updateWhere(CLAIM_PROBE_ID, probe, { claimVersion: 0 });
      await repo.deleteWhere(CLAIM_PROBE_ID, probe);
    } catch (error) {
      throw new OutboxStoreUnavailableError(this.#entity, unavailableReason(error), {
        cause: error,
      });
    }
  }
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
