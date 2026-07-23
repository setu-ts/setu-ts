/**
 * Internal module re-exports — shared between src files without creating
 * circular dependencies with the public barrel (`index.ts`).
 *
 * @module
 */

export type { AuditQuery, IAuditStorage, StoredAuditEntry } from './interfaces/index.ts';

export { MemoryAuditStorage } from './storage/memory-audit.ts';
export { LogAuditStorage } from './storage/log-audit.ts';
export { DatabaseAuditStorage } from './storage/database-audit.ts';
export { FileAuditStorage } from './storage/file-audit.ts';

export type { IAuditDbClient } from './storage/database-audit.ts';
