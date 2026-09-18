/**
 * AuditService — implements {@linkcode IAuditLogger}, stamping records with an
 * internally generated `id` and `timestamp`, then delegating to storage.
 *
 * @module
 */
import type { AuditEntry, IAuditLogger, IRedactionService } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
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
    private readonly redaction?: IRedactionService,
  ) {}

  /**
   * Appends an entry to the audit trail. Entries are immutable once written.
   *
   * @param entry - The audit entry (without id/timestamp)
   * @throws Propagates any storage rejection (never swallowed)
   */
  async log(entry: AuditEntry): Promise<void> {
    const record: {
      -readonly [Key in keyof StoredAuditEntry]: StoredAuditEntry[Key];
    } = {
      action: entry.action,
      resource: entry.resource,
      result: entry.result,
      id: this.runtime.uuid(),
      timestamp: this.runtime.now(),
    };
    if (entry.resourceId !== undefined) record.resourceId = entry.resourceId;
    if (entry.userId !== undefined) record.userId = entry.userId;
    if (entry.before !== undefined) {
      record.before = this.redaction?.redactRecord(entry.before) ?? entry.before;
    }
    if (entry.after !== undefined) {
      record.after = this.redaction?.redactRecord(entry.after) ?? entry.after;
    }
    if (entry.metadata !== undefined) {
      record.metadata = this.redaction?.redactRecord(entry.metadata) ?? entry.metadata;
    }
    await this.storage.append(freezeAuditRecord(record));
  }
}
