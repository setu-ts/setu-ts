/**
 * File storage contract, implemented by the StoragePlugin's providers (S3,
 * GCS, local, memory) under `CAPABILITIES.STORAGE`.
 *
 * @module
 */

/**
 * Options accepted when creating a signed URL.
 *
 * @since 0.1.0
 */
export interface SignedUrlOptions {
  /** URL validity in seconds. */
  readonly expiresIn: number;
}

/**
 * Object storage abstraction.
 *
 * @example
 * ```typescript
 * const storage = ctx.services.get<IStorage>(CAPABILITIES.STORAGE);
 * await storage.put('uploads/photo.jpg', bytes);
 * const url = await storage.getSignedUrl('uploads/photo.jpg', { expiresIn: 3600 });
 * ```
 * @since 0.1.0
 */
export interface IStorage {
  /**
   * Stores an object.
   *
   * @param path - Object path/key
   * @param data - Object bytes
   */
  put(path: string, data: Uint8Array): Promise<void>;
  /**
   * Retrieves an object.
   *
   * @param path - Object path/key
   * @returns The object bytes
   * @throws {Error} If the object does not exist
   */
  get(path: string): Promise<Uint8Array>;
  /**
   * Deletes an object.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  delete(path: string): Promise<boolean>;
  /**
   * Reports whether an object exists.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean>;
  /**
   * Creates a time-limited URL granting direct access to an object.
   *
   * @param path - Object path/key
   * @param options - URL validity
   * @returns The signed URL
   */
  getSignedUrl(path: string, options: SignedUrlOptions): Promise<string>;
}
