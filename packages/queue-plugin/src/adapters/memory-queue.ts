/**
 * In-memory queue adapter implementation.
 *
 * Uses in-process Maps and arrays for testing and local development.
 *
 * @module
 */

import type { QueueAdapter } from './queue-adapter.ts';
import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';

/**
 * In-memory queue adapter implementation.
 *
 * Provides a simple, synchronous-in-practice implementation using
 * in-process data structures. All methods are wrapped in Promises
 * to match the async adapter interface.
 *
 * @since 0.1.0
 */
export class MemoryQueue implements QueueAdapter {
  #connected = false;
  // Per-name: ready jobs sorted by availableAtMs
  #ready: Map<string, StoredJob[]>;
  // Per-name: processing jobs (reserved but not acked/dead-lettered)
  #processing: Map<string, Map<string, StoredJob>>;
  // Per-name: dead-lettered jobs
  #dead: Map<string, StoredJob[]>;
  // Per-name: jobs hash (id -> StoredJob)
  #jobs: Map<string, Map<string, StoredJob>>;
  // Recurring jobs
  #recurringDue: StoredRecurring[];
  #recurringJobs: Map<string, StoredRecurring>;

  constructor() {
    this.#ready = new Map();
    this.#processing = new Map();
    this.#dead = new Map();
    this.#jobs = new Map();
    this.#recurringDue = [];
    this.#recurringJobs = new Map();
  }

  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    this.#ready = new Map();
    this.#processing = new Map();
    this.#dead = new Map();
    this.#jobs = new Map();
    this.#recurringDue = [];
    this.#recurringJobs = new Map();
    this.#connected = true;
  }

  // deno-lint-ignore require-await
  async disconnect(): Promise<void> {
    this.#ready = new Map();
    this.#processing = new Map();
    this.#dead = new Map();
    this.#jobs = new Map();
    this.#recurringDue = [];
    this.#recurringJobs = new Map();
    this.#connected = false;
  }

  isReady(): boolean {
    return this.#connected;
  }

  // deno-lint-ignore require-await
  async enqueue<T>(job: StoredJob<T>): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const jobs = this.#getOrCreateJobsMap(job.name);
    jobs.set(job.id, { ...job });

    const ready = this.#getOrCreateReady(job.name);
    ready.push({ ...job });
    // Sort by availableAtMs
    ready.sort((a, b) => a.availableAtMs - b.availableAtMs);
  }

  // deno-lint-ignore require-await
  async reserve<T>(name: string, limit: number, nowMs: number): Promise<readonly StoredJob<T>[]> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const ready = this.#getOrCreateReady(name);
    const processing = this.#getOrCreateProcessing(name);

    // Find due jobs and move them to processing
    const due: StoredJob<T>[] = [];
    const remaining: StoredJob<T>[] = [];

    for (const job of ready) {
      if (job.availableAtMs <= nowMs && due.length < limit) {
        due.push(job as StoredJob<T>);
        processing.set(job.id, { ...job });
      } else {
        remaining.push(job as StoredJob<T>);
      }
    }

    // Update ready list
    this.#setReady(name, remaining);

    return due as readonly StoredJob<T>[];
  }

  // deno-lint-ignore require-await
  async ack(name: string, id: string): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const processing = this.#getOrCreateProcessing(name);
    processing.delete(id);
  }

  // deno-lint-ignore require-await
  async requeue<T>(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
  ): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const processing = this.#getOrCreateProcessing(name);
    const job = processing.get(id);

    if (!job) {
      return;
    }

    processing.delete(id);

    // Update job
    const updated = { ...job, availableAtMs, attempts } as StoredJob<T>;

    const jobs = this.#getOrCreateJobsMap(name);
    jobs.set(id, updated);

    const ready = this.#getOrCreateReady(name);
    ready.push(updated);
    ready.sort((a, b) => a.availableAtMs - b.availableAtMs);
  }

  // deno-lint-ignore require-await
  async deadLetter(name: string, id: string, _nowMs: number): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const processing = this.#getOrCreateProcessing(name);
    const job = processing.get(id);

    if (!job) {
      return;
    }

    processing.delete(id);

    const dead = this.#getOrCreateDead(name);
    dead.push({ ...job });
  }

  // deno-lint-ignore require-await
  async storeRecurring(rec: StoredRecurring): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    this.#recurringJobs.set(rec.id, { ...rec });
    this.#recurringDue.push({ ...rec });
    this.#recurringDue.sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);
  }

  // deno-lint-ignore require-await
  async fetchRecurringDue(nowMs: number): Promise<readonly StoredRecurring[]> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    return this.#recurringDue.filter((r) => r.nextRunAtMs <= nowMs);
  }

  // deno-lint-ignore require-await
  async advanceRecurring(id: string, nextRunAtMs: number): Promise<void> {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }

    const rec = this.#recurringJobs.get(id);
    if (!rec) {
      return;
    }

    // Update nextRunAtMs
    const updated: StoredRecurring = { ...rec, nextRunAtMs };
    this.#recurringJobs.set(id, updated);

    // Update in due list
    const idx = this.#recurringDue.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.#recurringDue[idx] = updated;
      this.#recurringDue.sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);
    }
  }

  /**
   * Get dead-lettered jobs for a given queue name (for testing/observability).
   */
  getDeadLetters<T>(name: string): readonly StoredJob<T>[] {
    if (!this.#connected) {
      throw new Error('MemoryQueue is not connected');
    }
    const dead = this.#getOrCreateDead(name);
    return [...dead] as readonly StoredJob<T>[];
  }

  #getOrCreateReady(name: string): StoredJob[] {
    if (!this.#ready.has(name)) {
      this.#ready.set(name, []);
    }
    return this.#ready.get(name)!;
  }

  #setReady(name: string, jobs: StoredJob[]): void {
    this.#ready.set(name, jobs);
  }

  #getOrCreateProcessing(name: string): Map<string, StoredJob> {
    if (!this.#processing.has(name)) {
      this.#processing.set(name, new Map());
    }
    return this.#processing.get(name)!;
  }

  #getOrCreateDead(name: string): StoredJob[] {
    if (!this.#dead.has(name)) {
      this.#dead.set(name, []);
    }
    return this.#dead.get(name)!;
  }

  #getOrCreateJobsMap(name: string): Map<string, StoredJob> {
    if (!this.#jobs.has(name)) {
      this.#jobs.set(name, new Map());
    }
    return this.#jobs.get(name)!;
  }
}
