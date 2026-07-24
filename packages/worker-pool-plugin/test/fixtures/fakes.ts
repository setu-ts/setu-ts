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
} from '@hono-enterprise/common';
import { isWorkerTaskRequest } from '@hono-enterprise/common';

/**
 * Scriptable worker handle. Tests trigger protocol traffic explicitly via
 * `emitReady` / `replyOk` / `replyError` / `emitWorkerError`.
 */
export class FakeHandle implements IWorkerHandle {
  readonly requests: WorkerTaskRequest[] = [];
  terminated = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  postMessage(message: unknown): void {
    if (isWorkerTaskRequest(message)) {
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
}

/** Worker host fake recording every spawn. */
export class FakeHost implements IWorkerHost {
  readonly handles: FakeHandle[] = [];
  readonly spawnedSpecifiers: string[] = [];

  constructor(private readonly parallelism = 2) {}

  spawn(specifier: string): IWorkerHandle {
    const handle = new FakeHandle();
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
    setInterval: () => 0,
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
