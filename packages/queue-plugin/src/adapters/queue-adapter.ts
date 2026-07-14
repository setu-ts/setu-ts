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
   * @param id - Job ID
   * @returns Resolves when acknowledged
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  ack(name: string, id: string): Promise<void>;

  /**
   * Requeues a job with a new available timestamp.
   *
   * @param name - Job name
   * @param id - Job ID
   * @param availableAtMs - When the job becomes available again
   * @param attempts - Updated attempt count
   * @returns Resolves when requeued
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  requeue(name: string, id: string, availableAtMs: number, attempts: number): Promise<void>;

  /**
   * Moves a job to the dead letter queue.
   *
   * @param name - Job name
   * @param id - Job ID
   * @param nowMs - Current timestamp in ms (for dead-letter timestamp)
   * @returns Resolves when dead-lettered
   * @throws {Error} If the adapter is not connected
   * @since 0.1.0
   */
  deadLetter(name: string, id: string, nowMs: number): Promise<void>;

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
