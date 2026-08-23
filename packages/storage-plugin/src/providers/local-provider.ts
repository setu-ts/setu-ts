/**
 * LocalStorageProvider — file-system backed storage over `IRuntimeServices.fs`.
 *
 * @module
 */
import type { IFileSystem, PutObjectOptions } from '@setu-ts/common';
import type { StorageProvider } from '../interfaces/index.ts';

/**
 * Local file-system storage provider.
 *
 * Paths are contained under `runtime.fs` root — `..` escape is prevented by
 * joining through `runtime.fs.realPath` (when available) or lexical normalization.
 *
 * `getSignedUrl` throws with a documented message (conflict C3).
 *
 * @since 0.1.0
 */
export class LocalStorageProvider implements StorageProvider {
  readonly #fs: IFileSystem | null;
  readonly #root: string;
  /**
   * Reports the runtime platform, so the write-probe failure can name the flag
   * that fixes it on the runtime where it bites. Optional: injected by the
   * plugin, absent when the provider is constructed directly.
   */
  readonly #platform: (() => string) | undefined;
  /**
   * Whether the root proved writable at `connect()`. Read by
   * {@linkcode isHealthy}, so a root that stops being writable later is
   * reported rather than assumed good for the life of the process.
   */
  #writable = false;

  /**
   * @param runtimeFs - The optional file-system service from runtime
   * @param options - Provider options
   */
  constructor(
    runtimeFs: IFileSystem | undefined,
    options?: { rootDir?: string },
    platform?: () => string,
  ) {
    this.#fs = runtimeFs ?? null;
    this.#root = options?.rootDir ?? '.';
    this.#platform = platform;
  }

  /**
   * Connects, and PROVES the root is writable rather than assuming it.
   *
   * The probe exists because of X8-9: a scaffolded Deno project's `start` task
   * requests `--allow-net --allow-env --allow-read --allow-sys` and no
   * `--allow-write`, so every upload failed while `/health` reported `up` —
   * the M70c liveness probe calls `stat`, a READ, which the granted
   * `--allow-read` satisfies. Three defects had to be understood before the
   * one-flag cause was visible. Failing here instead, with the flag named,
   * follows this repo's rule of failing at registration with a name rather than
   * at the first request with a bare error.
   *
   * A startup probe rather than a per-check write: writability changes almost
   * never, and a write on every health-probe interval is recurring I/O for a
   * fact that does not move.
   *
   * @throws {Error} If the file system is not available, or the root cannot be
   * created or written to
   */
  async connect(): Promise<void> {
    const fs = this.#fs;
    if (fs === null) {
      throw new Error(
        'LocalStorageProvider requires runtime.fs which is not available on this runtime',
      );
    }
    // A UNIQUE probe name, and a best-effort cleanup: two replicas sharing one
    // root (a ReadWriteMany volume is the ordinary way this provider is
    // deployed) would otherwise race on a fixed path, and whichever `rm` ran
    // second would fail with ENOENT and refuse to boot a process whose root was
    // perfectly writable. The WRITE is what proves writability; failing to tidy
    // up afterwards is not a reason to refuse to start.
    const probe = `${this.#root}/.setu-write-probe-${crypto.randomUUID()}`;
    try {
      await fs.mkdir(this.#root, { recursive: true });
      await fs.writeFile(probe, new Uint8Array());
      this.#writable = true;
    } catch (error) {
      throw new Error(
        `LocalStorageProvider cannot write to '${this.#root}': ${
          error instanceof Error ? error.message : String(error)
        }${this.#permissionHint()}`,
        { cause: error },
      );
    }
    try {
      await fs.rm(probe);
    } catch {
      // Best effort; see above.
    }
  }

  /**
   * Names the Deno permission flag when that is the likely cause, and says
   * nothing on runtimes where it is not — a Node process denied by real file
   * permissions is not helped by being told about `--allow-write`.
   *
   * @returns The hint to append to the failure message, or an empty string
   */
  #permissionHint(): string {
    return this.#platform?.() === 'deno'
      ? ". On Deno this usually means the process was started without '--allow-write'."
      : '';
  }

  /** Disconnect is a no-op for local storage. */
  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  /** Reports readiness (true when fs is present and connected). */
  isReady(): boolean {
    return this.#fs !== null;
  }

  /**
   * M70c: `runtime.fs.stat(root)` succeeds — a disk that vanished or a
   * permission change is a real, common failure.
   *
   * Also reports `false` when the root never proved WRITABLE at `connect()`.
   * A stat-only probe answered `up` for a root the process could read and not
   * write, which is exactly the state X8-9 found: uploads failing while health
   * said everything was fine.
   *
   * @returns `true` when the root directory is reachable and writable
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const fs = this.#fs;
    if (fs === null || !this.#writable) {
      return false;
    }
    try {
      await fs.stat(this.#root);
      return true;
    } catch {
      return false;
    }
  }

  async #resolvePath(path: string): Promise<string> {
    if (this.#fs === null) {
      throw new Error('LocalStorageProvider is not connected');
    }
    const joined = this.#joinPath(this.#root, path);
    // Containment check via realPath when available, else lexical.
    if (this.#fs.realPath) {
      // Resolve real paths (IO that can fail) inside a try/catch block.
      let realRoot: string;
      let resolvedRealPath: string | null = null;
      try {
        realRoot = await this.#fs!.realPath!(this.#root);
        resolvedRealPath = await this.#fs!.realPath!(joined);
      } catch {
        // realPath IO failed — fall back to lexical join.
        return joined;
      }
      // Containment check OUTSIDE the try/catch so traversal throws are not swallowed.
      if (
        resolvedRealPath !== realRoot &&
        !resolvedRealPath.startsWith(realRoot + '/')
      ) {
        throw new Error(`Path traversal attempt blocked: ${path}`);
      }
      return resolvedRealPath;
    }
    return joined;
  }

  #joinPath(base: string, relative: string): string {
    // Normalize and join, preventing .. escape.
    const parts = relative.split('/');
    let current = base;
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        // Prevent escape — just skip (lexical containment).
        continue;
      }
      current = `${current}/${part}`;
    }
    return current;
  }

  /**
   * Stores an object on disk.
   *
   * Object attributes are ACCEPTED AND NOT PERSISTED: a file system stores
   * bytes and has nowhere to record a content type, and this provider's
   * `getSignedUrl` throws, so nothing could ever read one back. Documented per
   * provider in the package README rather than silently dropped.
   *
   * @param path - Object path/key
   * @param data - Object bytes
   * @param _options - Accepted for interface parity; see above
   */
  async put(path: string, data: Uint8Array, _options?: PutObjectOptions): Promise<void> {
    const resolved = await this.#resolvePath(path);
    // Ensure parent directory exists for nested keys (e.g. "a/b/c.txt").
    const slashIdx = resolved.lastIndexOf('/');
    if (slashIdx > 0) {
      const parentDir = resolved.slice(0, slashIdx);
      try {
        await this.#fs!.mkdir(parentDir, { recursive: true });
      } catch {
        // mkdir with recursive=true can fail if parent is root or doesn't exist — ignore.
      }
    }
    await this.#fs!.writeFile(resolved, data);
  }

  /**
   * Retrieves an object from disk; `null` when absent.
   *
   * @param path - Object path/key
   * @returns The object bytes, or `null`
   */
  async get(path: string): Promise<Uint8Array | null> {
    const resolved = await this.#resolvePath(path);
    try {
      return await this.#fs!.readFile(resolved);
    } catch {
      return null;
    }
  }

  /**
   * Deletes an object from disk.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  async delete(path: string): Promise<boolean> {
    const resolved = await this.#resolvePath(path);
    try {
      await this.#fs!.rm(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reports whether an object exists on disk.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  async exists(path: string): Promise<boolean> {
    const resolved = await this.#resolvePath(path);
    try {
      await this.#fs!.stat(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Throws — local storage cannot produce signed URLs.
   *
   * @param _path - Object path/key
   * @param _options - Expiry options
   * @throws {Error} Always — signed URLs unsupported on LocalStorageProvider
   */
  getSignedUrl(_path: string, _options: { expiresIn: number }): Promise<string> {
    throw new Error(
      'LocalStorageProvider does not support signed URLs; use the s3, gcs, or azure provider',
    );
  }

  // No native getStream — service falls back to buffered wrapping.
}
