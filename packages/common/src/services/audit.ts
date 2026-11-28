/**
 * Audit logging contract, fulfilled by the AuditPlugin under
 * `CAPABILITIES.AUDIT`.
 *
 * @module
 */
import type { IOutboxWriteScope } from './outbox.ts';

/** Options for an audit write inside the caller's transaction. @since 0.14.0 */
export interface AuditLogOptions {
  /** The transaction-scoped repository provider; the audit row joins this scope. */
  readonly scope?: IOutboxWriteScope;
}

/**
 * One immutable audit trail entry.
 *
 * @since 0.1.0
 */
export interface AuditEntry {
  /** The action performed (e.g. `"user.delete"`). */
  readonly action: string;
  /** The resource kind acted on (e.g. `"user"`). */
  readonly resource: string;
  /** The specific resource instance, when applicable. */
  readonly resourceId?: string;
  /** The acting principal's ID. */
  readonly userId?: string;
  /** Whether the action succeeded. */
  readonly result: 'success' | 'failure';
  /** Resource state before the action. */
  readonly before?: Readonly<Record<string, unknown>>;
  /** Resource state after the action. */
  readonly after?: Readonly<Record<string, unknown>>;
  /** Additional context (IP, request ID, …). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Immutable audit trail writer.
 *
 * @example
 * ```typescript
 * const audit = ctx.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
 * await audit.log({
 *   action: 'user.delete',
 *   resource: 'user',
 *   resourceId: id,
 *   userId: ctx.request.user?.id,
 *   result: 'success',
 * });
 * ```
 * @since 0.1.0
 */
export interface IAuditLogger {
  /**
   * Appends an entry to the audit trail. Entries are immutable once
   * written.
   *
   * @param entry - The audit entry
   * @param options - Optional transaction scope; the sink must support scoped writes
   */
  log(entry: AuditEntry, options?: AuditLogOptions): Promise<void>;
}
