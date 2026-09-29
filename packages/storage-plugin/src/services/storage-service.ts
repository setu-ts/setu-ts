/**
 * StorageService — the {@linkcode IStorage} implementation registered under
 * `CAPABILITIES.STORAGE`. Wraps a {@linkcode StorageProvider} with absent→throw
 * conversion on `get` and a buffered-fallback on `getStream`.
 *
 * @module
 */
import type {
  IStorage,
  PutObjectOptions,
  SignedUrlOptions,
  StorageDiagnosticsOperation,
} from '@setu-ts/common';
import type { StorageProvider } from '../interfaces/index.ts';
import type { StorageObservationCollector } from '../diagnostics/storage-observations.ts';

/**
 * The M98m collector attachment: a module-local WeakMap keyed by the service
 * instance. INTERNAL — never exported from the package barrel, so application
 * code cannot observe or replace a service's collector. A service that was
 * never attached does one WeakMap read per observed operation and nothing
 * else: no clock read, no extra promise, no allocation.
 */
const collectors = new WeakMap<StorageService, StorageObservationCollector>();

/**
 * Attaches the owning plugin's collector to its service (M98m). INTERNAL:
 * not exported from the package barrel, so application code cannot observe
 * or replace a service's collector.
 *
 * @param service - The plugin-owned service
 * @param collector - Its collector
 * @internal
 */
export function attachStorageCollector(
  service: StorageService,
  collector: StorageObservationCollector,
): void {
  collectors.set(service, collector);
}

/**
 * Detaches a service's collector. The plugin's close hook detaches FIRST and
 * then clears the collector, so no late call is observed.
 *
 * @param service - The plugin-owned service
 * @internal
 */
export function detachStorageCollector(service: StorageService): void {
  collectors.delete(service);
}

/**
 * The INTRINSIC length accessor of a typed array, resolved once by walking
 * the prototype chain from `Uint8Array.prototype` to the descriptor that
 * actually defines `byteLength` (on `TypedArray.prototype`). Invoking it
 * with an instance as `this` reads the internal length slot directly, so an
 * application-defined own `byteLength` getter — a subclass override, an own
 * accessor redefinition — is never run.
 */
const BYTE_LENGTH_GETTER: ((this: Uint8Array) => number) | null = (() => {
  let proto: object | null = Uint8Array.prototype;
  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'byteLength');
    if (descriptor !== undefined && typeof descriptor.get === 'function') {
      return descriptor.get;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return null;
})();

/**
 * Reads the byte length through the intrinsic accessor (above), never
 * through a property access that could invoke an application-defined
 * getter. A value that is not a real typed array, or any other failure,
 * is isolated to `null`; the observation never changes the operation.
 *
 * @param value - The application's put argument or get result
 * @returns The byte length, or `null`
 * @internal
 */
function intrinsicByteLength(value: Uint8Array): number | null {
  if (BYTE_LENGTH_GETTER === null) {
    return null;
  }
  try {
    const bytes = BYTE_LENGTH_GETTER.call(value);
    return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Runs one service operation under an attached collector, preserving every
 * application-visible behaviour: the same result, the same ORIGINAL rejection
 * reason (a derived promise re-rejects with it, so a fire-and-forget call
 * whose provider rejects still surfaces as an unhandled rejection exactly as
 * without diagnostics), and the same synchronous throw for a provider that
 * throws before a promise exists.
 *
 * @param collector - The service's attached collector
 * @param operation - The fixed service operation
 * @param call - Invokes the provider (and the service's own conversion)
 * @param bytesOf - For a successful `put`/`get`, classifies the settled
 * value into its intrinsic byte length; `null` for every other operation.
 * Runs only on a successful settlement, so a rejection never feeds it.
 * @returns What the service returned
 * @internal
 */
function observeStorageCall<T>(
  collector: StorageObservationCollector,
  operation: StorageDiagnosticsOperation,
  call: () => Promise<T>,
  bytesOf: ((value: T) => number | null) | null,
): Promise<T> {
  const start = collector.begin();
  let pending: Promise<T>;
  try {
    pending = call();
  } catch (error) {
    collector.settle(operation, start, 'failed', null);
    throw error;
  }
  // A DERIVED promise, not a side branch on the caller's own: attaching a
  // rejection handler to the caller's promise would mark it handled and
  // hide a fire-and-forget rejection whenever diagnostics are on.
  return pending.then(
    (value) => {
      collector.settle(operation, start, 'succeeded', bytesOf === null ? null : bytesOf(value));
      return value;
    },
    (reason: unknown) => {
      collector.settle(operation, start, 'failed', null);
      throw reason;
    },
  );
}

/**
 * Storage service backed by a pluggable provider.
 *
 * The committed `IStorage.get` throws when an object is absent; providers
 * signal absence with `null`, and this service performs the `null → throw`
 * conversion so the throw contract lives in one place.
 *
 * Every method is `async`, which is load-bearing rather than stylistic: this
 * class is exported, so an application can hand it its own provider
 * (structural typing needs no `StorageProvider` import), and a non-`async`
 * `return provider.x()` would let that provider's SYNCHRONOUS throw escape
 * `IStorage` before the promise exists, where a caller using `.catch()` can
 * never see it. `async` turns it into a rejection.
 *
 * When its StoragePlugin was opted into diagnostics (M98m), each public
 * operation settlement is additionally counted under one approved alias. The
 * `getStream` buffered fallback shares the private unobserved buffered read
 * with `get`, so one fallback is exactly ONE `getStream` observation — the
 * internal read is never counted as a second public `get`, and a concurrent
 * public `get` is never suppressed. A service constructed directly carries
 * no collector and runs unobserved.
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
    const collector = collectors.get(this);
    if (collector === undefined) {
      if (options === undefined) {
        await this.#provider.put(path, data);
        return;
      }
      await this.#provider.put(path, data, options);
      return;
    }
    // The argument's length is captured BEFORE the provider call, through
    // the intrinsic accessor; a failure isolates to `null` and never changes
    // the call. The provider may still mutate the buffer in place, so the
    // observed length is the application's argument as handed over.
    const bytes = intrinsicByteLength(data);
    const call = (): Promise<void> =>
      options === undefined
        ? this.#provider.put(path, data)
        : this.#provider.put(path, data, options);
    await observeStorageCall(collector, 'put', call, () => bytes);
  }

  /**
   * Retrieves an object.
   *
   * @param path - Object path/key
   * @returns The object bytes
   * @throws {Error} If the object does not exist
   */
  async get(path: string): Promise<Uint8Array> {
    const collector = collectors.get(this);
    if (collector === undefined) {
      return await this.#readBuffered(path);
    }
    // Bytes are measured on successful settlement, through the intrinsic
    // accessor; a failure isolates to `null` and never changes the result.
    return await observeStorageCall(
      collector,
      'get',
      () => this.#readBuffered(path),
      (value) => intrinsicByteLength(value),
    );
  }

  /**
   * Deletes an object.
   *
   * @param path - Object path/key
   * @returns `true` if an object was deleted
   */
  async delete(path: string): Promise<boolean> {
    const collector = collectors.get(this);
    if (collector === undefined) {
      return this.#provider.delete(path);
    }
    return await observeStorageCall(collector, 'delete', () => this.#provider.delete(path), null);
  }

  /**
   * Reports whether an object exists.
   *
   * @param path - Object path/key
   * @returns `true` if present
   */
  async exists(path: string): Promise<boolean> {
    const collector = collectors.get(this);
    if (collector === undefined) {
      return this.#provider.exists(path);
    }
    return await observeStorageCall(collector, 'exists', () => this.#provider.exists(path), null);
  }

  /**
   * Creates a time-limited URL granting direct access to an object.
   *
   * @param path - Object path/key
   * @param options - URL validity
   * @returns The signed URL
   */
  async getSignedUrl(path: string, options: SignedUrlOptions): Promise<string> {
    const collector = collectors.get(this);
    if (collector === undefined) {
      return this.#provider.getSignedUrl(path, options);
    }
    // Outcome and age only: the returned URL is never read, and the record
    // carries no duration.
    return await observeStorageCall(
      collector,
      'getSignedUrl',
      () => this.#provider.getSignedUrl(path, options),
      null,
    );
  }

  /**
   * Retrieves an object as a streaming body for zero-copy downloads.
   *
   * Delegates to the provider's optional `getStream`; falls back to wrapping
   * the buffered `get` result in a one-chunk `ReadableStream` when the provider
   * lacks native streaming support.
   *
   * Observation records the ACQUISITION of the stream — or, for the buffered
   * fallback, the buffered read behind it — and its outcome. Transfer
   * completion is unknown and never claimed: the stream is returned to the
   * caller untouched, with no diagnostic read, tee, wrap or listener.
   *
   * @param path - Object path/key
   * @returns A `ReadableStream` of object bytes
   * @throws {Error} If the object does not exist
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const collector = collectors.get(this);
    const streamFn = this.#provider.getStream;
    if (collector === undefined) {
      if (streamFn !== undefined) {
        const stream = await streamFn.call(this.#provider, path);
        if (stream === null) {
          throw new Error(`Storage object not found: ${path}`);
        }
        return stream;
      }
      return await this.#readBufferedStream(path);
    }
    if (streamFn !== undefined) {
      return await observeStorageCall(collector, 'getStream', async () => {
        const stream = await streamFn.call(this.#provider, path);
        if (stream === null) {
          throw new Error(`Storage object not found: ${path}`);
        }
        return stream;
      }, null);
    }
    // Buffered fallback: the UNOBSERVED read is shared with `get`, so exactly
    // ONE `getStream` observation exists per public call and a concurrent
    // public `get` is counted under its own operation.
    return await observeStorageCall(
      collector,
      'getStream',
      () => this.#readBufferedStream(path),
      null,
    );
  }

  /**
   * The unobserved buffered read: the provider call and the absent→throw
   * conversion, shared by public `get` and the `getStream` fallback.
   *
   * @param path - Object path/key
   * @returns The object bytes
   * @throws {Error} If the object does not exist
   */
  async #readBuffered(path: string): Promise<Uint8Array> {
    const data = await this.#provider.get(path);
    if (data === null) {
      throw new Error(`Storage object not found: ${path}`);
    }
    return data;
  }

  /**
   * The unobserved buffered stream: the shared buffered read wrapped in a
   * one-chunk `ReadableStream`.
   *
   * @param path - Object path/key
   * @returns A `ReadableStream` of object bytes
   * @throws {Error} If the object does not exist
   */
  async #readBufferedStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.#readBuffered(path);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
}
