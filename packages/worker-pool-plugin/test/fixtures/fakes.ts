/**
 * Test fakes for the worker-pool plugin: a scriptable worker host/handle
 * pair, deterministic manual timers, and a fake `IRuntimeServices`.
 *
 * @module
 */
import type {
  IRuntimeServices,
  IWorkerHandle,
  IWorkerHost,
  RuntimePlatform,
  TimerHandle,
  WorkerErrorShape,
  WorkerTaskRequest,
} from '@setu-ts/common';
import { isWorkerTaskRequest } from '@setu-ts/common';

/**
 * Scriptable worker handle. Tests trigger protocol traffic explicitly via
 * `emitReady` / `replyOk` / `replyError` / `emitWorkerError`.
 */
export class FakeHandle implements IWorkerHandle {
  readonly requests: WorkerTaskRequest[] = [];
  terminated = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private exitListener: ((code: number | null) => void) | null = null;

  /**
   * @param onPostMessage - Inspected before the request is recorded. Throwing
   * from it reproduces a real `postMessage` refusing a non-cloneable input:
   * the throw propagates to the caller AND the worker never sees the request,
   * which is what makes the X8-2 path testable.
   * @param reportsExit - When `false`, `onExit` is ABSENT on this handle, which
   * is what Deno's web-worker host produces; the pool must then behave exactly
   * as it did before X8-7.
   */
  constructor(
    private readonly onPostMessage?: (request: WorkerTaskRequest) => void,
    readonly reportsExit = false,
  ) {
    if (reportsExit) {
      // Assigned rather than declared as a method so the member is genuinely
      // absent (`'onExit' in handle === false`) on a non-reporting handle,
      // matching how the web host omits it.
      this.onExit = (listener: (code: number | null) => void): void => {
        this.exitListener = listener;
      };
    }
  }

  /**
   * Present only on a reporting handle; see the constructor.
   *
   * `declare` so the field emits NOTHING: a plain optional declaration is
   * defined on every instance as `undefined` under `useDefineForClassFields`,
   * which would make `'onExit' in handle` true on a Deno-shaped handle and
   * misrepresent the one thing this fake exists to distinguish.
   */
  declare onExit?: (listener: (code: number | null) => void) => void;

  postMessage(message: unknown): void {
    if (isWorkerTaskRequest(message)) {
      this.onPostMessage?.(message);
      this.requests.push(message);
    }
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  terminate(): Promise<void> {
    this.terminated = true;
    // A real reporting runtime raises its exit event for a host-requested
    // terminate too — Bun emits `close` with code 0 after `terminate()`
    // (measured). Reproducing that here is what actually exercises the pool's
    // intentional-termination guard; a fake that stayed silent would let a
    // missing guard pass.
    this.exitListener?.(0);
    return Promise.resolve();
  }

  /** Signals protocol readiness to the pool. */
  emitReady(): void {
    this.messageListener?.({ __hewp: 1, kind: 'ready' });
  }

  /** Answers the request at `index` (default: latest) with a result. */
  replyOk(result: unknown, index?: number): void {
    const request = this.requests[index ?? this.requests.length - 1];
    this.messageListener?.({ __hewp: 1, kind: 'reply', id: request.id, ok: true, result });
  }

  /** Answers the request at `index` (default: latest) with a task error. */
  replyError(error: WorkerErrorShape, index?: number): void {
    const request = this.requests[index ?? this.requests.length - 1];
    this.messageListener?.({ __hewp: 1, kind: 'reply', id: request.id, ok: false, error });
  }

  /** Delivers an arbitrary raw message to the pool. */
  emitRaw(message: unknown): void {
    this.messageListener?.(message);
  }

  /** Simulates a worker-level crash. */
  emitWorkerError(error: Error): void {
    this.errorListener?.(error);
  }

  /** Simulates the worker's thread ending on its own (no error precedes it). */
  emitExit(code: number | null = 0): void {
    this.exitListener?.(code);
  }
}

/** Worker host fake recording every spawn. */
export class FakeHost implements IWorkerHost {
  readonly handles: FakeHandle[] = [];
  readonly spawnedSpecifiers: string[] = [];

  /**
   * @param parallelism - Reported by `availableParallelism()`
   * @param onPostMessage - Passed to every handle this host spawns; see
   * {@linkcode FakeHandle}
   */
  constructor(
    private readonly parallelism = 2,
    private readonly onPostMessage?: (request: WorkerTaskRequest) => void,
    /**
     * Whether the handles this host spawns implement `onExit`. Mirrors the real
     * split: `true` is the Node/Bun hosts, `false` is Deno's.
     */
    private readonly exitReporting = false,
  ) {
    if (exitReporting) {
      this.reportsExit = (): boolean => true;
    }
  }

  /**
   * Present only on a reporting host, matching the real hosts' shape.
   * `declare` for the same reason as {@linkcode FakeHandle.onExit}.
   */
  declare reportsExit?: () => boolean;

  spawn(specifier: string): IWorkerHandle {
    const handle = new FakeHandle(this.onPostMessage, this.exitReporting);
    this.handles.push(handle);
    this.spawnedSpecifiers.push(specifier);
    return handle;
  }

  availableParallelism(): number {
    return this.parallelism;
  }
}

/** Deterministic manual timers driven by `fire()`. */
export class FakeTimers {
  private readonly pending = new Map<number, () => void>();
  private nextId = 1;
  /**
   * Every `setInterval` call made through the runtime this fixture backs.
   * The metrics design is a push from state transitions with NO timer, so a
   * test asserts this stays empty (M53: an interval that outlives `onClose`
   * leaks, and `clearInterval` can silently no-op).
   */
  readonly intervals: number[] = [];

  setTimeout(fn: () => void, _ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending.delete(handle as number);
  }

  /** Number of armed timers. */
  get armed(): number {
    return this.pending.size;
  }

  /** Records an interval registration; never fires it. */
  setInterval(_fn: () => void, ms: number): TimerHandle {
    this.intervals.push(ms);
    return this.nextId++;
  }

  /** Fires every armed timer. */
  fire(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

/**
 * Creates a fake `IRuntimeServices` whose timers are the given
 * {@linkcode FakeTimers}; `workers` is included only when provided.
 */
export function createFakeRuntime(
  timers: FakeTimers,
  workers?: IWorkerHost,
): IRuntimeServices {
  const base: IRuntimeServices = {
    platform: (): RuntimePlatform => 'deno',
    version: () => '2.0.0',
    hostname: () => 'test-host',
    uuid: () => '00000000-0000-0000-0000-000000000000',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as Crypto['subtle'],
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (handle) => timers.clearTimeout(handle),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: () => undefined,
    env: {},
    exit: (() => {
      throw new Error('exit called');
    }) as () => never,
  };
  return {
    ...base,
    ...(workers !== undefined ? { workers } : {}),
  };
}
