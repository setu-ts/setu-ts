/**
 * DatabaseAuditStorage — inject-only backend that appends through an injected
 * `IAuditDbClient`. No canonical SQL driver exists to lazy-load.
 *
 * @module
 */
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';
import { fromAuditRow, toAuditRow } from './audit-record.ts';

/**
 * Structural shape of an injected database client facade. The DB backend is
 * inject-only — it never touches the `database` capability token.
 */
export interface IAuditDbClient {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  select(table: string, criteria?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

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
    results.sort((a, b) => a.timestamp - b.timestamp);

    // Apply from/to filter on mapped results.
    const filtered: StoredAuditEntry[] = [];
    for (const r of results) {
      if (criteria?.from !== undefined && r.timestamp < criteria.from) continue;
      if (criteria?.to !== undefined && r.timestamp > criteria.to) continue;
      filtered.push(r);
    }

    filtered.sort((a, b) => a.timestamp - b.timestamp);

    if (criteria?.limit !== undefined && criteria.limit > 0 && filtered.length > criteria.limit) {
      return filtered.slice(filtered.length - criteria.limit);
    }

    return filtered;
  }

  /** Database storage is always ready once constructed. */
  isReady(): boolean {
    return true;
  }
}
