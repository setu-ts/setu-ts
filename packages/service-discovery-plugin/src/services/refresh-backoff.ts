/** Per-name retry spacing after a failed discovery refresh. @module */
export class RefreshBackoff {
  readonly #states = new Map<string, { delayMs: number; retryAt: number }>();
  readonly #now: () => number;
  constructor(now: () => number) {
    this.#now = now;
  }

  /** Whether another refresh may start for this name. */
  ready(name: string): boolean {
    const state = this.#states.get(name);
    return state === undefined || this.#now() >= state.retryAt;
  }

  /** Space failures by 1, 2, 4, 8, 16, then 30 seconds. */
  failed(name: string): void {
    const delayMs = Math.min((this.#states.get(name)?.delayMs ?? 500) * 2, 30_000);
    this.#states.set(name, { delayMs, retryAt: this.#now() + delayMs });
  }

  /** A successful answer starts a fresh failure run. */
  reset(name: string): void {
    this.#states.delete(name);
  }

  /** Drop all names at shutdown. */
  clear(): void {
    this.#states.clear();
  }
}
