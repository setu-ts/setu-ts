/**
 * Reconnect supervisor for the self-managed brokers.
 *
 * @module
 *
 * Internal to `messaging-plugin` — NOT barrel-exported. Brokers that own their
 * connection lifecycle use this to turn a broker blip into a self-repair
 * rather than a permanent outage, and to keep `isHealthy` truthful during the
 * outage window.
 *
 * Two modes, decided by the probed behaviour of each client (M70c §1/§3.5):
 *
 * - **`drive`** (RabbitMQ only): amqplib has no reconnect of any kind, so the
 *   supervisor reconnects on the fault event, re-asserts broker-level state
 *   (the exchange), and replays every active subscription.
 * - **`observe`** (redis-streams, nats, kafka): the client reconnects itself.
 *   The supervisor only tracks the fault/recovery events so `isHealthy` is
 *   truthful during the window. It does NOT replay — those clients restore
 *   their own subscriptions (kafkajs restores its consumer group, ioredis's
 *   poll loop resumes, NATS re-establishes JetStream bindings after
 *   `Events.Reconnect`).
 *
 * Backoff is full-jitter exponential (`initialMs` 500, `maxMs` 30_000,
 * unbounded attempts), driven by `IRuntimeServices.setTimeout`. Unbounded
 * because a broker outage longer than any attempt cap is exactly the case that
 * must still self-repair; the health signal reports `down` throughout, so an
 * orchestrator can act in parallel.
 *
 * `stop()` cancels a pending attempt and removes **every** listener the
 * supervisor attached — the listener-accumulation class M47 fixed in
 * `resilience-plugin` and M50's review found twice in watch backoffs.
 *
 * @since 0.1.0
 */
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';

/**
 * Supervisor mode.
 *
 * @since 0.1.0
 */
export type ReconnectMode = 'drive' | 'observe';

/**
 * Options for {@linkcode ReconnectSupervisor}.
 *
 * @since 0.1.0
 */
export interface ReconnectSupervisorOptions {
  /** Runtime services providing the monotonic timer surface. */
  readonly runtime: IRuntimeServices;
  /** `drive` reconnects; `observe` only tracks fault/recovery. */
  readonly mode: ReconnectMode;
  /**
   * (drive) Re-establish the connection and channel. Called on each attempt.
   */
  readonly reconnect?: () => Promise<void>;
  /**
   * (drive) Re-assert broker-level state (e.g. the exchange) after a
   * successful reconnect.
   */
  readonly reassert?: () => Promise<void>;
  /**
   * (drive) Replay every active subscription after a successful reconnect.
   */
  readonly replay?: () => Promise<void>;
  /**
   * Register a fault listener on the current connection and return a
   * disposer that removes it. The supervisor calls this on {@linkcode start}
   * and, in drive mode, after each successful reconnect (the connection is
   * recreated), and calls the returned disposer when re-attaching or
   * tearing down.
   */
  readonly attachFaultListener: (onFault: () => void) => () => void;
  /**
   * (observe) Register a recovery listener and return a disposer that
   * removes it.
   */
  readonly attachRecoveryListener?: (onRecovered: () => void) => () => void;
  /** First backoff window, in milliseconds. @default 500 */
  readonly initialMs?: number;
  /** Backoff ceiling, in milliseconds. @default 30000 */
  readonly maxMs?: number;
}

/**
 * Full-jitter exponential backoff delay.
 *
 * Returns a uniformly random value in `[0, min(maxMs, initialMs * 2^attempt)]`
 * (AWS's "full jitter"). Exported for unit testing the bounds; the supervisor
 * is the only in-repo caller.
 *
 * @param attempt - Zero-based attempt index
 * @param initialMs - First backoff window
 * @param maxMs - Backoff ceiling
 * @returns The delay to wait before the next attempt, in milliseconds
 * @since 0.1.0
 */
export function fullJitterDelay(attempt: number, initialMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** attempt);
  return Math.floor(Math.random() * (ceiling + 1));
}

/**
 * Owns backoff, the reconnect attempt loop (drive mode), and fault/recovery
 * tracking (both modes) for a broker's connection.
 *
 * @since 0.1.0
 */
export class ReconnectSupervisor {
  #faulted = false;
  #running = false;
  #stopping = false;
  #pending: TimerHandle | null = null;
  #disposers: Array<() => void> = [];
  #options: ReconnectSupervisorOptions;

  /**
   * Creates a supervisor.
   *
   * @param options - Mode, callbacks, timer surface and backoff windows
   * @throws {Error} When `mode` is `'drive'` but `reconnect`/`replay` are missing
   */
  constructor(options: ReconnectSupervisorOptions) {
    if (options.mode === 'drive' && (!options.reconnect || !options.replay)) {
      throw new Error('ReconnectSupervisor drive mode requires reconnect and replay');
    }
    this.#options = options;
  }

  /**
   * Whether the broker is currently in a fault window (unreachable).
   *
   * @returns `true` while a fault is active and recovery has not been observed
   */
  get faulted(): boolean {
    return this.#faulted;
  }

  /**
   * Arms the supervisor: attaches the fault (and, in observe mode, recovery)
   * listeners. Called from the broker's `connect()`.
   */
  start(): void {
    if (this.#running || this.#stopping) {
      return;
    }
    this.#running = true;
    this.#attachListeners();
  }

  /**
   * Reports a fault (error/close/disconnect event). In drive mode this starts
   * the reconnect attempt loop; in observe mode it only marks the fault so
   * `isHealthy` is truthful while the client self-heals.
   */
  fault(): void {
    if (this.#stopping || !this.#running) {
      return;
    }
    // One attempt loop per fault window. A client may report the same loss
    // through more than one event — amqplib's `onSocketError` emits `'error'`
    // and then `'close'`, and both are wired to this method — and without
    // this guard each would start its own reconnect loop, so a single outage
    // would open two connections, orphan one of them (the second's
    // `#reconnect()` replaces `#connection` after the first already stored
    // it, and nothing ever closes the loser), and register a duplicate
    // consumer per active subscription.
    if (this.#faulted) {
      return;
    }
    this.#faulted = true;
    if (this.#options.mode === 'drive') {
      this.#scheduleAttempt(0);
    }
  }

  /**
   * Reports recovery (reconnect/connect event). Clears the fault and any
   * pending drive-mode attempt.
   */
  recovered(): void {
    if (this.#stopping) {
      return;
    }
    this.#faulted = false;
    this.#cancelPending();
  }

  /**
   * Tears down: cancels a pending attempt and removes every attached
   * listener. Called from the broker's `disconnect()`.
   */
  stop(): void {
    this.#stopping = true;
    this.#running = false;
    this.#faulted = false;
    this.#cancelPending();
    this.#detachListeners();
  }

  #attachListeners(): void {
    const disposeFault = this.#options.attachFaultListener(() => this.fault());
    this.#disposers.push(disposeFault);
    if (this.#options.attachRecoveryListener) {
      const disposeRecovery = this.#options.attachRecoveryListener(() => this.recovered());
      this.#disposers.push(disposeRecovery);
    }
  }

  #detachListeners(): void {
    for (const dispose of this.#disposers) {
      dispose();
    }
    this.#disposers = [];
  }

  #reattachListeners(): void {
    this.#detachListeners();
    this.#attachListeners();
  }

  #scheduleAttempt(attempt: number): void {
    if (this.#stopping) {
      return;
    }
    // Never overwrite a live handle: the field tracks one timer, so replacing
    // it without cancelling would leak the previous timer and fire two
    // attempts.
    this.#cancelPending();
    const initialMs = this.#options.initialMs ?? 500;
    const maxMs = this.#options.maxMs ?? 30_000;
    const delay = fullJitterDelay(attempt, initialMs, maxMs);
    this.#pending = this.#options.runtime.setTimeout(() => {
      this.#pending = null;
      void this.#attempt(attempt);
    }, delay);
  }

  #cancelPending(): void {
    if (this.#pending !== null) {
      this.#options.runtime.clearTimeout(this.#pending);
      this.#pending = null;
    }
  }

  async #attempt(attempt: number): Promise<void> {
    if (this.#stopping) {
      return;
    }
    try {
      await this.#options.reconnect?.();
      if (this.#options.reassert) {
        await this.#options.reassert();
      }
      await this.#options.replay?.();
      // Success: clear the fault and re-attach listeners to the new connection.
      this.#faulted = false;
      this.#reattachListeners();
    } catch {
      // Failure: retry with backoff. Unbounded — a long outage must still
      // self-repair, and the health signal reports `down` throughout.
      this.#scheduleAttempt(attempt + 1);
    }
  }
}
