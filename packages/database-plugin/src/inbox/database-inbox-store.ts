/**
 * The inbox store bridge over `IDatabaseService` (M108).
 *
 * `IInboxStore` is declared in `@setu-ts/common` so this package can implement
 * it by name without importing `@setu-ts/messaging-plugin` (AI_GUIDELINES
 * §2.2) — the M107 `createDatabaseOutboxStore` shape. The messaging plugin's
 * inbox resolves the factory in `onInit`, verifies it, and records each
 * delivery through it; it never resolves `CAPABILITIES.DATABASE` itself.
 *
 * **The marker's INSERT is the authority on "handled".** `run` opens one
 * transaction, creates the marker in it FIRST, and only then runs the
 * handler, so a concurrent duplicate either blocks on the primary key and
 * fails (PostgreSQL), is refused at commit (the deferred backends) or loses a
 * write conflict (a MongoDB replica set) — and its business writes roll back
 * with it. The messaging plugin re-reads the marker after any rejection to
 * decide whether the delivery was already handled.
 *
 * **The discriminator is one rule on every backend.** Every row carries
 * `kind: 'setu-inbox'`, every read conjoins it to its `where`, and a lookup
 * by id treats a row whose `kind` differs as missing.
 *
 * **Failure increments use a compare-and-set on attempts.** Release guards
 * kind and parked status. Sources lacking the members keep the read-then-write
 * fallback, as does an invalid stored failure count.
 *
 * **Absent optional columns are written as `null`** and read back as absent
 * (the M107 rule: a SQL column has no "absent" state, and the memory adapter
 * refuses a `select` naming a column no stored row carries).
 *
 * @module
 */
import type {
  EntityKey,
  IInboxStore,
  InboxFailureUpdate,
  InboxIds,
  InboxRecord,
  InboxReleaseOutcome,
  InboxStatus,
  InboxStoreStats,
  IRuntimeServices,
  IServiceRegistry,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, INBOX_RECORD_KIND } from '@setu-ts/common';
import { BigtableTransactionScopeError } from '../errors.ts';
import { causeChain } from '../errors/classify.ts';
import type { IDatabaseService, IRepository } from '../interfaces/index.ts';
import {
  isBigtableBackend,
  isCosmosBackend,
  isMongoReplicaSetRefusal,
  ProbeRollback,
  probeTwoCreateTransaction,
} from '../transactional/backend-probe.ts';
import { conditionalDelete, conditionalUpdate } from '../repositories/conditional-write.ts';
import { InboxStoreUnavailableError } from './errors.ts';

/**
 * Options for {@linkcode createDatabaseInboxStore}.
 *
 * @since 0.9.0
 */
export interface DatabaseInboxStoreOptions {
  /** The inbox entity (table or collection). Default `'Inbox'`. */
  readonly entity?: string;
  /**
   * The named database connection to use — `DatabasePlugin({ name })`, so the
   * store resolves `database.<name>`. Omitted (or `'default'`) resolves
   * `CAPABILITIES.DATABASE`. It must be the database the handlers write to:
   * the marker is created in that database's transaction, and a handler
   * writing elsewhere gets no once-only guarantee.
   */
  readonly database?: string;
}

/** The default inbox entity. */
const DEFAULT_ENTITY = 'Inbox';

/** The record fields every row carries. */
const REQUIRED_FIELDS = [
  'id',
  'kind',
  'consumer',
  'topic',
  'status',
  'attempts',
  'updatedAt',
] as const;

/** The optional record fields: written as `null` when absent, read back as absent. */
const OPTIONAL_FIELDS = ['envelopeId', 'lastError', 'envelope'] as const;

/** Every column `parked()` reads — all but the envelope. */
const PARKED_COLUMNS = [...REQUIRED_FIELDS, 'envelopeId', 'lastError'];

/**
 * The statuses retention deletes — every status. A parked marker is purged
 * too, once older than the window: otherwise a stream of events whose payload
 * never parses would keep every envelope for ever, an unbounded table that
 * may also hold personal data.
 */
const PURGED_STATUSES: readonly InboxStatus[] = ['processed', 'discarded', 'attempting', 'parked'];

/** A row as the adapter hands it back. */
type Row = Record<string, unknown>;

/** The row an inbox record is written as: every field, each absent optional as `null`. */
function toRow(record: InboxRecord): Row {
  const row: Row = { ...record, kind: INBOX_RECORD_KIND };
  for (const field of OPTIONAL_FIELDS) {
    if (row[field] === undefined) row[field] = null;
  }
  return row;
}

/**
 * The record a stored row reads back as: only the record's own fields, with a
 * `null` or missing optional field omitted. Values are passed through as
 * stored.
 */
function fromRow(row: Row): InboxRecord {
  const record: Row = {};
  for (const field of REQUIRED_FIELDS) record[field] = row[field];
  for (const field of OPTIONAL_FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined) record[field] = value;
  }
  return record as unknown as InboxRecord;
}

/**
 * Decides why a backend cannot serve the inbox from the refusal the probe
 * met, walking the bounded cause chain the driver classifier walks.
 */
function unavailableReason(error: unknown): InboxStoreUnavailableError['reason'] {
  const chain = causeChain(error);
  for (const member of chain) {
    if (member instanceof BigtableTransactionScopeError) return 'transaction-scope';
  }
  for (const member of chain) {
    if (isMongoReplicaSetRefusal(member)) return 'mongodb-standalone';
  }
  return 'entity-unavailable';
}

/**
 * The `IInboxStore` over `IDatabaseService`. Constructed by
 * {@linkcode createDatabaseInboxStore}; internal, so the column mapping and
 * the discriminator have one implementation.
 */
export class DatabaseInboxStore implements IInboxStore {
  readonly #service: IDatabaseService;
  readonly #entity: string;
  readonly #uuid: () => string;

  /**
   * Binds the store to the database service and entity it reads and writes.
   *
   * @param service - The database service the handlers write through
   * @param entity - The inbox entity
   * @param uuid - The id source for the startup probe's rows
   */
  constructor(service: IDatabaseService, entity: string, uuid: () => string) {
    this.#service = service;
    this.#entity = entity;
    this.#uuid = uuid;
  }

  /** The repository over the inbox entity, outside any transaction. */
  #repo(): IRepository<Row, EntityKey> {
    return this.#service.getRepository<Row, EntityKey>(this.#entity);
  }

  /** The `where` every listing read carries: the discriminator and one status. */
  #where(status: InboxStatus): Row {
    return { kind: INBOX_RECORD_KIND, status };
  }

  /** Reads an inbox row by id; a row of another `kind` is missing. */
  async #find(id: string): Promise<Row | null> {
    const row = await this.#repo().findById(id);
    if (row === null || row.kind !== INBOX_RECORD_KIND) return null;
    return row;
  }

  /** @inheritdoc */
  async find(markerId: string): Promise<InboxRecord | undefined> {
    const row = await this.#find(markerId);
    return row === null ? undefined : fromRow(row);
  }

  /** @inheritdoc */
  run<R>(marker: InboxRecord, work: (scope: unknown) => Promise<R>): Promise<R> {
    return this.#service.transaction(async (uow) => {
      await uow.getRepository<Row, EntityKey>(this.#entity).create(toRow(marker));
      return work(uow);
    });
  }

  /** @inheritdoc */
  async recordFailure(ids: InboxIds, update: InboxFailureUpdate): Promise<number> {
    const changes: Row = {
      lastError: update.lastError,
      updatedAt: update.now,
    };
    const existing = await this.#find(ids.attempts);
    if (existing === null) {
      const row: InboxRecord = {
        id: ids.attempts,
        kind: INBOX_RECORD_KIND,
        consumer: update.consumer,
        topic: update.topic,
        status: 'attempting',
        attempts: 1,
        updatedAt: update.now,
        lastError: update.lastError,
        ...(update.envelopeId !== undefined ? { envelopeId: update.envelopeId } : {}),
      };
      try {
        await this.#repo().create(toRow(row));
        return 1;
      } catch (error) {
        // Another failure created the row first: fall through to increment
        // it. Anything else is this call's own failure.
        const raced = await this.#find(ids.attempts);
        if (raced === null) throw error;
        return this.#increment(ids.attempts, raced, changes);
      }
    }
    return this.#increment(ids.attempts, existing, changes);
  }

  /** Writes `attempts + 1` with the new error line, returning the new count. */
  async #increment(id: string, row: Row, changes: Row): Promise<number> {
    const repo = this.#repo();
    for (let round = 0; round < 5; round += 1) {
      const valid = typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts);
      const current = valid ? row.attempts as number : 0;
      const attempts = current + 1;
      const data = { ...changes, attempts };
      if (!valid) {
        await repo.update(id, data);
        return attempts;
      }
      const result = await conditionalUpdate(repo, id, {
        kind: INBOX_RECORD_KIND,
        attempts: current,
      }, data);
      if (result.outcome === 'applied') return attempts;
      if (result.outcome === 'unsupported') {
        await repo.update(id, data);
        return attempts;
      }
      const latest = await this.#find(id);
      if (latest === null) {
        throw new Error(
          `Inbox entity '${this.#entity}' failure count disappeared during contention.`,
        );
      }
      row = latest;
    }
    throw new Error(
      `Inbox entity '${this.#entity}' increment encountered contention in all 5 rounds.`,
    );
  }

  /** @inheritdoc */
  async park(marker: InboxRecord): Promise<'applied' | 'exists'> {
    try {
      await this.#repo().create(toRow(marker));
      return 'applied';
    } catch (error) {
      if ((await this.#find(marker.id)) !== null) return 'exists';
      throw error;
    }
  }

  /** @inheritdoc */
  async parked(limit: number): Promise<readonly InboxRecord[]> {
    const rows = await this.#repo().findAll({
      where: this.#where('parked'),
      select: PARKED_COLUMNS,
      limit,
    });
    return rows.map(fromRow);
  }

  /** @inheritdoc */
  async release(
    ids: InboxIds,
    action: 'retry' | 'discard',
    now: number,
  ): Promise<InboxReleaseOutcome> {
    const row = await this.#find(ids.marker);
    if (row === null) return { outcome: 'missing' };
    const record = fromRow(row);
    if (record.status !== 'parked') {
      return { outcome: 'not-parked', status: record.status };
    }
    const repo = this.#repo();
    const where = { kind: INBOX_RECORD_KIND, status: 'parked' };
    const changes = { status: 'discarded', envelope: null, updatedAt: now };
    const result = action === 'retry'
      ? await conditionalDelete(repo, ids.marker, where)
      : await conditionalUpdate(repo, ids.marker, where, changes);
    if (result.outcome === 'not-matched') {
      const latest = await this.#find(ids.marker);
      if (latest === null) return { outcome: 'missing' };
      const status = fromRow(latest).status;
      if (status !== 'parked') return { outcome: 'not-parked', status };
      throw new Error(`Inbox entity '${this.#entity}' release encountered contention.`);
    }
    if (result.outcome === 'unsupported') {
      if (action === 'retry') {
        if (!(await repo.delete(ids.marker))) return { outcome: 'missing' };
      } else {
        await repo.update(ids.marker, changes);
      }
    }
    // The failure-count row may already be gone (purged by age); either way
    // nothing of this delivery's count remains.
    await this.#repo().delete(ids.attempts);
    return { outcome: 'applied', record };
  }

  /** @inheritdoc */
  async stats(): Promise<InboxStoreStats> {
    return { parked: await this.#repo().count({ where: this.#where('parked') }) };
  }

  /** @inheritdoc */
  async purge(before: number, limit: number): Promise<number> {
    const repo = this.#repo();
    let deleted = 0;
    for (const status of PURGED_STATUSES) {
      const rows = await repo.findAll({
        where: this.#where(status),
        filter: { type: 'comparison', field: 'updatedAt', operator: 'lt', value: before },
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
   * Refuses Cosmos DB and Bigtable by adapter arm or class, then runs retention's
   * first query and a transactional probe that writes two rows and always
   * rolls back — refusing the backend by name when either rejects.
   *
   * The probe is what reaches a standalone MongoDB (whose refusal surfaces
   * only at the first operation inside a transaction) and a custom adapter
   * bounded to one row per transaction. Nothing it writes survives: the
   * transaction is rolled back, and the deferred backends send nothing.
   *
   * @inheritdoc
   */
  async verify(): Promise<void> {
    // By arm, and by class for a shipped adapter handed to the `'custom'` arm.
    if (isCosmosBackend(this.#service)) {
      throw new InboxStoreUnavailableError(this.#entity, 'cosmos-unsupported');
    }
    if (isBigtableBackend(this.#service)) {
      throw new InboxStoreUnavailableError(this.#entity, 'bigtable-unsupported');
    }
    const rollback = new ProbeRollback('inbox startup probe');
    try {
      await this.purge(0, 1);
      const id = `setu-inbox-probe-${this.#uuid()}`;
      await probeTwoCreateTransaction(
        this.#service,
        this.#entity,
        [id, `${id}.attempts`].map((rowId) =>
          toRow({
            id: rowId,
            kind: INBOX_RECORD_KIND,
            consumer: 'setu-inbox-probe',
            topic: 'setu-inbox-probe',
            status: 'attempting',
            attempts: 0,
            updatedAt: 0,
          })
        ),
        rollback,
      );
    } catch (error) {
      if (error === rollback) return;
      throw new InboxStoreUnavailableError(this.#entity, unavailableReason(error), {
        cause: error,
      });
    }
  }
}

/**
 * Builds the inbox store bridge as a {@linkcode RegistryFactory}, for the
 * messaging plugin's `inbox.store` option.
 *
 * The factory resolves `CAPABILITIES.DATABASE` (or `database.<name>`) from the
 * registry it is handed — typed as `IDatabaseService`, the token's documented
 * interface — and returns an `IInboxStore` over it. The messaging plugin
 * resolves it in `onInit`, so `DatabasePlugin` may be registered before or
 * after the messaging plugin, and runs `verify()` there.
 *
 * **Per backend.** Memory, Prisma, Drizzle (with the inbox table in
 * `drizzleTables`), D1, a MongoDB replica set and DynamoDB are supported.
 * `verify()` refuses Cosmos DB, Bigtable, a standalone MongoDB and a missing
 * or unreadable entity, each by name with an
 * {@linkcode InboxStoreUnavailableError}.
 *
 * @param options - The inbox entity and the database connection
 * @returns A factory the messaging plugin resolves in `onInit`
 * @throws {TypeError} When `entity` is empty — at the call, before any
 *   application starts
 *
 * @example
 * ```typescript
 * import { createDatabaseInboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
 * import { MessagingPlugin } from '@setu-ts/messaging-plugin';
 * import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'memory' }),
 *     SchedulerPlugin(),
 *     MessagingPlugin({ inbox: { store: createDatabaseInboxStore() } }),
 *   ],
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseInboxStore(
  options?: DatabaseInboxStoreOptions,
): RegistryFactory<IInboxStore> {
  const entity = options?.entity ?? DEFAULT_ENTITY;
  if (typeof entity !== 'string' || entity.trim() === '') {
    throw new TypeError('createDatabaseInboxStore: entity must be a non-empty string');
  }
  const database = options?.database;
  const token = database === undefined || database === 'default'
    ? CAPABILITIES.DATABASE
    : createCapabilityToken(`database.${database}`);
  return (services: IServiceRegistry): IInboxStore => {
    const runtime = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return new DatabaseInboxStore(
      services.get<IDatabaseService>(token),
      entity,
      () => runtime.uuid(),
    );
  };
}
