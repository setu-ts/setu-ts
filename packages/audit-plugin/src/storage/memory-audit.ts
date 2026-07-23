/**
 * MemoryAuditStorage — zero-dependency in-process array backend. Non-durable.
 * Runs on every target including Cloudflare Workers.
 *
 * @module
 */
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';
import { matchAuditQuery } from './audit-record.ts';

/**
 * In-memory audit storage backed by an array. Stores already-frozen records;
 * `isReady()` always returns `true`. Non-durable across restarts.
 */
export class MemoryAuditStorage implements IAuditStorage {
  private readonly entries: StoredAuditEntry[] = [];

  /**
   * Appends a (already frozen) entry.
   */
  append(entry: StoredAuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  /**
   * Filters entries via {@linkcode matchAuditQuery}, orders ascending by
   * timestamp, applies `limit` (newest).
   */
  query(criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
    const matches = this.entries.filter((e) => !criteria || matchAuditQuery(e, criteria));
    matches.sort(
      (a, b) => a.timestamp - b.timestamp || this.entries.indexOf(a) - this.entries.indexOf(b),
    );
    if (criteria?.limit === 0) {
      return Promise.resolve([]);
    }
    if (criteria?.limit !== undefined && criteria.limit > 0 && criteria.limit < matches.length) {
      return Promise.resolve(matches.slice(matches.length - criteria.limit));
    }
    return Promise.resolve(matches);
  }

  /** Always ready — in-memory storage has no external dependency. */
  isReady(): boolean {
    return true;
  }
}
