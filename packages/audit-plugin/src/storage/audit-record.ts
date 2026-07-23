/**
 * Pure transforms for audit records: deep-freeze, query-match, row
 * serialize/deserialize.
 *
 * @module
 */
import type { AuditQuery, StoredAuditEntry } from '../interfaces/index.ts';

/**
 * Recursively freezes any plain object or array, returning it for chaining.
 */
function deepFreeze<T extends Record<string | number, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value != null && (typeof value === 'object' || Array.isArray(value))) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (item != null && typeof item === 'object') {
            deepFreeze(item as Record<string | number, unknown>);
          }
        }
      } else {
        deepFreeze(value as Record<string | number, unknown>);
      }
      // Assign through `as` to satisfy the readonly constraint from Object.freeze chain.
      (obj as Record<keyof T, unknown>)[key as keyof T] = Object.freeze(value);
    }
  }
  return Object.freeze(obj);
}

/**
 * Deep-freezes an audit record (including nested `before`/`after`/`metadata`).
 * Throws on mutation in strict mode.
 *
 * @param record - The record to freeze (mutation-safe copy)
 * @returns The same reference, now deep-frozen
 */
export function freezeAuditRecord(record: StoredAuditEntry): StoredAuditEntry {
  const copy: StoredAuditEntry = {
    action: record.action,
    resource: record.resource,
    resourceId: record.resourceId,
    userId: record.userId,
    result: record.result,
    before: record.before ? structuredClone(record.before) : undefined,
    after: record.after ? structuredClone(record.after) : undefined,
    metadata: record.metadata ? structuredClone(record.metadata) : undefined,
    id: record.id,
    timestamp: record.timestamp,
  };
  // Deep-freeze the base and nested objects recursively.
  if (copy.before) deepFreeze(copy.before);
  if (copy.after) deepFreeze(copy.after);
  if (copy.metadata) deepFreeze(copy.metadata);
  Object.freeze(copy);
  return copy;
}

/**
 * Evaluates whether a {@linkcode StoredAuditEntry} matches every criterion in
 * the {@linkcode AuditQuery}. Omitted fields are unconstrained. Absent
 * `resourceId`/`userId` never match a set value.
 */
export function matchAuditQuery(
  entry: StoredAuditEntry,
  criteria: AuditQuery,
): boolean {
  if (criteria.action !== undefined && entry.action !== criteria.action) {
    return false;
  }
  if (criteria.resource !== undefined && entry.resource !== criteria.resource) {
    return false;
  }
  if (criteria.resourceId !== undefined && entry.resourceId !== criteria.resourceId) {
    return false;
  }
  if (criteria.userId !== undefined && entry.userId !== criteria.userId) {
    return false;
  }
  if (criteria.result !== undefined && entry.result !== criteria.result) {
    return false;
  }
  if (criteria.from !== undefined && entry.timestamp < criteria.from) {
    return false;
  }
  if (criteria.to !== undefined && entry.timestamp > criteria.to) {
    return false;
  }
  return true;
}

/**
 * Serializes a {@linkcode StoredAuditEntry} to a flat row for database insertion.
 * Nested objects (`before`/`after`/`metadata`) are JSON-stringified.
 */
export function toAuditRow(record: StoredAuditEntry): Record<string, unknown> {
  return {
    id: record.id,
    timestamp: record.timestamp,
    action: record.action,
    resource: record.resource,
    resource_id: record.resourceId ?? null,
    user_id: record.userId ?? null,
    result: record.result,
    before: record.before ? JSON.stringify(record.before) : null,
    after: record.after ? JSON.stringify(record.after) : null,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
  };
}

/**
 * Deserializes a flat row back into a {@linkcode StoredAuditEntry}, applying
 * {@linkcode freezeAuditRecord} so the returned record is immutable.
 */
export function fromAuditRow(row: Record<string, unknown>): StoredAuditEntry {
  const entry: StoredAuditEntry = {
    action: String(row.action),
    resource: String(row.resource),
    result: row.result === 'failure' ? 'failure' : 'success',
    before: typeof row.before === 'string' ? JSON.parse(row.before) : undefined,
    after: typeof row.after === 'string' ? JSON.parse(row.after) : undefined,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : undefined,
    resourceId: row.resource_id !== null && row.resource_id !== undefined
      ? String(row.resource_id)
      : undefined,
    userId: row.user_id !== null && row.user_id !== undefined ? String(row.user_id) : undefined,
    id: String(row.id),
    timestamp: Number(row.timestamp),
  };
  return freezeAuditRecord(entry);
}
