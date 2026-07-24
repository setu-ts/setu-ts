/**
 * GcsProvider — Google Cloud Storage via lazy `npm:@google-cloud/storage@^7`.
 *
 * Follows the M25 inject-or-lazy pattern: accept an injected
 * {@linkcode IGcsClient} facade, or lazily import and adapt the SDK.
 *
 * @module
 */
import type { IGcsClient, StorageProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** Shape of the GCS SDK module. */
export interface GcsSdkModule {
  Storage: new (config: { projectId?: string }) => {
    bucket(name: string): GcsBucket;
  };
}

/** Shape of a GCS bucket handle. */
export interface GcsBucket {
  file(name: string): GcsFile;
}

/** Shape of a GCS file handle. */
export interface GcsFile {
  getMetadata(): Promise<[Record<string, unknown>]>;
  download(): Promise<{ body: Uint8Array | NodeJS.ReadableStream }>;
  save(data: Uint8Array, callback: (error: Error | null) => void): void;
  delete(callback: (error: Error | null) => void): void;
  getSignedUrl(config: { action: 'read'; expires: number }): Promise<[string]>;
  createReadStream(): NodeJS.ReadableStream;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for {@linkcode GcsProvider}.
 *
 * @since 0.1.0
 */
export interface GcsProviderOptions {
  /** GCP project ID. */
  projectId?: string | undefined;
  /** Bucket name. */
  bucket: string;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IGcsClient | undefined;
}

// ── Validation ────────────────────────────────────────────────────────────

const REQUIRED_GCS_METHODS = ['bucket'] as const;

/**
 * Validates that an injected object matches {@linkcode IGcsClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 * @since 0.1.0
 */
export function validateGcsClient(client: unknown): boolean {
  return hasMethods(client, REQUIRED_GCS_METHODS);
}

// ── NotFound detector ─────────────────────────────────────────────────────

/** Reports whether an error indicates a missing GCS object. */
function isGcsNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as { code?: string | number; message?: string };
  const code = err.code;
  const msg = err.message ?? '';
  return code === 'ENOENT' || code === 404 || msg.includes('Not Found');
}

// ── Adapt / Load seams ────────────────────────────────────────────────────

/**
 * Adapts the GCS SDK module to the structural {@linkcode IGcsClient} facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadGcsModule}.
 *
 * @param mod - The GCS SDK module (real or fake)
 * @param options - GCS connection options
 * @returns The facade wrapping a `Storage` client
 */
export function adaptGcsModule(
  mod: GcsSdkModule,
  options: GcsProviderOptions,
): IGcsClient {
  const storageConfig: { projectId?: string } = {};
  if (options.projectId !== undefined) storageConfig.projectId = options.projectId;
  const storage = new mod.Storage(storageConfig);
  const bucketName = options.bucket;

  return {
    bucket(_name?: string): unknown {
      const b = storage.bucket(_name ?? bucketName);
      return {
        file(name: string) {
          return {
            getMetadata() {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              return new Promise<[Record<string, unknown>]>((resolve, reject) => {
                const fileHandle = b.file(name);
                (fileHandle as {
                  getMetadata: (
                    cb: (err: Error | null, metadata: Record<string, unknown>) => void,
                  ) => void;
                }).getMetadata(
                  (err: Error | null, metadata: Record<string, unknown>) => {
                    if (err) reject(err);
                    else resolve([metadata]);
                  },
                );
              });
            },
            download() {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              return new Promise<{ body: Uint8Array | NodeJS.ReadableStream }>(
                (resolve, reject) => {
                  const fileHandle = b.file(name);
                  (fileHandle as {
                    download: (cb: (err: Error | null, data: Uint8Array) => void) => void;
                  }).download((err: Error | null, data: Uint8Array) => {
                    if (err) reject(err);
                    else resolve({ body: data });
                  });
                },
              );
            },
            save(data: Uint8Array, cb: (error: Error | null) => void) {
              const fileHandle = b.file(name);
              (fileHandle as {
                save: (data: Uint8Array, cb: (error: Error | null) => void) => void;
              }).save(data, cb);
            },
            delete() {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              return new Promise<boolean>((resolve, reject) => {
                const fileHandle = b.file(name);
                (fileHandle as { delete: (cb: (err: Error | null) => void) => void }).delete(
                  (err: Error | null) => {
                    if (err) reject(err);
                    else resolve(true);
                  },
                );
              });
            },
            getSignedUrl(config: { action: string; expires: number }) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              return new Promise<[string]>((resolve, reject) => {
                const fileHandle = b.file(name);
                (fileHandle as {
                  getSignedUrl: (
                    config: { action: string; expires: number },
                    cb: (err: Error | null, url: string) => void,
                  ) => void;
                }).getSignedUrl(config, (err: Error | null, url: string) => {
                  if (err) reject(err);
                  else resolve([url]);
                });
              });
            },
            createReadStream() {
              return (b.file(name) as { createReadStream(): NodeJS.ReadableStream })
                .createReadStream();
            },
          };
        },
      };
    },
  } as IGcsClient;
}

/**
 * Lazily imports the GCS SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadGcsModule(): Promise<GcsSdkModule> {
  return await import('npm:@google-cloud/storage@^7') as unknown as GcsSdkModule;
}

/**
 * Google Cloud Storage provider.
 *
 * Supports native streaming via `createReadStream()` async-iterated into a web `ReadableStream`.
 *
 * @since 0.1.0
 */
export class GcsProvider implements StorageProvider {
  #client: IGcsClient | null = null;
  readonly #options: GcsProviderOptions;

  /**
   * @param options - GCS connection/injection options
   */
  constructor(options?: GcsProviderOptions) {
    this.#options = options ?? { bucket: '' };
  }

  /**
   * Establishes the GCS client — injects the SDK lazily or uses injected client.
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateGcsClient(injected)) {
        throw new Error(
          'Injected GCS client is missing required method (bucket)',
        );
      }
      this.#client = injected;
      return;
    }
    this.#client = adaptGcsModule(await loadGcsModule(), this.#options);
  }

  /** Disconnect is a no-op for GCS (connectionless HTTP client). */
  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  /** Reports readiness. */
  isReady(): boolean {
    return this.#client !== null;
  }

  #assertConnected(): void {
    if (this.#client === null) {
      throw new Error('GcsProvider is not connected. Call connect() first.');
    }
  }

  #getFile(path: string) {
    // bucket() returns unknown from the facade; cast through internal GcsFile shape.
    // deno-lint-ignore no-explicit-any
    return (this.#client!.bucket() as any).file(path);
  }

  /**
   * Stores an object in GCS.
   *
   * @param path - Object key
   * @param data - Object bytes
   */
  put(path: string, data: Uint8Array): Promise<void> {
    this.#assertConnected();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return new Promise<void>((resolve, reject) => {
      this.#getFile(path).save(data, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Retrieves an object from GCS; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  async get(path: string): Promise<Uint8Array | null> {
    this.#assertConnected();
    try {
      const { body } = await this.#getFile(path).download();
      return body instanceof Uint8Array ? body : new Uint8Array(body);
    } catch (error) {
      if (isGcsNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Deletes an object from GCS.
   *
   * @param path - Object key
   * @returns `true` if deleted
   */
  async delete(path: string): Promise<boolean> {
    this.#assertConnected();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      await this.#getFile(path).delete();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reports whether an object exists in GCS.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  async exists(path: string): Promise<boolean> {
    this.#assertConnected();
    try {
      await this.#getFile(path).getMetadata();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a signed GET URL for a GCS object.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The signed URL
   */
  async getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    this.#assertConnected();
    const expires = Date.now() + options.expiresIn * 1000;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [url] = await this.#getFile(path).getSignedUrl({ action: 'read', expires });
    return url;
  }

  /**
   * Native stream download — adapts GCS `createReadStream()` (Node Readable)
   * into a web `ReadableStream` via async iteration (no `node:` import needed).
   *
   * @param path - Object key
   * @returns A `ReadableStream`, or `null` if absent
   */
  getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.#assertConnected();
    try {
      const readable = this.#getFile(path).createReadStream();
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            const on = (event: string, cb: (arg: unknown) => void) => {
              (readable as NodeJS.ReadableStream).on(event, cb);
            };
            on('data', (chunk: unknown) => {
              controller.enqueue(chunk as Uint8Array);
            });
            on('end', () => {
              controller.close();
            });
            on('error', (err: unknown) => {
              controller.error(err as Error);
            });
          },
        }),
      );
    } catch (error) {
      if (isGcsNotFound(error)) return Promise.resolve(null);
      throw error;
    }
  }
}
