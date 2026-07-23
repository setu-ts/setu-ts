/**
 * MemoryAuditStorage — zero-dependency in-process array backend. Non-durable.
 * Runs on every target including Cloudflare Workers.
 *
 * @module
 */
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';
import { matchAuditQuery, orderAndLimit } from './audit-record.ts';

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
   * Filters entries via {@linkcode matchAuditQuery}, then orders ascending by
   * timestamp and applies `limit` (newest) via {@linkcode orderAndLimit}.
   */
  query(criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
    const matches = this.entries.filter((e) => !criteria || matchAuditQuery(e, criteria));
    return Promise.resolve(orderAndLimit(matches, criteria?.limit));
  }

  /** Always ready — in-memory storage has no external dependency. */
  isReady(): boolean {
    return true;
  }

  /** No buffered state — appends complete synchronously. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
