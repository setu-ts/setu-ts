/**
 * Cancellation-safe web-stream adapters over SDK-provided sources.
 *
 * Internal seam — NOT part of the package's public surface. Three providers
 * hand out a web `ReadableStream<Uint8Array>` from `getStream()`, and until
 * the fix branch all three did so in a way that could crash the PROCESS when
 * a consumer cancelled a download mid-flight:
 *
 * - **S3Provider** returned `res.Body.transformToWebStream()` unwrapped. The
 *   AWS SDK body is a node Readable (a `ChecksumStream`), and Deno adapts it
 *   through `ext:deno_node/internal/webstreams/adapters.js`. `reader.cancel()`
 *   closes the web controller synchronously, but the adapter's node-side
 *   teardown is asynchronous — a `'data'` emission already inside node's flow
 *   machinery (`resume_` → `flow` → `emit`) lands after the close and the
 *   adapter's `onData` calls `controller.enqueue()` on the closed controller.
 *   The resulting `TypeError: The stream controller cannot close or enqueue`
 *   escapes the event-emitter callback as an UNCAUGHT, process-killing error.
 *   That is an upstream `deno_node` adapter defect (still present in Deno
 *   2.9.6, reproduced byte-identically); this module works around it by never
 *   routing an S3 body through that adapter at all.
 * - **GcsProvider** and **AzureBlobProvider** pumped their SDK stream into
 *   `controller.enqueue()` with **no `cancel` hook at all**, so a cancelled
 *   download left the underlying node stream flowing and the very next chunk
 *   deterministically hit the closed controller — the same uncaught TypeError,
 *   plus a leaked upstream connection.
 *
 * Two adapters cover the three providers:
 *
 * - {@linkcode createBoundedNodeStream} — pull-driven over a node Readable
 *   (S3). The web stream's own high-water mark bounds read-ahead: this is the
 *   "pull()-driven adapter" shape `test/integration/stream-backpressure-real.test.ts`
 *   measured at ~3.2 MiB against the ~3.1 MiB the adapter produced, i.e. no
 *   regression of the demand-driven property that suite pins.
 * - {@linkcode createEagerIterableStream} — eager drain with a cancellation
 *   guard (GCS/Azure). Deliberately PRESERVES those providers' documented
 *   eager behavior (the storage README's per-provider table) and adds only
 *   what was missing: a `cancel` hook that stops the pump, releases the
 *   iterator, destroys the upstream, and makes a late chunk a deliberate
 *   drop instead of an uncaught throw.
 *
 * @module
 */

/**
 * Structural shape of the node.js Readable this module can drive safely.
 *
 * Declared structurally (no `node:` import) because the providers must
 * compile on every runtime; the only caller is the S3 body path, where the
 * SDK supplies a real node Readable (a `Transform` subclass) on Deno, Node
 * and Bun alike.
 *
 * @since 0.8.0
 */
export interface NodeSdkReadable {
  /** Registers a listener; used for `'readable'`, `'end'` and `'error'`. */
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Registers a one-shot listener (`'end'`, `'error'`). */
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Removes a listener registered with {@linkcode NodeSdkReadable.on}. */
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Paused-mode read: the next buffered chunk, or `null` when empty. */
  read(size?: number): Uint8Array | null;
  /** Tears the stream down and aborts its underlying work. */
  destroy(error?: Error): void;
  /** `true` once `'end'` has fired (node sets this; treated as advisory). */
  readableEnded?: boolean;
  /** The recorded error, when the stream has errored (advisory). */
  errored?: Error | null;
}

/**
 * Reports whether a value is a node Readable this module can drive.
 *
 * The real SDK body (`ChecksumStream`), a `PassThrough`, and any faithful
 * fake pass; plain objects, web `ReadableStream`s, and `Uint8Array` bodies
 * do not. Used by `S3Provider.getStream` to pick this module's wrapper over
 * the adapter-produced stream, and by tests to classify fakes.
 *
 * @param value - The candidate value
 * @returns `true` when the value carries the full {@linkcode NodeSdkReadable} shape
 * @since 0.8.0
 */
export function looksLikeNodeReadable(value: unknown): value is NodeSdkReadable {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof NodeSdkReadable, unknown>>;
  return (
    typeof candidate.on === 'function' &&
    typeof candidate.once === 'function' &&
    typeof candidate.off === 'function' &&
    typeof candidate.read === 'function' &&
    typeof candidate.destroy === 'function'
  );
}

/**
 * Wraps a node Readable in a demand-driven, cancellation-safe web stream.
 *
 * `pull` reads ONE chunk per call in paused mode (`'readable'` + `read()`),
 * so the web stream's high-water mark — not an eager pump — bounds how far
 * the provider reads ahead of a slow consumer. `cancel()` sets the closed
 * flag and destroys the underlying stream BEFORE returning, which both
 * aborts the upstream HTTP request and stops the flow machinery that would
 * otherwise emit a late `'data'`. Because a chunk can already be inside the
 * event machinery when cancel runs, every controller touch is guarded by the
 * closed flag: a late chunk after an explicit cancel is a DELIBERATE drop
 * (the consumer asked for the stream to stop), never an enqueue into a
 * closed controller and never a silent swallow of an error the consumer
 * still wants — errors and completion are suppressed only once the consumer
 * has cancelled.
 *
 * @param readable - The node Readable to wrap (an S3 SDK body)
 * @returns A bounded, cancellation-safe stream of the object's chunks
 * @since 0.8.0
 */
export function createBoundedNodeStream(readable: NodeSdkReadable): ReadableStream<Uint8Array> {
  let closed = false;
  let recorded: Error | null = null;
  // Node throws an UNHANDLED 'error' when a stream emits one with no listener
  // attached, and `pull` only holds a listener while a read is outstanding —
  // so between pulls, which is exactly where a slow consumer sits once the
  // web queue is full, a mid-download origin failure would escape as an
  // uncaught, process-killing error. This listener lives for the whole stream
  // and records the failure for the next pull to surface to the consumer.
  const retain = (error: unknown): void => {
    recorded ??= error instanceof Error ? error : new Error(String(error));
  };
  readable.on('error', retain);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        // (pull is never called once the stream is cancelled — the spec
        // forbids it in the closed state — so no closed guard is needed
        // here; every controller touch below is guarded instead.)
        const detach = (): void => {
          readable.off('readable', onReadable);
          readable.off('end', onEnd);
          readable.off('error', onError);
        };
        const settle = (deliver: (() => void) | null): void => {
          detach();
          try {
            if (!closed && deliver !== null) deliver();
          } finally {
            resolve();
          }
        };
        const onReadable = (): void => {
          if (closed) {
            settle(null);
            return;
          }
          const chunk = readable.read();
          if (chunk === null) return; // nothing buffered yet — keep waiting
          settle(() => controller.enqueue(chunk));
        };
        const onEnd = (): void => settle(() => controller.close());
        const onError = (error: unknown): void =>
          settle(() => controller.error(error instanceof Error ? error : new Error(String(error))));
        readable.on('readable', onReadable);
        readable.once('end', onEnd);
        readable.once('error', onError);
        // The stream may have ended or errored before this first pull ran
        // (an empty object errors/ends during SDK response assembly), and
        // node will not re-emit either event retroactively.
        if (readable.readableEnded === true) {
          settle(() => controller.close());
          return;
        }
        const pending = recorded ?? readable.errored;
        if (pending != null) {
          settle(() => controller.error(pending));
          return;
        }
        onReadable(); // a chunk may already be buffered
      });
    },
    cancel(): void {
      closed = true;
      // `retain` stays attached deliberately: `destroy()` tears the stream
      // down asynchronously and may still emit 'error', which with no
      // listener would be the very uncaught throw this guard exists to stop.
      readable.destroy();
    },
  });
}

/**
 * Structural type of the sources {@linkcode createEagerIterableStream} accepts.
 *
 * `destroy` is optional because the Azure body is typed as a bare
 * `AsyncIterable` while the GCS read stream is typed as `NodeJS.ReadableStream`;
 * at runtime both are node Readables whose `destroy` aborts the underlying
 * HTTP request. When absent, cancellation still releases the iterator.
 *
 * @since 0.8.0
 */
export type EagerIterableSource = AsyncIterable<Uint8Array> & {
  destroy?: (error?: Error) => void;
};

/**
 * Wraps an async iterable in an eager-draining, cancellation-safe web stream.
 *
 * Behavior-preserving for `GcsProvider` and `AzureBlobProvider`: chunks are
 * enqueued as fast as the source produces them (the documented eager drain —
 * NOT demand-driven; the storage README's per-provider table says so), and
 * source errors reach the consumer through `controller.error`. What the
 * adapters those providers hand-rolled before lacked is added here: the
 * `cancel` hook sets the closed flag, releases the iterator (`return()`,
 * which for node Readables destroys them), destroys the upstream when the
 * shape allows — aborting the HTTP request instead of leaking the
 * connection — and turns a chunk already in flight at cancel time into a
 * deliberate drop rather than an enqueue into a closed controller.
 *
 * @param source - The SDK's iterable body (GCS `createReadStream()`, Azure
 *                 `readableStreamBody`); `destroy` is optional and used when present
 * @returns An eager, cancellation-safe stream of the object's chunks
 * @since 0.8.0
 */
export function createEagerIterableStream(source: EagerIterableSource): ReadableStream<Uint8Array> {
  let closed = false;
  let iterator: AsyncIterator<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      iterator = source[Symbol.asyncIterator]();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await iterator.next();
            if (closed) return; // consumer cancelled — remaining bytes are garbage by contract
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (error) {
          if (!closed) {
            controller.error(error instanceof Error ? error : new Error(String(error)));
          }
        }
      })();
    },
    cancel(): void {
      closed = true;
      const pending = iterator;
      void pending?.return?.()?.catch(() => {
        // The iterator's own teardown failed after we are already closing;
        // nothing further can be reported to a cancelled consumer.
      });
      try {
        source.destroy?.();
      } catch {
        // Already destroyed — destroying twice is a no-op on node streams.
      }
    },
  });
}
