/**
 * @module
 *
 * Audit trail logging plugin with pluggable storage.
 *
 * Exports the plugin factory, service, four storage backends, option types,
 * and structural client interface.
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

export { AuditPlugin } from './plugin/audit-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

export { AuditService } from './services/audit-service.ts';

// ── Storage backends ────────────────────────────────────────────────────────

export { MemoryAuditStorage } from './storage/memory-audit.ts';
export { LogAuditStorage } from './storage/log-audit.ts';
export { DatabaseAuditStorage } from './storage/database-audit.ts';
export { FileAuditStorage } from './storage/file-audit.ts';

// ── Structural client interface (database backend) ──────────────────────────

export type { IAuditDbClient } from './interfaces/index.ts';

// ── Option types ────────────────────────────────────────────────────────────

export type {
  AuditPluginOptions,
  AuditStorageOptions,
  AuditStorageType,
} from './interfaces/index.ts';

// ── Re-exported from @hono-enterprise/common ────────────────────────────────

export type { AuditEntry, IAuditLogger } from '@hono-enterprise/common';
