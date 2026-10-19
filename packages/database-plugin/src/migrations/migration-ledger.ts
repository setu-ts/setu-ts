/** Repository-backed migration history. @module */
import type {
  IDatabaseService,
  IMigrationLedger,
  IRepository,
  MigrationLedgerOptions,
} from '../interfaces/index.ts';

/** Default application-owned migration entity. @since 0.10.0 */
export const MIGRATION_LEDGER_ENTITY = 'setu_migrations';

/** A ledger too large to read safely. @since 0.10.0 */
export class MigrationLedgerError extends Error {
  /** The bounded read exceeded 10,000 rows. */
  readonly reason = 'oversized';

  /** Creates the bounded-read refusal. */
  constructor() {
    super('Migration ledger exceeds 10000 rows');
    this.name = 'MigrationLedgerError';
  }
}

/** Stored ledger row; the caller owns the timestamp. */
type MigrationRow = { id: string; appliedAt: string };

/** The repository-backed implementation, kept behind the public factory. */
class MigrationLedger implements IMigrationLedger {
  constructor(
    private readonly database: IDatabaseService,
    private readonly entity: string,
  ) {}

  // Resolve lazily: a missing table/mapping is an unreadable health outcome,
  // not a failure to register the application's database plugin.
  private repository(): IRepository<MigrationRow> {
    return this.database.getRepository<MigrationRow>(this.entity);
  }

  async applied(): Promise<readonly string[]> {
    const rows = await this.repository().findAll({ select: ['id'], limit: 10_001 });
    if (rows.length > 10_000) throw new MigrationLedgerError();
    return rows.map((row) => row.id);
  }

  async record(name: string, appliedAt: string): Promise<void> {
    await this.repository().create({ id: name, appliedAt });
  }

  async remove(name: string): Promise<void> {
    await this.repository().delete(name);
  }
}

/**
 * Creates a ledger over an application-owned entity; never creates its schema.
 * Run one migration job: duplicate records propagate the adapter's create error.
 * @param database - Connection used by migrations and readiness
 * @param options - Entity override; match readiness.ledgerEntity when overriding
 * @returns Persistent history (process-local on memory)
 * @throws {TypeError} When entity is empty
 * @example
 * ```typescript
 * const ledger = createMigrationLedger(database);
 * await ledger.record('20261019000000-orders', '2026-10-19T00:00:00.000Z');
 * ```
 * @since 0.10.0
 */
export function createMigrationLedger(
  database: IDatabaseService,
  options?: MigrationLedgerOptions,
): IMigrationLedger {
  const entity = options?.entity === undefined ? MIGRATION_LEDGER_ENTITY : options.entity;
  if (typeof entity !== 'string' || entity.trim() === '') {
    throw new TypeError('MigrationLedgerOptions.entity must be a non-empty string');
  }
  return new MigrationLedger(database, entity);
}
