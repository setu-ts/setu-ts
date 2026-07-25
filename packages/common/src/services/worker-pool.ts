/**
 * Worker pool contracts — running CPU-bound tasks on real threads, plus the
 * host↔worker message protocol shared by the runtime's worker-side helper and
 * the WorkerPoolPlugin's host-side pool.
 *
 * The protocol lives here (not in either package) because the runtime package
 * wires the worker side and the worker-pool plugin wires the host side, and
 * plugins never import other plugins (AI_GUIDELINES §3.3) — `common` is the
 * only shared home.
 *
 * @module
 */

/**
 * Options for one {@linkcode IWorkerPool.run} call.
 *
 * @since 0.1.0
 */
export interface WorkerRunOptions {
  /**
   * Per-call task timeout in milliseconds, overriding the pool's configured
   * timeout. `0` disables the timeout for this call.
   */
  readonly timeoutMs?: number;
}

/**
 * A snapshot of one task-module pool's state, returned by
 * {@linkcode IWorkerPool.stats}.
 *
 * @since 0.1.0
 */
export interface TaskPoolStats {
  /** The task-module specifier this pool executes. */
  readonly taskModule: string;
  /** Workers currently alive in the pool. */
  readonly workers: number;
  /** Workers currently executing a task. */
  readonly busy: number;
  /** Tasks waiting in the pool's queue. */
  readonly queued: number;
  /** Tasks completed successfully since the pool was created. */
  readonly completed: number;
  /** Tasks failed (error, crash, or timeout) since the pool was created. */
  readonly failed: number;
}

/**
 * A pool of worker threads executing task modules off the event loop.
 *
 * A task module is an ES module owned by the application that registers its
 * handler via `defineWorkerTask` (from `@hono-enterprise/runtime/worker`).
 * Tasks are addressed by module specifier — never by closure, because
 * functions cannot cross a thread boundary. Inputs and outputs travel by
 * structured clone.
 *
 * @example
 * ```typescript
 * const pool = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
 * const thumb = await pool.run<Uint8Array, Uint8Array>(
 *   new URL('./tasks/resize-image.ts', import.meta.url).href,
 *   imageBytes,
 * );
 * ```
 * @since 0.1.0
 */
export interface IWorkerPool {
  /**
   * Runs a task on a pool worker for the given task module, creating the
   * pool lazily on first use.
   *
   * @param taskModule - Module specifier of a task module that calls
   * `defineWorkerTask`
   * @param input - Structured-clonable task input
   * @param options - Per-call options
   * @returns The task's structured-clonable output
   * @throws `WorkerPoolUnavailableError` when the runtime has no worker
   * support (e.g. Cloudflare Workers)
   * @throws `WorkerTaskError` when the task handler throws or the worker
   * crashes
   * @throws `WorkerTaskTimeoutError` when the task exceeds its timeout
   * @throws `WorkerQueueFullError` when the pool's pending queue is at its
   * bound
   */
  run<TInput, TOutput>(
    taskModule: string,
    input: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput>;
  /**
   * Returns a snapshot of every pool created so far.
   *
   * @returns One {@linkcode TaskPoolStats} per task module
   */
  stats(): readonly TaskPoolStats[];
  /**
   * Terminates every worker in every pool and rejects pending tasks. Called
   * by the plugin's `onClose` hook; safe to call more than once.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Host ↔ worker message protocol
// ---------------------------------------------------------------------------

/**
 * Serialized shape of an error crossing the thread boundary in a
 * {@linkcode WorkerTaskReply}.
 *
 * @since 0.1.0
 */
export interface WorkerErrorShape {
  /** The remote error's `name`. */
  readonly name: string;
  /** The remote error's `message`. */
  readonly message: string;
  /** The remote error's `stack`, when available. */
  readonly stack?: string;
}

/**
 * Posted once by the worker side (`defineWorkerTask`) after its message
 * handler is wired; the pool dispatches tasks only to ready workers.
 *
 * The `__hewp` marker (Hono Enterprise Worker Protocol) distinguishes
 * protocol envelopes from unrelated messages, which both sides ignore.
 *
 * @since 0.1.0
 */
export interface WorkerReadySignal {
  /** Protocol marker. */
  readonly __hewp: 1;
  /** Discriminant. */
  readonly kind: 'ready';
}

/**
 * A task dispatch posted by the pool to a worker.
 *
 * @since 0.1.0
 */
export interface WorkerTaskRequest {
  /** Protocol marker. */
  readonly __hewp: 1;
  /** Discriminant. */
  readonly kind: 'task';
  /** Correlation id, unique per pool. */
  readonly id: number;
  /** Structured-clonable task input. */
  readonly input: unknown;
}

/**
 * A task outcome posted by the worker back to the pool.
 *
 * @since 0.1.0
 */
export interface WorkerTaskReply {
  /** Protocol marker. */
  readonly __hewp: 1;
  /** Discriminant. */
  readonly kind: 'reply';
  /** Correlation id echoed from the request. */
  readonly id: number;
  /** Whether the task handler returned normally. */
  readonly ok: boolean;
  /** The handler's return value when `ok` is `true`. */
  readonly result?: unknown;
  /** The serialized error when `ok` is `false`. */
  readonly error?: WorkerErrorShape;
}

function isEnvelope(message: unknown): message is { __hewp: 1; kind: string } {
  return typeof message === 'object' && message !== null &&
    (message as { __hewp?: unknown }).__hewp === 1 &&
    typeof (message as { kind?: unknown }).kind === 'string';
}

/**
 * Narrows an incoming message to a {@linkcode WorkerReadySignal}.
 *
 * @param message - Any message received from a worker
 * @returns Whether the message is a ready signal
 * @since 0.1.0
 */
export function isWorkerReadySignal(message: unknown): message is WorkerReadySignal {
  return isEnvelope(message) && message.kind === 'ready';
}

/**
 * Narrows an incoming message to a {@linkcode WorkerTaskRequest}.
 *
 * @param message - Any message received inside a worker
 * @returns Whether the message is a task request
 * @since 0.1.0
 */
export function isWorkerTaskRequest(message: unknown): message is WorkerTaskRequest {
  return isEnvelope(message) && message.kind === 'task' &&
    typeof (message as { id?: unknown }).id === 'number';
}

/**
 * Narrows an incoming message to a {@linkcode WorkerTaskReply}.
 *
 * @param message - Any message received from a worker
 * @returns Whether the message is a task reply
 * @since 0.1.0
 */
export function isWorkerTaskReply(message: unknown): message is WorkerTaskReply {
  return isEnvelope(message) && message.kind === 'reply' &&
    typeof (message as { id?: unknown }).id === 'number' &&
    typeof (message as { ok?: unknown }).ok === 'boolean';
}
