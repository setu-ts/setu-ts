/**
 * The portable "storage object not found" error.
 *
 * `IStorage.get` and `IStorage.getStream` throw when the object is absent.
 * Before this class each storage backend threw a plain `Error`, which
 * `errorHandler` answered as a masked `500`: a client that asked for a key that
 * does not exist was told the server failed. The class lives in `common` so any
 * storage backend can throw it without importing a plugin; today
 * `@setu-ts/storage-plugin`'s providers and `@setu-ts/cloudflare-plugin`'s
 * `R2Storage` do.
 *
 * @module
 */
import { withHttpStatusHint } from './status-hint.ts';

/**
 * Thrown when a storage read names an object that does not exist.
 *
 * The response is `404 Not Found` with a fixed `detail`. The key appears in
 * `message` and on {@linkcode StorageObjectNotFoundError.key} for the log and
 * for application code, never in the served body: a key can carry a user id or
 * a document name.
 *
 * @example
 * ```typescript
 * import { StorageObjectNotFoundError } from '@setu-ts/common';
 *
 * try {
 *   await storage.get(`avatars/${userId}.png`);
 * } catch (error) {
 *   if (error instanceof StorageObjectNotFoundError) {
 *     // Fall back to the default avatar.
 *   }
 * }
 * ```
 *
 * @since 0.14.0
 */
export class StorageObjectNotFoundError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'StorageObjectNotFoundError';

  /** The object key that was not found. */
  readonly key: string;

  /**
   * @param key - The object key that was not found
   */
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.key = key;
    withHttpStatusHint(this, {
      status: 404,
      title: 'Not Found',
      detail: 'The requested object was not found.',
    });
  }
}
