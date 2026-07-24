/**
 * LocalStorageProvider — file-system backed storage over `IRuntimeServices.fs`.
 *
 * @module
 */
import type { IFileSystem } from '@hono-enterprise/common';
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
   * @param runtimeFs - The optional file-system service from runtime
   * @param options - Provider options
   */
  constructor(
    runtimeFs: IFileSystem | undefined,
    options?: { rootDir?: string },
  ) {
    this.#fs = runtimeFs ?? null;
    this.#root = options?.rootDir ?? '.';
  }

  /**
   * Connects — throws when `runtime.fs` is absent.
   *
   * @throws {Error} If the file system is not available
   */
  connect(): Promise<void> {
    if (this.#fs === null) {
      throw new Error(
        'LocalStorageProvider requires runtime.fs which is not available on this runtime',
      );
    }
    return Promise.resolve();
  }

  /** Disconnect is a no-op for local storage. */
  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  /** Reports readiness (true when fs is present and connected). */
  isReady(): boolean {
    return this.#fs !== null;
  }

  async #resolvePath(path: string): Promise<string> {
    if (this.#fs === null) {
      throw new Error('LocalStorageProvider is not connected');
    }
    const joined = this.#joinPath(this.#root, path);
    // Containment check via realPath when available, else lexical.
    if (this.#fs.realPath) {
      try {
        const realRoot = await this.#fs.realPath!(this.#root);
        const realPath = await this.#fs.realPath!(joined);
        if (!realPath.startsWith(realRoot)) {
          throw new Error(`Path traversal attempt blocked: ${path}`);
        }
        return realPath;
      } catch {
        // Fallback to lexical check.
        return joined;
      }
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
   * @param path - Object path/key
   * @param data - Object bytes
   */
  async put(path: string, data: Uint8Array): Promise<void> {
    const resolved = await this.#resolvePath(path);
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
