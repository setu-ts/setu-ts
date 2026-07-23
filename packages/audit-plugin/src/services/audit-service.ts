/**
 * AuditService — implements {@linkcode IAuditLogger}, stamping records with an
 * internally generated `id` and `timestamp`, then delegating to storage.
 *
 * @module
 */
import type { AuditEntry, IAuditLogger } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';
import { freezeAuditRecord } from '../storage/audit-record.ts';

/**
 * Audit service backed by an {@linkcode IAuditStorage} port.
 *
 * Implements the committed write-only `IAuditLogger` contract: `log()` stamps
 * the record with `id` (`runtime.uuid()`) and `timestamp` (`runtime.now()`),
 * deep-freezes it (immutability), then appends it to storage.
 */
export class AuditService implements IAuditLogger {
  constructor(
    private readonly storage: IAuditStorage,
    private readonly runtime: IRuntimeServices,
  ) {}

  /**
   * Appends an entry to the audit trail. Entries are immutable once written.
   *
   * @param entry - The audit entry (without id/timestamp)
   * @throws Propagates any storage rejection (never swallowed)
   */
  async log(entry: AuditEntry): Promise<void> {
    const record: StoredAuditEntry = {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      userId: entry.userId,
      result: entry.result,
      before: entry.before,
      after: entry.after,
      metadata: entry.metadata,
      id: this.runtime.uuid(),
      timestamp: this.runtime.now(),
    };
    await this.storage.append(freezeAuditRecord(record));
  }
}
