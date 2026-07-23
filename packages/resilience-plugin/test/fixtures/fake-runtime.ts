/**
 * Fake `IRuntimeServices` for deterministic resilience tests.
 *
 * The monotonic clock (`hrtime`) is controlled independently via
 * {@linkcode FakeRuntime.advanceClock}, so a test can age circuit-breaker
 * failure windows and reset cooldowns precisely. Timers back onto the real
 * macrotask queue (delay compressed to fire promptly) while RECORDING each
 * armed delay in {@linkcode FakeRuntime.armedDelays}, so retry backoff and
 * timeout durations are asserted by value without real-time waits. This honors
 * the real runtime contract — a one-shot callback that eventually fires and is
 * cancellable via `clearTimeout` — while staying deterministic.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform, TimerHandle } from '@hono-enterprise/common';

/** A fake runtime controlling the monotonic clock and recording timer delays. */
export class FakeRuntime implements IRuntimeServices {
  /** Controlled monotonic clock (ms). */
  #hr = 0;
  /** Controlled epoch clock (ms). */
  #wall = 1_700_000_000_000;
  /** Next synthetic timer id. */
  #nextId = 1;
  /** Synthetic id → real timer handle. */
  #handles: Map<number, ReturnType<typeof setTimeout>> = new Map();

  /** Every delay (ms) passed to `setTimeout`, in call order. */
  readonly armedDelays: number[] = [];

  /** Controlled environment variables. */
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>> = {}) {
    this.#env = env;
  }

  platform(): RuntimePlatform {
    return 'deno';
  }

  version(): string {
    return '2.0.0';
  }

  hostname(): string {
    return 'test-host';
  }

  uuid(): string {
    return `test-uuid-${this.#nextId++}`;
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }

  get subtle(): SubtleCrypto {
    throw new Error('SubtleCrypto not implemented in FakeRuntime');
  }

  now(): number {
    return this.#wall;
  }

  hrtime(): number {
    return this.#hr;
  }

  /**
   * Advances the monotonic clock (and wall clock) by `ms`.
   *
   * @param ms - Milliseconds to advance
   */
  advanceClock(ms: number): void {
    this.#hr += ms;
    this.#wall += ms;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.armedDelays.push(ms);
    const id = this.#nextId++;
    // Compress the delay onto the real macrotask queue so the callback fires
    // promptly and deterministically; the asserted duration is `armedDelays`.
    const handle = setTimeout(() => {
      this.#handles.delete(id);
      fn();
    }, 0);
    this.#handles.set(id, handle);
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    const id = handle as number;
    const real = this.#handles.get(id);
    if (real !== undefined) {
      clearTimeout(real);
      this.#handles.delete(id);
    }
  }

  setInterval(_fn: () => void, _ms: number): TimerHandle {
    throw new Error('setInterval not used by the resilience plugin');
  }

  clearInterval(_handle: TimerHandle): void {
    throw new Error('clearInterval not used by the resilience plugin');
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.#env;
  }

  exit(code?: number): never {
    throw new Error(`FakeRuntime.exit(${code ?? 0})`);
  }
}
