/**
 * A faithful {@linkcode IRuntimeServices} test double.
 *
 * Deliberately not a partial object cast through `unknown`: a permissive fake
 * hides the bug it is supposed to catch, and Milestone 33 had to repair exactly
 * this class of infidelity in the testing package — an `env` that was a `Map`
 * cast to a `Record`, a `subtle` that was `null`, a `randomBytes(n)` returning
 * zero bytes, and timers that were real rather than inert. Each of those is
 * honored here instead:
 *
 * - `subtle` is the REAL `crypto.subtle`, because the session codec's whole value
 *   is that a tampered cookie fails an authentication tag.
 * - `randomBytes(n)` returns exactly `n` bytes.
 * - `env` is a plain object, matching the declared `Readonly<Record<…>>`.
 * - timers are inert and recorded, so nothing escapes into real time.
 * - `now()` is a controllable wall clock and `hrtime()` is a separate monotonic
 *   reading, so a test cannot accidentally pass by mixing the two.
 * - `exit()` throws rather than ending the test process.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform, TimerHandle } from '@hono-enterprise/common';

/** A recorded timer registration. */
export interface RecordedTimer {
  readonly kind: 'timeout' | 'interval';
  readonly fn: () => void;
  readonly ms: number;
  readonly handle: TimerHandle;
}

/** A fake runtime plus the handles a test needs to drive it. */
export interface FakeRuntime {
  readonly runtime: IRuntimeServices;
  /** Timers registered and not yet cleared. */
  readonly timers: RecordedTimer[];
  /** Handles passed to `clearTimeout` / `clearInterval`. */
  readonly cleared: TimerHandle[];
  /** Advances the wall clock and the monotonic clock together. */
  advance(ms: number): void;
  /** Runs every registered interval callback once. */
  tick(): void;
}

/** Options for {@linkcode createFakeRuntime}. */
export interface FakeRuntimeOptions {
  /** Initial wall-clock reading in milliseconds. */
  readonly now?: number;
  /** Environment variables. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Platform reported by `platform()`. */
  readonly platform?: RuntimePlatform;
}

/**
 * Creates a faithful fake runtime.
 *
 * @param options - Starting clock, environment, and platform
 * @returns The runtime and its test handles
 */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  let wall = options.now ?? 1_700_000_000_000;
  // Deliberately a different origin from the wall clock: a duration computed by
  // mixing the two would produce an obviously wrong number rather than one that
  // happens to look plausible.
  let mono = 5_000;
  let nextHandle = 1;
  let uuidCounter = 0;

  const timers: RecordedTimer[] = [];
  const cleared: TimerHandle[] = [];

  const register = (kind: 'timeout' | 'interval', fn: () => void, ms: number): TimerHandle => {
    const handle = nextHandle++ as unknown as TimerHandle;
    timers.push({ kind, fn, ms, handle });
    return handle;
  };

  const clear = (handle: TimerHandle): void => {
    cleared.push(handle);
    const index = timers.findIndex((t) => t.handle === handle);
    if (index !== -1) {
      timers.splice(index, 1);
    }
  };

  const runtime: IRuntimeServices = {
    platform: () => options.platform ?? 'deno',
    version: () => '0.0.0-test',
    hostname: () => 'test-host',
    uuid: () => `fake-uuid-${++uuidCounter}`,
    // Exactly `length` bytes, deterministic so a test can assert on the output.
    randomBytes: (length: number) => new Uint8Array(length).map((_v, i) => (i * 31 + 7) % 256),
    subtle: crypto.subtle,
    now: () => wall,
    hrtime: () => mono,
    setTimeout: (fn, ms) => register('timeout', fn, ms),
    clearTimeout: clear,
    setInterval: (fn, ms) => register('interval', fn, ms),
    clearInterval: clear,
    env: options.env ?? {},
    exit: (code?: number): never => {
      throw new Error(`runtime.exit(${code ?? 0}) called in a test`);
    },
  };

  return {
    runtime,
    timers,
    cleared,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    tick: () => {
      for (const timer of [...timers]) {
        if (timer.kind === 'interval') {
          timer.fn();
        }
      }
    },
  };
}
