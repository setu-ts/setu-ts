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
 * Object attributes accepted alongside the bytes when storing an object.
 *
 * Without these every stored object is `application/octet-stream`, so a signed
 * URL handed to a browser downloads the object instead of rendering it —
 * defeating the purpose of the feature that produces the URL.
 *
 * Providers differ in what they can persist, and that difference is a fact
 * about the backend rather than a gap: S3, GCS and Azure carry both fields to
 * the stored object, while the memory and local-filesystem providers accept and
 * do not persist them — neither backend has a reader for an object attribute
 * ({@linkcode IStorage.get} returns bytes, the local provider's
 * `getSignedUrl` throws, and the memory provider's URL is synthetic).
 *
 * @since 0.3.0
 */
export interface PutObjectOptions {
  /**
   * MIME type recorded on the stored object (e.g. `'image/png'`). Omitted
   * leaves the backend's own default, which is `application/octet-stream` on
   * every provider that supports the field.
   */
  readonly contentType?: string;
  /**
   * Arbitrary user metadata recorded alongside the object. Keys and values are
   * passed through to the backend unmodified; backends impose their own limits
   * on size and on which characters a key may contain.
   */
  readonly metadata?: Readonly<Record<string, string>>;
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
   * @param options - Object attributes to record with the bytes. Optional, so
   * an existing two-argument call is unchanged; see {@linkcode PutObjectOptions}
   * for which providers persist them.
   */
  put(path: string, data: Uint8Array, options?: PutObjectOptions): Promise<void>;
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
  /**
   * Retrieves an object as a streaming body for zero-copy downloads.
   *
   * Providers that support native streaming (S3, GCS, Azure) return a live
   * stream; others fall back to buffering the entire object into a one-chunk
   * stream via {@linkcode get}.
   *
   * When omitted on the provider, the service wraps {@linkcode get} in a
   * one-chunk `ReadableStream`.  Absent objects throw (mirroring {@linkcode get}).
   *
   * @param path - Object path/key
   * @returns A `ReadableStream` of object bytes
   * @throws {Error} If the object does not exist
   * @since 0.2.0
   */
  getStream?(path: string): Promise<ReadableStream<Uint8Array>>;
}
