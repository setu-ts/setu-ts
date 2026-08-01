/**
 * Test fixtures for the service discovery plugin.
 *
 * The fake runtime's `hrtime()` is a manually-advanced MONOTONIC counter,
 * matching how the real runtime produces it — a fixture returning a wall-clock
 * epoch here would make a broken window comparison pass. Timers are captured
 * rather than scheduled, so poll ticks are driven deterministically.
 *
 * @module
 */
import type {
  IDnsResolver,
  IRuntimeServices,
  ServiceInstance,
  SrvRecord,
  TimerHandle,
  Unsubscribe,
} from '@hono-enterprise/common';
import type {
  DiscoveryHttpResponse,
  DiscoveryHttpStream,
  DiscoveryProvider,
  IDiscoveryHttp,
} from '../../src/interfaces/index.ts';

/** One captured timer. */
export interface CapturedTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

/** A fake runtime with a controllable monotonic clock and captured timers. */
export interface FakeRuntime extends IRuntimeServices {
  /** Advances the monotonic clock by `ms`. */
  advance(ms: number): void;
  /** Timeouts registered, in registration order. */
  readonly timeouts: CapturedTimer[];
  /** Intervals registered, in registration order. */
  readonly intervals: CapturedTimer[];
  /** Runs every live timeout callback once and marks it cleared. */
  runTimeouts(): void;
  /** Runs every live interval callback once. */
  runIntervals(): void;
  /** Sets the bytes `randomBytes` hands out. */
  setRandomBytes(bytes: Uint8Array<ArrayBuffer>): void;
}

/** Options for {@linkcode createFakeRuntime}. */
export interface FakeRuntimeOptions {
  /** Environment map. */
  readonly env?: Record<string, string | undefined>;
  /** File system, when the test needs one. */
  readonly fs?: IRuntimeServices['fs'];
  /** DNS resolver, when the test needs one. */
  readonly dns?: IDnsResolver;
}

/**
 * Creates the fake runtime.
 *
 * @param options - Environment, file system, and DNS resolver
 * @returns The fake runtime
 */
export function createFakeRuntime(options?: FakeRuntimeOptions): FakeRuntime {
  let uuidCounter = 0;
  let monotonic = 1000;
  let randomBytes: Uint8Array<ArrayBuffer> = new Uint8Array([0, 0, 0, 0]);
  const timeouts: CapturedTimer[] = [];
  const intervals: CapturedTimer[] = [];

  return {
    platform: () => 'deno' as const,
    version: () => 'test',
    hostname: () => 'localhost',
    uuid: () => `uuid-${uuidCounter++}`,
    randomBytes: (length: number) => randomBytes.slice(0, length),
    subtle: {} as SubtleCrypto,
    now: () => 1_700_000_000_000,
    hrtime: () => monotonic,
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      const entry: CapturedTimer = { fn, ms, cleared: false };
      timeouts.push(entry);
      return entry as unknown as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle) => {
      markCleared(handle);
    },
    setInterval: (fn: () => void, ms: number): TimerHandle => {
      const entry: CapturedTimer = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry as unknown as TimerHandle;
    },
    clearInterval: (handle: TimerHandle) => {
      markCleared(handle);
    },
    env: options?.env ?? {},
    exit: () => {
      throw new Error('exit called');
    },
    ...(options?.fs !== undefined ? { fs: options.fs } : {}),
    ...(options?.dns !== undefined ? { dns: options.dns } : {}),
    advance(ms: number): void {
      monotonic += ms;
    },
    timeouts,
    intervals,
    runTimeouts(): void {
      for (const entry of timeouts) {
        if (!entry.cleared) {
          entry.cleared = true;
          entry.fn();
        }
      }
    },
    runIntervals(): void {
      for (const entry of intervals) {
        if (!entry.cleared) {
          entry.fn();
        }
      }
    },
    setRandomBytes(bytes: Uint8Array<ArrayBuffer>): void {
      randomBytes = bytes;
    },
  };
}

function markCleared(handle: TimerHandle): void {
  const entry = handle as unknown as { cleared: boolean } | null;
  if (entry !== null && typeof entry === 'object') {
    entry.cleared = true;
  }
}

/** Builds a `ServiceInstance` with sensible defaults. */
export function instance(
  overrides: Partial<ServiceInstance> & Pick<ServiceInstance, 'id'>,
): ServiceInstance {
  return {
    serviceName: 'billing',
    host: '10.0.0.1',
    port: 8080,
    ...overrides,
  };
}

/** A provider whose answers and call count the test controls. */
export interface FakeProvider extends DiscoveryProvider {
  /** How many times `resolve` was called. */
  readonly resolveCalls: number;
  /** How many times an unsubscribe returned by `watch` was invoked. */
  readonly unsubscribeCalls: number;
  /** Sets what `resolve` returns next. */
  setInstances(instances: readonly ServiceInstance[]): void;
  /** Makes the next `resolve` calls reject with this error. */
  failWith(error: Error | null): void;
  /** Pushes a change to every active watch listener. */
  emit(serviceName: string, instances: readonly ServiceInstance[]): void;
}

/**
 * Creates a call-counting fake provider.
 *
 * @param initial - Instances `resolve` returns until changed
 * @returns The fake provider
 */
export function createFakeProvider(
  initial: readonly ServiceInstance[] = [],
): FakeProvider {
  let instances = initial;
  let failure: Error | null = null;
  let resolveCalls = 0;
  let unsubscribeCalls = 0;
  const listeners = new Map<string, Set<(list: readonly ServiceInstance[]) => void>>();

  return {
    kind: 'fake',
    get resolveCalls() {
      return resolveCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    resolve(_serviceName: string): Promise<readonly ServiceInstance[]> {
      resolveCalls++;
      return failure !== null ? Promise.reject(failure) : Promise.resolve(instances);
    },
    watch(
      serviceName: string,
      listener: (list: readonly ServiceInstance[]) => void,
    ): Promise<Unsubscribe> {
      const set = listeners.get(serviceName) ?? new Set();
      set.add(listener);
      listeners.set(serviceName, set);
      return Promise.resolve(() => {
        unsubscribeCalls++;
        set.delete(listener);
      });
    },
    setInstances(next: readonly ServiceInstance[]): void {
      instances = next;
    },
    failWith(error: Error | null): void {
      failure = error;
    },
    emit(serviceName: string, next: readonly ServiceInstance[]): void {
      for (const listener of listeners.get(serviceName) ?? []) {
        listener(next);
      }
    },
  };
}

/** One scripted HTTP answer. */
export interface ScriptedResponse {
  /** Status code (defaults to 200). */
  readonly status?: number;
  /** Response headers. */
  readonly headers?: Record<string, string>;
  /** Body text for `request`. */
  readonly text?: string;
  /** Body chunks for `stream`; `null` means a bodiless response. */
  readonly chunks?: readonly string[] | null;
  /** When set, the call rejects with this error. */
  readonly error?: Error;
}

/** One recorded HTTP call. */
export interface RecordedCall {
  /** The URL requested. */
  readonly url: string;
  /** The init passed. */
  readonly init: RequestInit | undefined;
  /** Whether it went through `stream` rather than `request`. */
  readonly streaming: boolean;
}

/** A fake HTTP seam driven by a script. */
export interface FakeHttp extends IDiscoveryHttp {
  /** Every call, in order. */
  readonly calls: RecordedCall[];
  /** Queues further answers. */
  push(...responses: ScriptedResponse[]): void;
}

/**
 * Creates a scripted HTTP seam.
 *
 * The last scripted answer repeats once the script runs out, so a watch loop
 * under test does not fall off the end of its script.
 *
 * @param script - The answers, in order
 * @returns The fake seam
 */
export function createFakeHttp(script: ScriptedResponse[] = []): FakeHttp {
  const queue = [...script];
  const calls: RecordedCall[] = [];
  let last: ScriptedResponse = { text: '[]' };

  const next = (): ScriptedResponse => {
    const entry = queue.shift();
    if (entry !== undefined) {
      last = entry;
      return entry;
    }
    return last;
  };

  return {
    calls,
    push(...responses: ScriptedResponse[]): void {
      queue.push(...responses);
    },
    request(url: string, init?: RequestInit): Promise<DiscoveryHttpResponse> {
      calls.push({ url, init, streaming: false });
      const entry = next();
      if (entry.error !== undefined) {
        return Promise.reject(entry.error);
      }
      const status = entry.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(entry.headers ?? {}),
        text: entry.text ?? '[]',
      });
    },
    stream(url: string, init?: RequestInit): Promise<DiscoveryHttpStream> {
      calls.push({ url, init, streaming: true });
      const entry = next();
      if (entry.error !== undefined) {
        return Promise.reject(entry.error);
      }
      const status = entry.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(entry.headers ?? {}),
        body: entry.chunks === null || entry.chunks === undefined ? null : streamOf(entry.chunks),
      });
    },
  };
}

/** Builds a readable stream over the given text chunks. */
export function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

/** A DNS resolver whose answers the test controls. */
export function createFakeDns(
  answers: {
    srv?: readonly SrvRecord[] | Error;
    a?: readonly string[] | Error;
    aaaa?: readonly string[] | Error;
  },
): IDnsResolver {
  return {
    resolveSrv(): Promise<readonly SrvRecord[]> {
      const value = answers.srv ?? [];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
    resolveHost(): Promise<readonly string[]> {
      const value = answers.a ?? [];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
}
