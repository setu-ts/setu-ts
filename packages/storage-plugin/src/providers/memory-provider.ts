/**
 * MemoryProvider — zero-dependency in-memory storage using a Map.
 *
 * @module
 */
import type { StorageProvider } from '../interfaces/index.ts';

/**
 * In-memory storage provider backed by `Map<string, Uint8Array>`.
 *
 * `getSignedUrl` returns a deterministic synthetic URL
 * `memory://<encoded-key>?expires=<epoch>` — non-functional off-process.
 *
 * @since 0.1.0
 */
export class MemoryProvider implements StorageProvider {
  readonly #store = new Map<string, Uint8Array>();
  #connected = false;

  /** Connect is a no-op for the memory provider. */
  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  /** Disconnect is a no-op for the memory provider. */
  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  /** Reports readiness (memory is always ready once connected). */
  isReady(): boolean {
    return this.#connected;
  }

  /**
   * Stores an object in memory.
   *
   * @param path - Object path/key
   * @param data - Object bytes
   */
  put(path: string, data: Uint8Array): Promise<void> {
    this.#store.set(path, data);
    return Promise.resolve();
  }

  /**
   * Retrieves an object from memory; `null` when absent.
   *
   * @param path - Object path/key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null> {
    const data = this.#store.get(path);
    return Promise.resolve(data ?? null);
  }

  /**
   * Deletes an object from memory.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  delete(path: string): Promise<boolean> {
    return Promise.resolve(this.#store.delete(path));
  }

  /**
   * Reports whether an object exists in memory.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#store.has(path));
  }

  /**
   * Returns a synthetic memory:// URL with expiry query parameter.
   *
   * @param path - Object path/key
   * @param options - Expiry in seconds
   * @returns The synthetic signed URL
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    const encoded = encodeURIComponent(path);
    const expires = Math.floor(Date.now() / 1000) + options.expiresIn;
    return Promise.resolve(`memory://${encoded}?expires=${expires}`);
  }

  // No native getStream — service falls back to buffered wrapping.
}
