/**
 * Internal queue adapter interface.
 *
 * This is the transport seam that QueueService uses to delegate storage.
 * It is intentionally NOT barrel-exported.
 *
 * @module
 */

import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';

/**
 * How many jobs are in each of one name's states.
 *
 * @since 0.3.0
 */
export interface QueueDepths {
  /** Jobs available to be reserved now or later. */
  readonly ready: number;
  /** Jobs reserved and being processed. */
  readonly processing: number;
  /** Jobs that exhausted their attempts and were dead-lettered. */
  readonly dead: number;
}

/**
 * Internal queue adapter interface.
 *
 * Provides the minimal storage primitives for a delayed-job queue.
 * Mirrors the MessageBrokerAdapter pattern from messaging-plugin.
 *
 * @since 0.1.0
 */
export interface QueueAdapter {
  /**
   * Connects the adapter to its backend.
   *
   * @returns Resolves when connected
   * @since 0.1.0
   */
  connect(): Promise<void>;

  /**
   * Disconnects the adapter.
   *
   * @returns Resolves when disconnected
   * @since 0.1.0
   */
  disconnect(): Promise<void>;

  /**
   * Checks if the adapter is ready/connected.
   *
   * @returns `true` if connected
   * @since 0.1.0
   */
  isReady(): boolean;

  /**
   * M70c: reports whether the adapter's backend is reachable right now, for
   * the service's health indicator.
   *
   * Optional: an adapter with no meaningful liveness check omits it, and the
   * indicator then reports only the lifecycle state (`isReady`). This answers a
   * fact (reachability), not a policy: the indicator owns the `up`/`down`
   * mapping.
   *
   * @returns `true` when the backend is reachable
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;

  /**
   * M70k (X8-4): reports how many jobs are sitting in each of this name's three
   * states, for the service's health indicator.
   *
   * Optional, and its ABSENCE is reported rather than substituted with zeros:
   * "this adapter cannot tell you" and "there is nothing there" are different
   * answers, and an operator acting on a dead-letter alert needs to know which
   * one they have. Implemented where the count is one cheap call (memory,
   * redis `zcard`) and omitted where it needs a management API or
   * `GetQueueAttributes` — that cost belongs to whoever needs it.
   *
   * This is the durable view the counters cannot give: `queue_jobs_total` is
   * per-process and resets on restart, so a restarted replica would report zero
   * dead letters while the backend still held them.
   *
   * @param name - Job name
   * @returns The depth of each state
   * @since 0.3.0
   */
  depths?(name: string): Promise<QueueDepths>;

  /**
   * Enqueues a job.
   *
   * @param job - The job to enqueue
   * @returns Resolves when enqueued
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  enqueue<T>(job: StoredJob<T>): Promise<void>;

  /**
   * Reserves up to `limit` jobs that are due (availableAtMs <= nowMs).
   *
   * CLAIMS jobs: moves them from ready set to processing set.
   * A reserved job is not returned by subsequent reserve calls.
   *
   * @param name - Job name
   * @param limit - Maximum jobs to reserve
   * @param nowMs - Current timestamp in ms
   * @returns The reserved jobs
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  reserve<T>(name: string, limit: number, nowMs: number): Promise<readonly StoredJob<T>[]>;

  /**
   * Acknowledges a job as successfully processed.
   *
   * @param name - Job name
   * @param id - Job ID (stable public identity)
   * @param claimToken - Opaque claim token returned from reserve (prevents stale settlement)
   * @returns Resolves when acknowledged
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  ack(name: string, id: string, claimToken: string): Promise<void>;

  /**
   * Requeues a job with a new available timestamp.
   *
   * @param name - Job name
   * @param id - Job ID (stable public identity)
   * @param availableAtMs - When the job becomes available again
   * @param attempts - Updated attempt count
   * @param claimToken - Opaque claim token returned from reserve (prevents stale settlement)
   * @returns Resolves when requeued
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  requeue(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
    claimToken: string,
  ): Promise<void>;

  /**
   * Moves a job to the dead letter queue.
   *
   * @param name - Job name
   * @param id - Job ID (stable public identity)
   * @param nowMs - Current timestamp in ms (for dead-letter timestamp)
   * @param claimToken - Opaque claim token returned from reserve (prevents stale settlement)
   * @returns Resolves when dead-lettered
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  deadLetter(name: string, id: string, nowMs: number, claimToken: string): Promise<void>;

  /**
   * Stores a recurring job.
   *
   * @param rec - The recurring job to store
   * @returns Resolves when stored
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  storeRecurring(rec: StoredRecurring): Promise<void>;

  /**
   * Fetches recurring jobs that are due.
   *
   * @param nowMs - Current timestamp in ms
   * @returns The due recurring jobs
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  fetchRecurringDue(nowMs: number): Promise<readonly StoredRecurring[]>;

  /**
   * Advances a recurring job's next run time.
   *
   * @param id - Recurring job ID
   * @param nextRunAtMs - Next run timestamp
   * @returns Resolves when advanced
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  advanceRecurring(id: string, nextRunAtMs: number): Promise<void>;
}
