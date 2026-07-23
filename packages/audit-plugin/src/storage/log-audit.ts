/**
 * LogAuditStorage — routes structured audit records to an {@linkcode ILogger}.
 *
 * @module
 */
import type { ILogger, LogMetadata } from '@hono-enterprise/common';
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';

type LogLevel = 'info' | 'warn' | 'error';

/**
 * Logs audit records through an `ILogger`. When constructed without a logger
 * and used as a storage backend, queries return empty arrays.
 *
 * At register time (`LogAuditStorage` construction with `storage: 'log'`), if
 * no logger is available, throw the documented error.
 */
export class LogAuditStorage implements IAuditStorage {
  private _logger: ILogger | null;
  private _level: LogLevel;

  /**
   * @param options.logger - Injectable `ILogger` (overrides context logger)
   * @param options.level - Logger method to emit at; defaults to `'info'`
   */
  constructor(options?: { logger?: ILogger; level?: LogLevel }) {
    this._logger = options?.logger ?? null;
    this._level = options?.level ?? 'info';
  }

  /** Initializes the logger from context when not injected. */
  setContextLogger(logger: ILogger): void {
    this._logger = logger;
  }

  /** Sets the log level for emitting audit records. */
  setLogLevel(level: LogLevel): void {
    this._level = level;
  }

  /** Routes the frozen record to `logger[level]('audit', record)`. */
  append(entry: StoredAuditEntry): Promise<void> {
    const meta: LogMetadata = entry as unknown as LogMetadata;
    (this._logger![this._level] as (message: string, metadata?: LogMetadata) => void)(
      'audit',
      meta,
    );
    return Promise.resolve();
  }

  /**
   * The log sink is the durable trail; read-back happens through the logging
   * backend, not this object. Returns `[]`.
   */
  query(_criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
    return Promise.resolve([]);
  }

  /** Ready as long as a logger is configured. */
  isReady(): boolean {
    return this._logger !== null;
  }

  /** The logger owns its own flush lifecycle; nothing to drain here. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
