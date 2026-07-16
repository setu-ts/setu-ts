/**
 * In-memory job registry.
 *
 * Maintains a `Map<name, entry>` tracking scheduled jobs, their
 * configuration, pause state, next fire time, and armed timer handles.
 *
 * @module
 */
import type { RegistryEntry } from '../interfaces/index.ts';

/**
 * Internal job registry.
 */
export class JobRegistry {
  #entries: Map<string, RegistryEntry<unknown>> = new Map();

  /**
   * Add a new job entry.
   *
   * @param entry - The job entry to add
   * @throws {Error} If a job with the same name already exists
   */
  add<T = unknown>(entry: RegistryEntry<T>): void {
    if (this.#entries.has(entry.name)) {
      throw new Error(`Job '${entry.name}' is already scheduled`);
    }
    this.#entries.set(entry.name, entry as RegistryEntry<unknown>);
  }

  /**
   * Get a job entry by name.
   *
   * @param name - The job name
   * @returns The job entry
   * @throws {Error} If no job with `name` exists
   */
  get<T = unknown>(name: string): RegistryEntry<T> {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      throw new Error(`No scheduled job named '${name}'`);
    }
    return entry as RegistryEntry<T>;
  }

  /**
   * Check if a job exists.
   *
   * @param name - The job name
   * @returns `true` if the job exists
   */
  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /**
   * Remove a job entry.
   *
   * @param name - The job name
   * @throws {Error} If no job with `name` exists
   */
  remove(name: string): void {
    if (!this.#entries.has(name)) {
      throw new Error(`No scheduled job named '${name}'`);
    }
    this.#entries.delete(name);
  }

  /**
   * Pause a job (clear timer without dropping configuration).
   *
   * Idempotent — pausing an already-paused job is a no-op.
   *
   * @param name - The job name
   * @param clearTimer - Callback to clear the armed timer
   * @throws {Error} If no job with `name` exists
   */
  pause(name: string, clearTimer: (handle: unknown) => void): void {
    const entry = this.get(name);
    if (!entry.paused) {
      if (entry.timerHandle !== null) {
        clearTimer(entry.timerHandle);
        entry.timerHandle = null;
      }
      entry.paused = true;
    }
  }

  /**
   * Get the next fire time for a job.
   *
   * @param name - The job name
   * @returns Next fire time in epoch ms
   * @throws {Error} If no job with `name` exists or the job is paused
   */
  getNextRun(name: string): number {
    const entry = this.get(name);
    if (entry.paused) {
      throw new Error(`Job '${name}' is paused`);
    }
    return entry.nextRunAtMs;
  }
}
