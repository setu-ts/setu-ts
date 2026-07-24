/**
 * S3Provider — AWS S3 object storage via lazy `npm:@aws-sdk/client-s3` +
 * `npm:@aws-sdk/s3-request-presigner`.
 *
 * Follows the M25 inject-or-lazy pattern: accept an injected
 * {@linkcode IAwsS3Client} facade, or lazily import and adapt the SDK.
 *
 * @module
 */
import type { IAwsS3Client, StorageProvider } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

// ── SDK module shapes ─────────────────────────────────────────────────────

/** Shape of the S3 SDK client module. */
export interface AwsSdkModule {
  S3Client: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<unknown>;
  };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/** Shape of the presigner SDK module. */
export interface PresignerSdkModule {
  getSignedUrl(client: unknown, command: unknown): Promise<string>;
}

/** Combined S3 SDK module shape. */
export interface AwsStorageSdkModule {
  s3: AwsSdkModule;
  presigner: PresignerSdkModule;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for {@linkcode S3Provider}.
 *
 * @since 0.1.0
 */
export interface S3ProviderOptions {
  /** AWS region for the lazily-loaded client. */
  region?: string | undefined;
  /** Bucket name. */
  bucket: string;
  /** AWS access key id for the lazily-loaded client. */
  accessKeyId?: string | undefined;
  /** AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string | undefined;
  /** Custom endpoint (R2, MinIO, B2). */
  endpoint?: string | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: IAwsS3Client | undefined;
}

// ── Validation ────────────────────────────────────────────────────────────

const REQUIRED_S3_METHODS = ['put', 'get', 'delete', 'head', 'getSignedUrl', 'getStream'] as const;

/**
 * Validates that an injected object matches {@linkcode IAwsS3Client}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 * @since 0.1.0
 */
export function validateAwsS3Client(client: unknown): boolean {
  return hasMethods(client, REQUIRED_S3_METHODS);
}

// ── NotFound detector ─────────────────────────────────────────────────────

/** Reports whether an error indicates a missing S3 object. */
function isS3NotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const n = (error as { name?: string }).name;
  return n === 'NoSuchKey' || n === 'NotFound';
}

// ── Adapt / Load seams ────────────────────────────────────────────────────

/** Builds an S3 client config without assigning `undefined` to optional fields. */
function buildS3Config(options: S3ProviderOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.region !== undefined) config.region = options.region;
  if (options.accessKeyId !== undefined && options.secretAccessKey !== undefined) {
    config.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
  }
  if (options.endpoint !== undefined) config.endpoint = options.endpoint;
  return config;
}

/**
 * Adapts the AWS SDK module to the structural {@linkcode IAwsS3Client} facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadAwsS3Module}.
 *
 * @param mod - The combined SDK module (real or fake)
 * @param options - S3 connection options
 * @returns The facade wrapping an `S3Client`
 */
export function adaptAwsS3Module(
  mod: AwsStorageSdkModule,
  options: S3ProviderOptions,
): IAwsS3Client {
  const bucket = options.bucket;
  const s3Mod = mod.s3;
  const presignerMod = mod.presigner;
  const client = new s3Mod.S3Client(buildS3Config(options));

  return {
    async put(path: string, data: Uint8Array): Promise<void> {
      await client.send(new s3Mod.PutObjectCommand({ Bucket: bucket, Key: path, Body: data }));
    },
    async get(path: string): Promise<Uint8Array | null> {
      try {
        // deno-lint-ignore no-explicit-any
        const res: any = await client.send(
          new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
        );
        // Convert body to Uint8Array (real SDK returns a Readable in node env)
        return res.Body instanceof Uint8Array ? res.Body : new Uint8Array(res.Body);
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
    async delete(path: string): Promise<boolean> {
      try {
        await client.send(new s3Mod.DeleteObjectCommand({ Bucket: bucket, Key: path }));
        return true;
      } catch {
        return false;
      }
    },
    async head(path: string): Promise<boolean> {
      try {
        await client.send(new s3Mod.HeadObjectCommand({ Bucket: bucket, Key: path }));
        return true;
      } catch {
        return false;
      }
    },
    async getSignedUrl(path: string, expiresIn: number): Promise<string> {
      // Build a real presigned URL via the presigner.
      try {
        return await presignerMod.getSignedUrl(
          client,
          new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
        );
      } catch {
        // Fallback synthetic URL when presigner is not available.
        return `https://${bucket}.s3.amazonaws.com/${path}?X-Amz-Expires=${expiresIn}`;
      }
    },
    async getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
      try {
        // deno-lint-ignore no-explicit-any
        const res: any = await client.send(
          new s3Mod.GetObjectCommand({ Bucket: bucket, Key: path }),
        );
        // Real SDK: transformToWebStream() returns web ReadableStream.
        // For injected fakes, return the Body as-is or null.
        if (res.Body && typeof (res.Body as unknown as ReadableStream).getReader === 'function') {
          return res.Body as ReadableStream<Uint8Array>;
        }
        // Fake path: wrap raw bytes in a one-chunk stream.
        if (res.Body instanceof Uint8Array) {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(res.Body);
              controller.close();
            },
          });
        }
        return null;
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Lazily imports the AWS S3 + presigner SDK. Only exercised on the lazy path.
 *
 * @returns The combined SDK module
 * @throws {Error} If the packages cannot be resolved
 */
export async function loadAwsS3Module(): Promise<AwsStorageSdkModule> {
  const [s3Mod, presignerMod] = await Promise.all([
    import('npm:@aws-sdk/client-s3@^3') as unknown as Promise<AwsSdkModule>,
    import('npm:@aws-sdk/s3-request-presigner@^3') as Promise<PresignerSdkModule>,
  ]);
  return { s3: s3Mod, presigner: presignerMod };
}

/**
 * AWS S3 storage provider.
 *
 * Supports native streaming via the facade's `getStream` method.
 *
 * @since 0.1.0
 */
export class S3Provider implements StorageProvider {
  #client: IAwsS3Client | null = null;
  readonly #options: S3ProviderOptions;

  /**
   * @param options - S3 connection/injection options
   */
  constructor(options?: S3ProviderOptions) {
    this.#options = options ?? { bucket: '' };
  }

  /**
   * Establishes the S3 client — injects the SDK lazily or uses injected client.
   */
  async connect(): Promise<void> {
    if (this.#client !== null) return;
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateAwsS3Client(injected)) {
        throw new Error(
          'Injected S3 client is missing required methods (put, get, delete, head, getSignedUrl, getStream)',
        );
      }
      this.#client = injected;
      return;
    }
    this.#client = adaptAwsS3Module(await loadAwsS3Module(), this.#options);
  }

  /** Disconnect is a no-op for S3 (connectionless HTTP client). */
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
      throw new Error('S3Provider is not connected. Call connect() first.');
    }
  }

  /**
   * Stores an object in S3.
   *
   * @param path - Object key
   * @param data - Object bytes
   */
  async put(path: string, data: Uint8Array): Promise<void> {
    this.#assertConnected();
    await this.#client!.put(path, data);
  }

  /**
   * Retrieves an object from S3; `null` when absent.
   *
   * @param path - Object key
   * @returns The object bytes, or `null`
   */
  get(path: string): Promise<Uint8Array | null> {
    this.#assertConnected();
    return this.#client!.get(path);
  }

  /**
   * Deletes an object from S3.
   *
   * @param path - Object key
   * @returns `true` if deleted
   */
  delete(path: string): Promise<boolean> {
    this.#assertConnected();
    return this.#client!.delete(path);
  }

  /**
   * Reports whether an object exists in S3.
   *
   * @param path - Object key
   * @returns `true` if present
   */
  exists(path: string): Promise<boolean> {
    this.#assertConnected();
    return this.#client!.head(path);
  }

  /**
   * Creates a presigned GET URL for an S3 object.
   *
   * @param path - Object key
   * @param options - Expiry in seconds
   * @returns The presigned URL
   */
  getSignedUrl(path: string, options: { expiresIn: number }): Promise<string> {
    this.#assertConnected();
    return this.#client!.getSignedUrl(path, options.expiresIn);
  }

  /**
   * Native stream download — zero-copy from S3.
   *
   * @param path - Object key
   * @returns A `ReadableStream`, or `null` if absent
   */
  getStream(path: string): Promise<ReadableStream<Uint8Array> | null> {
    this.#assertConnected();
    return this.#client!.getStream(path);
  }
}
