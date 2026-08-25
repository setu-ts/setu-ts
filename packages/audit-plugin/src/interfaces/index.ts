/**
 * Internal audit storage port — the seam between AuditService and backends.
 *
 * This module is NOT exported from `src/index.ts` directly, but its option
 * types (`AuditPluginOptions`, `AuditStorageType`, `AuditStorageOptions`) are
 * re-exported from the public barrel so apps can type their configuration.
 *
 * @module
 */
import type { ILogger } from '@setu-ts/common';

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
  /** Internally assigned unique identifier (UUID v4). */
  readonly id: string;
  /** Wall-clock epoch milliseconds, assigned by the storage at append. */
  readonly timestamp: number;
  /** The audited action (e.g. `'user.login'`). */
  readonly action: string;
  /** The audited resource type (e.g. `'session'`). */
  readonly resource: string;
  /** The affected resource instance identifier, when known. */
  readonly resourceId?: string | undefined;
  /** The acting principal's identifier, when authenticated. */
  readonly userId?: string | undefined;
  /** Whether the audited operation succeeded or failed. */
  readonly result: 'success' | 'failure';
  /** Resource state before the operation, when captured. */
  readonly before?: Readonly<Record<string, unknown>> | undefined;
  /** Resource state after the operation, when captured. */
  readonly after?: Readonly<Record<string, unknown>> | undefined;
  /** Free-form structured context attached by the caller. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Query criteria for {@linkcode IAuditStorage.query}. Every field is optional
 * and combines as AND. An omitted field does not constrain.
 */
export interface AuditQuery {
  /** Matches entries whose `action` equals this value exactly. */
  action?: string;
  /** Matches entries whose `resource` equals this value exactly. */
  resource?: string;
  /** Matches entries whose `resourceId` equals this value exactly. */
  resourceId?: string;
  /** Matches entries whose `userId` equals this value exactly. */
  userId?: string;
  /** Matches entries whose outcome equals this value. */
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
  /**
   * Drains any in-flight writes on shutdown. Backends that complete each
   * `append` before its promise resolves (memory/log/database) are no-ops;
   * `FileAuditStorage` awaits its serialized write chain so a fire-and-forget
   * `log()` in flight at shutdown is not lost.
   */
  close(): Promise<void>;
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
