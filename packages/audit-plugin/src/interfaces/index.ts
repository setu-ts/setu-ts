/**
 * Internal audit storage port — the seam between AuditService and backends.
 *
 * This module is NOT exported from `src/index.ts` directly, but its option
 * types (`AuditPluginOptions`, `AuditStorageType`, `AuditStorageOptions`) are
 * re-exported from the public barrel so apps can type their configuration.
 *
 * @module
 */
import type { ILogger } from '@hono-enterprise/common';
// Re-exported type used by StoredAuditEntry's base — suppressed to avoid unused-var lint.

/**
 * A stored audit record extends {@linkcode AuditEntry} with an internally
 * assigned `id` (UUID v4) and `timestamp` (wall-clock epoch ms).
 *
 * To work around `exactOptionalPropertyTypes` with inherited optional fields
 * from `AuditEntry`, we redeclare `resourceId`/`userId`/`before`/`after`/
 * `metadata` with `| undefined` so assigning `{ resourceId: undefined }`
 * compiles cleanly.
 */
export interface StoredAuditEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly action: string;
  readonly resource: string;
  readonly resourceId?: string | undefined;
  readonly userId?: string | undefined;
  readonly result: 'success' | 'failure';
  readonly before?: Readonly<Record<string, unknown>> | undefined;
  readonly after?: Readonly<Record<string, unknown>> | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Query criteria for {@linkcode IAuditStorage.query}. Every field is optional
 * and combines as AND. An omitted field does not constrain.
 */
export interface AuditQuery {
  action?: string;
  resource?: string;
  resourceId?: string;
  userId?: string;
  result?: 'success' | 'failure';
  /** Lower time bound, inclusive (epoch ms). */
  from?: number;
  /** Upper time bound, inclusive (epoch ms). */
  to?: number;
  /** Cap on returned count, applied after filtering and ordering. */
  limit?: number;
}

/**
 * Internal storage port — each backend implements this shape.
 */
export interface IAuditStorage {
  /**
   * Appends a fully stamped and frozen entry to the trail.
   */
  append(entry: StoredAuditEntry): Promise<void>;
  /**
   * Returns matching entries ordered ascending by `timestamp`. When `limit`
   * is set, returns the newest `limit` records still in ascending order.
   */
  query(criteria?: AuditQuery): Promise<StoredAuditEntry[]>;
  /** Whether the storage is ready to accept writes. */
  isReady(): boolean;
}

// ── Structural client interface (database backend) ──────────────────────────

/**
 * Structural shape of an injected database client facade. The DB backend is
 * inject-only — it never touches the `database` capability token.
 */
export interface IAuditDbClient {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  select(table: string, criteria?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

// ── Option types (re-exported from public barrel) ───────────────────────────

/** Storage backend identifier — closed union. */
export type AuditStorageType = 'memory' | 'log' | 'database' | 'file';

/** Options passed to individual storage backends. */
export interface AuditStorageOptions {
  /** Injected `ILogger` for `LogAuditStorage`; overrides `ctx.logger`. */
  logger?: ILogger;
  /** Logger method to emit at (`'info'`/`'warn'`/`'error'`); default `'info'`. */
  level?: 'info' | 'warn' | 'error';
  /** Injected database client for `DatabaseAuditStorage`. */
  client?: IAuditDbClient;
  /** Table name for `DatabaseAuditStorage`; defaults to `'audit_logs'`. */
  table?: string;
  /** JSONL file path for `FileAuditStorage`; defaults to `'./audit.log'`. */
  path?: string;
}

/** Options accepted by the `AuditPlugin` factory. */
export interface AuditPluginOptions {
  /** Storage backend selector; default `'memory'`. */
  storage?: AuditStorageType;
  /** Backend-specific options. */
  options?: AuditStorageOptions;
}
