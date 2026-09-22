/**
 * StorageService — the {@linkcode IStorage} implementation registered under
 * `CAPABILITIES.STORAGE`. Wraps a {@linkcode StorageProvider} with absent→throw
 * conversion on `get` and a buffered-fallback on `getStream`.
 *
 * @module
 */
import type { IStorage, PutObjectOptions, SignedUrlOptions } from '@setu-ts/common';
import type { StorageProvider } from '../interfaces/index.ts';

/**
 * Storage service backed by a pluggable provider.
 *
 * The committed `IStorage.get` throws when an object is absent; providers
 * signal absence with `null`, and this service performs the `null → throw`
 * conversion so the throw contract lives in one place.
 *
 * Every method is `async` and every delegation is `return await`, which is
 * load-bearing rather than stylistic: this class is exported, so an
 * application can hand it its own provider (structural typing needs no
 * `StorageProvider` import), and a bare `return provider.x()` would let that
 * provider's SYNCHRONOUS throw escape `IStorage` before the promise exists,
 * where a caller using `.catch()` can never see it. The `await` keeps the
 * failure inside this method's own promise.
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
   * @param options - Object attributes to record with the bytes; forwarded to
   * the provider verbatim, and omitted entirely when the caller omits it, so a
   * provider can tell "no attributes given" from "empty attributes given"
   */
  async put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void> {
    if (options === undefined) {
      await this.#provider.put(path, data);
      return;
    }
    await this.#provider.put(path, data, options);
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
  async delete(path: string): Promise<boolean> {
    return await this.#provider.delete(path);
  }

  /**
   * Reports whether an object exists.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  async exists(path: string): Promise<boolean> {
    return await this.#provider.exists(path);
  }

  /**
   * Creates a time-limited URL granting direct access to an object.
   *
   * @param path - Object path/key
   * @param options - URL validity
   * @returns The signed URL
   */
  async getSignedUrl(path: string, options: SignedUrlOptions): Promise<string> {
    return await this.#provider.getSignedUrl(path, options);
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
