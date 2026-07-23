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
import { freezeAuditRecord, matchAuditQuery, orderAndLimit } from './audit-record.ts';

/**
 * Lexical parent directory of a path, or `undefined` when the path has no
 * directory component (a bare filename) or resolves to a filesystem root.
 * `IFileSystem` exposes no `dirname`, so this is computed here; it handles both
 * `/` and `\` separators for cross-runtime paths.
 */
function parentDir(path: string): string | undefined {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx <= 0) return undefined;
  return path.slice(0, idx);
}

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
  private _dirEnsured = false;

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
    const next = this._lock.then(() => this.readModifyWrite(entryCopy));
    // The chain always resets to fulfilled so a single failure never bricks future writes:
    this._lock = next.then(() => undefined, () => undefined);
    await next; // still propagates THIS append's error to its caller
  }

  /**
   * Creates the target file's parent directory (recursively) on first write, so
   * a configured `path` in a not-yet-existing directory does not fail with
   * ENOENT. Idempotent: runs once per instance (guarded by `_dirEnsured`), and
   * is serialized by the `_lock` chain so there is no race on the flag.
   */
  private async ensureDir(): Promise<void> {
    if (this._dirEnsured) return;
    const dir = parentDir(this.path);
    if (dir !== undefined) {
      await this.fs.mkdir(dir, { recursive: true });
    }
    this._dirEnsured = true;
  }

  private async readModifyWrite(entry: StoredAuditEntry): Promise<void> {
    await this.ensureDir();
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
    return orderAndLimit(filtered, criteria?.limit);
  }

  /** File storage is always ready once constructed (we don't probe the FS). */
  isReady(): boolean {
    return true;
  }

  /** Awaits the serialized write chain so no in-flight append is lost on close. */
  close(): Promise<void> {
    return this._lock;
  }
}
