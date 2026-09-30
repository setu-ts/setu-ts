/**
 * TOTP enrolment, step-claim, lockout, and recovery-code store.
 *
 * The port is async so a remote backend (Redis, a database) can implement it
 * without a breaking change. `MemoryTotpStore` is the default for tests and
 * single-process development.
 *
 * The secret is stored as given (base32); a production store should encrypt it
 * at rest.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';

/** A TOTP enrolment record. */
export interface TotpEnrolment {
  /** The base32 secret (RFC 4648, no padding). */
  readonly secret: string;
  /** The label shown in the authenticator app. */
  readonly label: string;
  /** Whether the enrolment has been confirmed with a valid code. */
  confirmed: boolean;
  /** The last claimed TOTP step; a step must be greater than this to be accepted. */
  lastClaimedStep: number;
}

/** The result of reserving an attempt for lockout purposes. */
export interface ReserveAttemptResult {
  /** Whether the attempt is within the limit. */
  readonly allowed: boolean;
  /** The number of attempts in the current window, including this one. */
  readonly count: number;
}

/**
 * Store port for TOTP enrolment, step claims, lockout, and recovery codes.
 *
 * All methods are async so remote backends can implement the interface without
 * a breaking change.
 */
export interface ITotpStore {
  /**
   * Reads the enrolment for a principal, or `null` when none exists.
   */
  getEnrolment(principalId: string): Promise<TotpEnrolment | null>;

  /**
   * Stores or updates an enrolment.
   */
  saveEnrolment(principalId: string, enrolment: TotpEnrolment): Promise<void>;

  /**
   * Deletes the enrolment for a principal, including any recovery codes
   * and attempt counts.
   */
  deleteEnrolment(principalId: string): Promise<void>;

  /**
   * Atomically claims a TOTP step for a principal.
   *
   * Succeeds only when `step` is greater than the last claimed step, so the
   * same code — and any earlier code — cannot be replayed. Returns `true`
   * when the step was claimed, `false` when it was at or below the last
   * claimed step (replay) or no enrolment exists.
   */
  claimStep(principalId: string, step: number): Promise<boolean>;

  /**
   * Atomically reserves an attempt for lockout.
   *
   * Counts the attempt and answers whether it is within the limit in one
   * operation. Attempts are counted BEFORE the code is checked, not failures
   * after it: a read-the-count-then-record-a-failure pair lets N concurrent
   * guesses all read a count under the limit, so a burst would bypass the
   * lockout.
   *
   * @param principalId - The principal
   * @param now - The current wall-clock time in milliseconds
   * @param options - The limit and window
   */
  reserveAttempt(
    principalId: string,
    now: number,
    options: { readonly limit: number; readonly windowMs: number },
  ): Promise<ReserveAttemptResult>;

  /**
   * Clears the attempt count for a principal (called on successful verification).
   */
  clearAttempts(principalId: string): Promise<void>;

  /**
   * Stores recovery codes for a principal, replacing any existing set.
   *
   * Codes are stored as SHA-256 digests (hex), not plaintext.
   *
   * @param principalId - The principal
   * @param digests - The SHA-256 hex digests of the recovery codes
   */
  saveRecoveryCodes(principalId: string, digests: readonly string[]): Promise<void>;

  /**
   * Atomically consumes a recovery code by its SHA-256 digest.
   *
   * Finds the index matching `digest` and marks it consumed in one operation,
   * so two concurrent uses of the same code cannot both succeed. Returns
   * `true` when the code was consumed, `false` when no matching digest exists
   * or it was already consumed.
   *
   * @param principalId - The principal
   * @param digest - The SHA-256 hex digest of the recovery code
   */
  consumeRecoveryCode(principalId: string, digest: string): Promise<boolean>;
}

/** Attempt tracking for the memory store. */
interface MemoryAttempts {
  /** The timestamps of attempts in the current window. */
  timestamps: number[];
}

/** Recovery code tracking for the memory store. */
interface MemoryRecoveryCodes {
  /** The SHA-256 hex digests of the recovery codes. */
  digests: string[];
  /** Which indices have been consumed. */
  consumed: boolean[];
}

/**
 * In-memory implementation of {@linkcode ITotpStore}.
 *
 * For tests and single-process development. All operations are synchronous
 * internally but exposed through the async port so a remote backend can be
 * substituted without a breaking change.
 */
export class MemoryTotpStore implements ITotpStore {
  #enrolments = new Map<string, TotpEnrolment>();
  #attempts = new Map<string, MemoryAttempts>();
  #recoveryCodes = new Map<string, MemoryRecoveryCodes>();

  /**
   * @param _runtime - Runtime services (present for interface symmetry; the
   *   memory store does not need a clock because callers pass `now` to
   *   `reserveAttempt`).
   */
  constructor(_runtime: IRuntimeServices) {
    // Intentionally unused.
  }

  getEnrolment(principalId: string): Promise<TotpEnrolment | null> {
    const record = this.#enrolments.get(principalId);
    if (record === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...record });
  }

  saveEnrolment(principalId: string, enrolment: TotpEnrolment): Promise<void> {
    this.#enrolments.set(principalId, { ...enrolment });
    return Promise.resolve();
  }

  deleteEnrolment(principalId: string): Promise<void> {
    this.#enrolments.delete(principalId);
    this.#attempts.delete(principalId);
    this.#recoveryCodes.delete(principalId);
    return Promise.resolve();
  }

  claimStep(principalId: string, step: number): Promise<boolean> {
    const record = this.#enrolments.get(principalId);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    if (step <= record.lastClaimedStep) {
      return Promise.resolve(false);
    }
    record.lastClaimedStep = step;
    return Promise.resolve(true);
  }

  reserveAttempt(
    principalId: string,
    now: number,
    options: { readonly limit: number; readonly windowMs: number },
  ): Promise<ReserveAttemptResult> {
    let attempts = this.#attempts.get(principalId);
    if (attempts === undefined) {
      attempts = { timestamps: [] };
      this.#attempts.set(principalId, attempts);
    }
    const cutoff = now - options.windowMs;
    attempts.timestamps = attempts.timestamps.filter((ts) => ts > cutoff);
    attempts.timestamps.push(now);
    const count = attempts.timestamps.length;
    return Promise.resolve({ allowed: count <= options.limit, count });
  }

  clearAttempts(principalId: string): Promise<void> {
    this.#attempts.delete(principalId);
    return Promise.resolve();
  }

  saveRecoveryCodes(principalId: string, digests: readonly string[]): Promise<void> {
    this.#recoveryCodes.set(principalId, {
      digests: [...digests],
      consumed: new Array(digests.length).fill(false),
    });
    return Promise.resolve();
  }

  consumeRecoveryCode(principalId: string, digest: string): Promise<boolean> {
    const record = this.#recoveryCodes.get(principalId);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    const index = record.digests.indexOf(digest);
    if (index === -1) {
      return Promise.resolve(false);
    }
    if (record.consumed[index]) {
      return Promise.resolve(false);
    }
    record.consumed[index] = true;
    return Promise.resolve(true);
  }
}
