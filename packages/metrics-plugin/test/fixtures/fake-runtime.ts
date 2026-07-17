/**
 * Fake IRuntimeServices for deterministic testing.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform, TimerHandle } from '@hono-enterprise/common';

/**
 * A fake runtime that lets tests control the clock.
 */
export class FakeRuntime implements IRuntimeServices {
  #time = 1_700_000_000_000;

  #timers: Map<number, { fn: () => void; delay: number; interval: boolean }> = new Map();
  #nextId = 1;
  #uuidCount = 0;
  #env: Readonly<Record<string, string | undefined>>;

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
    this.#uuidCount++;
    return `test-uuid-${this.#uuidCount}`;
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }

  get subtle(): SubtleCrypto {
    throw new Error('SubtleCrypto not implemented in FakeRuntime');
  }

  now(): number {
    return this.#time;
  }

  hrtime(): number {
    return this.#time;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { fn, delay: ms, interval: true });
    return id as TimerHandle;
  }

  clearInterval(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { fn, delay: ms, interval: false });
    return id as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.#env;
  }

  exit(code?: number): never {
    throw new Error(`exit(${code ?? 0}) called in FakeRuntime`);
  }

  /**
   * Advance the fake clock by the given ms.
   *
   * @param ms - Milliseconds to advance
   */
  advance(ms: number): void {
    this.#time += ms;
  }

  /**
   * Resets the clock to the initial value.
   */
  reset(): void {
    this.#time = 1_700_000_000_000;
    this.#nextId = 1;
    this.#uuidCount = 0;
    this.#timers.clear();
  }
}
