/**
 * StorageService — the {@linkcode IStorage} implementation registered under
 * `CAPABILITIES.STORAGE`. Wraps a {@linkcode StorageProvider} with absent→throw
 * conversion on `get` and a buffered-fallback on `getStream`.
 *
 * @module
 */
import type { IStorage, SignedUrlOptions } from '@setu-ts/common';
import type { StorageProvider } from '../interfaces/index.ts';

/**
 * Storage service backed by a pluggable provider.
 *
 * The committed `IStorage.get` throws when an object is absent; providers
 * signal absence with `null`, and this service performs the `null → throw`
 * conversion so the throw contract lives in one place.
 *
 * @since 0.1.0
 */
export class StorageService implements IStorage {
  readonly #provider: StorageProvider;

  /**
   * @param provider - The backing storage provider
   */
  constructor(provider: StorageProvider) {
    this.#provider = provider;
  }

  /**
   * Stores an object.
   *
   * @param path - Object path/key
   * @param data - Object bytes
   */
  async put(path: string, data: Uint8Array): Promise<void> {
    await this.#provider.put(path, data);
  }

  /**
   * Retrieves an object.
   *
   * @param path - Object path/key
   * @returns The object bytes
   * @throws {Error} If the object does not exist
   */
  async get(path: string): Promise<Uint8Array> {
    const data = await this.#provider.get(path);
    if (data === null) {
      throw new Error(`Storage object not found: ${path}`);
    }
    return data;
  }

  /**
   * Deletes an object.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  delete(path: string): Promise<boolean> {
    return this.#provider.delete(path);
  }

  /**
   * Reports whether an object exists.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    return this.#provider.exists(path);
  }

  /**
   * Creates a time-limited URL granting direct access to an object.
   *
   * @param path - Object path/key
   * @param options - URL validity
   * @returns The signed URL
   */
  getSignedUrl(path: string, options: SignedUrlOptions): Promise<string> {
    return this.#provider.getSignedUrl(path, options);
  }

  /**
   * Retrieves an object as a streaming body for zero-copy downloads.
   *
   * Delegates to the provider's optional `getStream`; falls back to wrapping
   * the buffered `get` result in a one-chunk `ReadableStream` when the provider
   * lacks native streaming support.
   *
   * @param path - Object path/key
   * @returns A `ReadableStream` of object bytes
   * @throws {Error} If the object does not exist
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const streamFn = this.#provider.getStream;
    if (streamFn !== undefined) {
      const stream = await streamFn.call(this.#provider, path);
      if (stream === null) {
        throw new Error(`Storage object not found: ${path}`);
      }
      return stream;
    }
    // Buffered fallback: read into memory, then stream it out.
    const data = await this.get(path);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
}
