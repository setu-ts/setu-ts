/**
 * DatabaseAuditStorage — inject-only backend that appends through an injected
 * `IAuditDbClient`. No canonical SQL driver exists to lazy-load.
 *
 * @module
 */
import type {
  AuditQuery,
  IAuditDbClient,
  IAuditStorage,
  StoredAuditEntry,
} from '../interfaces/index.ts';
import { fromAuditRow, orderAndLimit, toAuditRow } from './audit-record.ts';

/**
 * Primary-key value the reachability probe selects on. Deliberately not a
 * UUID: `AuditService` stamps every `id` with `runtime.uuid()`, so this can
 * never collide with a real record and the probe can never return one.
 */
const PROBE_SENTINEL_ID = '__setu_audit_health_probe__';

/**
 * Database-backed audit storage. Requires an injected {@linkcode IAuditDbClient}
 * at construction time.
 *
 * `append` serializes records via `toAuditRow` and calls `client.insert`.
 * `query` calls `client.select` and maps rows back via `fromAuditRow`.
 */
export class DatabaseAuditStorage implements IAuditStorage {
  private readonly client: IAuditDbClient;
  private readonly table: string;

  /**
   * @param options.client - Injected `IAuditDbClient`; required, throws absent.
   * @param options.table - Table name; defaults to `'audit_logs'`.
   */
  constructor(options: { client: IAuditDbClient; table?: string }) {
    if (!options?.client) {
      throw new Error('DatabaseAuditStorage requires an injected IAuditDbClient');
    }
    this.client = options.client;
    this.table = options.table ?? 'audit_logs';
  }

  /** Appends one row via `client.insert`. */
  async append(entry: StoredAuditEntry): Promise<void> {
    await this.client.insert(this.table, toAuditRow(entry));
  }

  /** Selects rows via `client.select`, filters, maps to frozen entries. */
  async query(criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
    const where: Record<string, unknown> = {};
    if (criteria?.action) where.action = criteria.action;
    if (criteria?.resource) where.resource = criteria.resource;
    if (criteria?.result) where.result = criteria.result;
    if (criteria?.userId) where.user_id = criteria.userId;
    if (criteria?.resourceId) where.resource_id = criteria.resourceId;

    const rows = await this.client.select(
      this.table,
      Object.keys(where).length > 0 ? where : undefined,
    );

    const results: StoredAuditEntry[] = rows.map(fromAuditRow);

    // Apply from/to filter on mapped results (equality filters are delegated to
    // the client's WHERE above); ordering/limit via the shared helper.
    const filtered: StoredAuditEntry[] = [];
    for (const r of results) {
      if (criteria?.from !== undefined && r.timestamp < criteria.from) continue;
      if (criteria?.to !== undefined && r.timestamp > criteria.to) continue;
      filtered.push(r);
    }

    return orderAndLimit(filtered, criteria?.limit);
  }

  /**
   * Probes the injected client with a `select` that matches nothing.
   *
   * `IAuditDbClient` exposes only `insert` and `select`, and an audit probe
   * may not `insert` — it would write a fabricated record into the trail this
   * plugin exists to keep trustworthy. So the probe reads instead, on the
   * primary key against a sentinel that no generated `id` can equal
   * ({@linkcode toAuditRow} writes `runtime.uuid()` there): the round trip
   * exercises the connection and the table's existence while returning no
   * rows, which is what keeps it cheap enough to run on a health interval.
   *
   * A rejection means the client was reached for and did not answer — a
   * dropped connection, a missing table, a revoked grant — all of which mean
   * the next `append` will be lost.
   *
   * @returns `true` when the client answered, `false` when it rejected
   * @since 0.6.0
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.client.select(this.table, { id: PROBE_SENTINEL_ID });
      return true;
    } catch {
      return false;
    }
  }

  /** Database storage is always ready once constructed. */
  isReady(): boolean {
    return true;
  }

  /** The injected client owns the connection lifecycle; nothing to drain here. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
