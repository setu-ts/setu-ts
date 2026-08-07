/**
 * `R2Storage` — the committed {@linkcode IStorage} over an R2 bucket binding.
 *
 * @module
 */

import type { IStorage, SignedUrlOptions } from '@setu-ts/common';
import type { IR2Bucket } from '../bindings/facades.ts';
import { CloudflareObjectNotFoundError, CloudflareUnsupportedError } from '../errors.ts';

/**
 * Options for {@linkcode R2Storage}.
 *
 * @since 0.2.0
 */
export interface R2StorageOptions {
  /** Prefix applied to every object key, so one bucket can host several uses. */
  readonly prefix?: string;
}

/**
 * Object storage backed by Cloudflare R2.
 *
 * `getStream` is implemented, so a download can be piped straight to the
 * response through `IResponse.stream()` without buffering the object.
 *
 * `getSignedUrl` **throws**: the R2 Workers binding exposes no presigned-URL
 * capability at all. Serving an object through a Worker route, or fronting the
 * bucket with a custom domain, are the available alternatives, and the error
 * says so.
 *
 * @since 0.2.0
 */
export class R2Storage implements IStorage {
  readonly #bucket: IR2Bucket;
  readonly #prefix: string | undefined;

  /**
   * @param bucket - The R2 bucket binding
   * @param options - Key prefix
   */
  constructor(bucket: IR2Bucket, options?: R2StorageOptions) {
    this.#bucket = bucket;
    this.#prefix = options?.prefix;
  }

  async put(path: string, data: Uint8Array): Promise<void> {
    await this.#bucket.put(this.#key(path), data);
  }

  async get(path: string): Promise<Uint8Array> {
    const object = await this.#bucket.get(this.#key(path));
    if (object === null) {
      throw new CloudflareObjectNotFoundError(path);
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  /**
   * Streams an object without buffering it.
   *
   * @param path - The object path
   * @returns The object body as a stream
   * @throws {CloudflareObjectNotFoundError} When the object does not exist
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const object = await this.#bucket.get(this.#key(path));
    if (object === null) {
      throw new CloudflareObjectNotFoundError(path);
    }
    return object.body;
  }

  async delete(path: string): Promise<boolean> {
    // R2's delete returns void and succeeds whether or not the object existed,
    // so presence is read first to honor the committed Promise<boolean>. That
    // is one extra round trip per delete, and it is the price of an honest
    // return value.
    const key = this.#key(path);
    const existed = (await this.#bucket.head(key)) !== null;
    await this.#bucket.delete(key);
    return existed;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#bucket.head(this.#key(path))) !== null;
  }

  /**
   * Always throws — R2 bindings cannot presign.
   *
   * The unused `_options` is kept, not deleted. Dropping it would narrow the
   * exported class below {@linkcode IStorage}, so a consumer holding an
   * `R2Storage` directly could no longer pass {@linkcode SignedUrlOptions} —
   * the interface still declares it. An underscore is the sanctioned way to
   * mark a parameter a contract requires and an implementation cannot use.
   *
   * @param path - The object path, named in the error
   * @param _options - Required by the contract; no counterpart on the binding
   * @returns Never returns
   * @throws {CloudflareUnsupportedError} Always
   */
  getSignedUrl(path: string, _options: SignedUrlOptions): Promise<string> {
    return Promise.reject(
      new CloudflareUnsupportedError(
        `R2 bindings cannot produce a presigned URL for '${path}'. The Workers R2 API ` +
          'has no presign operation. Serve the object through a Worker route (using ' +
          'getStream for a zero-copy download), or put a custom domain in front of the ' +
          'bucket and authorize at the edge.',
      ),
    );
  }

  /** Applies the configured prefix. */
  #key(path: string): string {
    return this.#prefix === undefined ? path : `${this.#prefix}${path}`;
  }
}
