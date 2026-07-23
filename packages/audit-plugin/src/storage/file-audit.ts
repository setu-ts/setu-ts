/**
 * FileAuditStorage — persists audit entries as JSONL via `runtime.fs`. Uses
 * read-modify-write (no native append primitive on `IFileSystem`).
 *
 * Node/Deno/Bun only; throws at construction when `fs` is absent (Workers/edge).
 *
 * @module
 */
import type { IFileSystem } from '@hono-enterprise/common';
import type { AuditQuery, IAuditStorage, StoredAuditEntry } from '../interfaces/index.ts';
import { freezeAuditRecord, matchAuditQuery } from './audit-record.ts';

/**
 * File-backed audit storage. Writes JSONL to `path` via `runtime.fs`.
 *
 * At construction, when `fs` is absent, throws the documented error. Uses
 * read-modify-write (read the whole file, append a line, write back).
 */
export class FileAuditStorage implements IAuditStorage {
  private readonly fs: IFileSystem;
  private readonly path: string;
  private _lock: Promise<void> = Promise.resolve();

  /**
   * @param options.fs - The `IFileSystem` from runtime (required, throws absent).
   * @param options.path - JSONL file path; defaults to `'./audit.log'`.
   */
  constructor(options: { fs: IFileSystem; path?: string }) {
    if (!options?.fs) {
      throw new Error('FileAuditStorage requires runtime.fs which is absent on edge platforms');
    }
    this.fs = options.fs;
    this.path = options.path ?? './audit.log';
  }

  /**
   * Read-modify-write with serialized in-process appends via `_lock`.
   * Cross-process file contention is inherent to the OS file and not solved here.
   */
  async append(entry: StoredAuditEntry): Promise<void> {
    const entryCopy = structuredClone(entry);
    // Queue this append behind any in-flight operation, then await it.
    this._lock = this._lock.then(() => this.readModifyWrite(entryCopy));
    await this._lock;
  }

  private async readModifyWrite(entry: StoredAuditEntry): Promise<void> {
    let content = '';
    try {
      const buf = await this.fs.readFile(this.path);
      content = new TextDecoder().decode(buf);
    } catch {
      // File doesn't exist yet; treat as empty.
    }
    const line = JSON.stringify(entry) + '\n';
    const updated = content.length === 0 || content.endsWith('\n')
      ? content + line
      : content + '\n' + line;
    await this.fs.writeFile(this.path, new TextEncoder().encode(updated));
  }

  /** Reads and filters lines via {@linkcode matchAuditQuery}. */
  async query(criteria?: AuditQuery): Promise<StoredAuditEntry[]> {
    let content = '';
    try {
      const buf = await this.fs.readFile(this.path);
      content = new TextDecoder().decode(buf);
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    // Guard per-line JSON parse so one malformed line doesn't break query().
    const entries: StoredAuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(freezeAuditRecord(JSON.parse(line)));
      } catch {
        // Skip malformed lines silently.
      }
    }

    const filtered = entries.filter((e) => !criteria || matchAuditQuery(e, criteria));
    filtered.sort((a, b) => a.timestamp - b.timestamp);

    if (criteria?.limit !== undefined && criteria.limit > 0 && criteria.limit < filtered.length) {
      return filtered.slice(filtered.length - criteria.limit);
    }

    return filtered;
  }

  /** File storage is always ready once constructed (we don't probe the FS). */
  isReady(): boolean {
    return true;
  }
}
